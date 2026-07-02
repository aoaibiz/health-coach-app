"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { useWorkout } from "@/components/workout/useWorkout";
import { useProfile } from "@/components/profile/useProfile";
import { FlameIcon } from "@/components/icons";
import { toDateKey, makeId } from "@/lib/date";
import { exerciseBurn } from "@/lib/burn";
import type { Exercise } from "@/lib/types";
import {
  trackStats,
  avgSpeedKmh,
  paceMinPerKm,
  formatKm,
  CARDIO_ACTIVITIES,
  type GeoPoint,
  type CardioKind,
} from "@/lib/cardioTracking";

type Phase = "idle" | "tracking" | "done";

export default function CardioPage() {
  const router = useRouter();
  const today = toDateKey();
  const { addExercise } = useWorkout(today);
  const { profile } = useProfile();

  const [phase, setPhase] = useState<Phase>("idle");
  const [points, setPoints] = useState<GeoPoint[]>([]);
  // The activity is a STICKY user choice (default walk). It never auto-changes —
  // the user picks 歩き/ラン/自転車 and it stays (fixes the "run flipped to walk").
  const [selected, setSelected] = useState<CardioKind>("walk");
  const [error, setError] = useState<string>("");
  const [, setTick] = useState<number>(0); // re-render each second while tracking
  const [saved, setSaved] = useState(false);

  const watchId = useRef<number | null>(null);
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  // Time is measured by the WALL CLOCK from the スタート press — never from GPS
  // point timestamps (which can jump). startMs is set on start, endMs on stop.
  const startMs = useRef<number>(0);
  const [endMs, setEndMs] = useState<number | null>(null);

  // --- live numbers ---
  const elapsedSec =
    phase === "idle" || startMs.current === 0
      ? 0
      : Math.max(0, ((endMs ?? Date.now()) - startMs.current) / 1000);
  // Pace + average speed are computed over MOVING time (movingSec), NOT the
  // wall-clock elapsed: standing still adds idle seconds but no distance, so an
  // elapsed-based pace would climb (degrade) while stopped. Over movingSec they
  // FREEZE at the moving average instead. The mm:ss timer and the calorie burn
  // keep using elapsedSec (the real session duration).
  const { distanceM, movingSec } = trackStats(points);
  const speed = avgSpeedKmh(distanceM, movingSec);
  const activity = CARDIO_ACTIVITIES[selected];
  const durationMinExact = elapsedSec / 60;
  const weightKg = profile?.weightKg ?? 0;
  // Savable once a REAL distance is recorded (≥10 m). Sitting still → ~0 m → the
  // save is (correctly) unavailable; we tell the user why instead of a dead button.
  const canSave = distanceM >= 10;

  // Calorie preview via the EXISTING burn model (MET × 体重 × 時間). burn.ts resolves
  // the MET from the activity name (ランニング/ウォーキング/サイクリング); we never invent it.
  const kcal =
    weightKg > 0 && elapsedSec > 0
      ? exerciseBurn(
          {
            id: "preview",
            name: activity.name,
            sets: 1,
            reps: 0,
            weight: 0,
            durationMin: Math.max(0.1, durationMinExact),
            intensity: "moderate",
          },
          weightKg,
        ).caloriesBurned
      : null;

  function releaseWake() {
    wakeLock.current?.release().catch(() => {});
    wakeLock.current = null;
  }
  function stopWatch() {
    if (watchId.current != null && typeof navigator !== "undefined") {
      navigator.geolocation.clearWatch(watchId.current);
    }
    watchId.current = null;
  }

  useEffect(() => {
    if (phase !== "tracking") return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  useEffect(() => {
    return () => {
      stopWatch();
      releaseWake();
    };
  }, []);

  async function start() {
    setError("");
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("この端末では位置情報が使えません。");
      return;
    }
    setPoints([]);
    setSaved(false);
    setEndMs(null);
    startMs.current = Date.now();
    setPhase("tracking");
    try {
      wakeLock.current = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      /* not supported / denied — tracking still works while the screen is on */
    }
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        setPoints((prev) => [
          ...prev,
          {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            t: pos.timestamp,
            accuracy: pos.coords.accuracy,
            speed: pos.coords.speed, // m/s, or null — the movement gate
          },
        ]);
      },
      (err) => {
        setError(
          err.code === err.PERMISSION_DENIED
            ? "位置情報の許可が必要です。ブラウザの許可をオンにしてください。"
            : "位置情報が取得できませんでした。空が見える場所で再試行してください。",
        );
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
  }

  function stop() {
    stopWatch();
    releaseWake();
    setEndMs(Date.now());
    setPhase("done");
  }

  function save() {
    if (!canSave) return;
    const exercise: Exercise = {
      id: makeId(),
      name: `${activity.name} ${formatKm(distanceM)}`,
      sets: 1,
      reps: 0,
      weight: 0,
      // Store the REAL elapsed minutes (1-dp) so short sessions log honestly and
      // the calorie burn matches the time actually spent.
      durationMin: Math.max(0.1, Math.round(durationMinExact * 10) / 10),
      intensity: "moderate",
    };
    addExercise(exercise);
    setSaved(true);
  }

  function reset() {
    setPhase("idle");
    setPoints([]);
    setError("");
    setSaved(false);
    setEndMs(null);
    startMs.current = 0;
  }

  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
  const ss = String(Math.floor(elapsedSec % 60)).padStart(2, "0");
  const tracking = phase === "tracking";

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-xl space-y-4 pb-8">
        {/* Page identity — 有酸素 = energy orange (service colour), matching the
            消費/burn hue used across the app. */}
        <header className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-orange-100 text-orange-500 dark:bg-orange-400/15 dark:text-orange-300">
            <FlameIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-bold tracking-tight">有酸素運動</h1>
            <p className="text-xs text-slate-500 dark:text-navy-300">
              GPSで距離と時間を自動計測します
            </p>
          </div>
        </header>

        {error && (
          <div className="animate-fade-in rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-300">
            {error}
          </div>
        )}

        {/* HERO — the live session card: big timer + distance + status. */}
        <section className="surface relative overflow-hidden p-5 text-center">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-16 -top-16 h-44 w-44 rounded-full bg-orange-400/10 blur-3xl"
          />

          {/* Status badge: 計測中 pulses while tracking. */}
          <div className="relative mb-3 flex items-center justify-center">
            {tracking ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-orange-100 px-3 py-1 text-xs font-bold text-orange-600 dark:bg-orange-400/15 dark:text-orange-300">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-orange-500" />
                </span>
                計測中
              </span>
            ) : phase === "done" ? (
              <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-500 dark:bg-navy-800 dark:text-navy-200">
                計測終了
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-400 dark:bg-navy-800 dark:text-navy-300">
                スタート待ち
              </span>
            )}
          </div>

          {/* Big timer + distance */}
          <p className="relative text-5xl font-bold tabular-nums tracking-tight text-slate-900 dark:text-navy-50">
            {mm}
            <span className={tracking ? "animate-pulse" : ""}>:</span>
            {ss}
          </p>
          <p className="relative mt-1.5 text-lg font-semibold tabular-nums text-orange-500 dark:text-orange-300">
            {formatKm(distanceM)}
          </p>

          {/* Session stats */}
          <div className="relative mt-4 grid grid-cols-3 gap-2">
            <Stat label="ペース" value={paceMinPerKm(distanceM, movingSec) || "—"} />
            <Stat label="今の速さ" value={tracking ? `${speed.toFixed(1)} km/h` : "—"} />
            <Stat label="消費(推定)" value={kcal != null ? `${kcal} kcal` : "体重未設定"} />
          </div>

          {tracking && (
            <p className="relative mt-2.5 text-[11px] leading-relaxed text-slate-400 dark:text-navy-400">
              止まっている間は距離は増えません
            </p>
          )}
        </section>

        {/* Activity = sticky choice (does NOT auto-change) */}
        <section className="surface p-4">
          <p className="mb-2 text-xs font-semibold text-slate-500 dark:text-navy-300">
            種目（選んだら固定。途中で変えたい時だけタップ）
          </p>
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(CARDIO_ACTIVITIES) as CardioKind[]).map((k) => {
              const a = CARDIO_ACTIVITIES[k];
              const active = selected === k;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setSelected(k)}
                  aria-pressed={active}
                  className={`min-h-[2.75rem] rounded-xl px-3 py-2.5 text-sm font-semibold transition duration-200 ease-spring active:scale-95 ${
                    active
                      ? "bg-gradient-to-b from-orange-400 to-orange-500 text-white shadow-glow-energy"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200/70 dark:bg-navy-800 dark:text-navy-200 dark:hover:bg-navy-700"
                  }`}
                >
                  {a.label}
                </button>
              );
            })}
          </div>
        </section>

        {phase === "idle" && (
          <button
            type="button"
            onClick={start}
            className="w-full rounded-2xl bg-gradient-to-b from-orange-400 to-orange-500 py-3.5 text-base font-bold text-white shadow-glow-energy transition duration-200 ease-spring hover:from-orange-500 hover:to-orange-600 active:scale-[0.98]"
          >
            ▶ スタート
          </button>
        )}
        {tracking && (
          <button
            type="button"
            onClick={stop}
            className="w-full rounded-2xl bg-slate-800 py-3.5 text-base font-bold text-white shadow-card transition duration-200 ease-spring active:scale-[0.98] dark:bg-navy-700"
          >
            ■ ストップ
          </button>
        )}
        {phase === "done" && !saved && (
          <div className="animate-fade-in-up space-y-2">
            {!canSave && (
              <div className="rounded-xl bg-amber-50 px-3.5 py-2.5 text-xs leading-relaxed text-amber-700 dark:bg-amber-400/10 dark:text-amber-300">
                まだ距離が記録されていません。少し歩く/走ると保存できます（GPSが動きを拾うまで数秒かかることがあります）。
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={reset}
                className="min-h-[2.75rem] flex-1 rounded-2xl bg-slate-100 py-3 text-base font-bold text-slate-600 transition duration-200 ease-spring active:scale-[0.98] hover:bg-slate-200/70 dark:bg-navy-800 dark:text-navy-200 dark:hover:bg-navy-700"
              >
                やり直す
              </button>
              <button
                type="button"
                onClick={save}
                disabled={!canSave}
                className={`min-h-[2.75rem] flex-1 rounded-2xl py-3 text-base font-bold transition duration-200 ease-spring active:scale-[0.98] ${
                  canSave
                    ? "bg-gradient-to-b from-orange-400 to-orange-500 text-white shadow-glow-energy hover:from-orange-500 hover:to-orange-600"
                    : "cursor-not-allowed bg-slate-200 text-slate-400 active:scale-100 dark:bg-navy-800 dark:text-navy-500"
                }`}
              >
                運動ログに保存
              </button>
            </div>
          </div>
        )}
        {saved && (
          <div className="animate-pop-in text-center">
            <div className="mb-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3.5 text-sm font-semibold text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-300">
              ✓ 運動ログに保存しました（{activity.label} {formatKm(distanceM)} / {kcal ?? "—"} kcal）
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={reset}
                className="min-h-[2.75rem] flex-1 rounded-2xl bg-slate-100 py-3 text-sm font-bold text-slate-600 transition duration-200 ease-spring active:scale-[0.98] hover:bg-slate-200/70 dark:bg-navy-800 dark:text-navy-200 dark:hover:bg-navy-700"
              >
                もう一回
              </button>
              <button
                type="button"
                onClick={() => router.push("/workout")}
                className="min-h-[2.75rem] flex-1 rounded-2xl bg-gradient-to-b from-orange-400 to-orange-500 py-3 text-sm font-bold text-white shadow-glow-energy transition duration-200 ease-spring hover:from-orange-500 hover:to-orange-600 active:scale-[0.98]"
              >
                記録を見る
              </button>
            </div>
          </div>
        )}

        <p className="px-1 text-center text-[11px] leading-relaxed text-slate-400 dark:text-navy-400">
          測定中は<strong className="font-semibold">アプリを開いたまま・画面ON</strong>
          にしてください（画面を消すと計測が止まります）
        </p>
      </div>
    </AppShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/80 px-2 py-2.5 dark:border-navy-800 dark:bg-navy-800/50">
      <div className="text-[11px] text-slate-400 dark:text-navy-300">{label}</div>
      <div className="mt-0.5 text-sm font-bold tabular-nums text-slate-800 dark:text-navy-50">
        {value}
      </div>
    </div>
  );
}
