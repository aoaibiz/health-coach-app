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
  const distanceM = trackStats(points).distanceM;
  const speed = avgSpeedKmh(distanceM, elapsedSec);
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

  return (
    <AppShell>
      <div className="mx-auto max-w-md px-4 py-4">
        <h1 className="mb-1 flex items-center gap-2 text-lg font-bold">
          <FlameIcon className="h-5 w-5 text-orange-500" /> 有酸素運動
        </h1>
        <p className="mb-4 text-xs text-slate-500 dark:text-navy-300">
          種目を選んで『スタート』→歩く/走る/自転車→『ストップ』。GPSで距離と時間を測ります。
          <br />
          ※測定中は<strong>アプリを開いたまま・画面ON</strong>にしてください（ブラウザアプリなので、画面を消すと計測が止まります）。
        </p>

        {error && (
          <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-300">
            {error}
          </div>
        )}

        {/* Activity = sticky choice (does NOT auto-change) */}
        <div className="mb-4">
          <div className="mb-1.5 text-xs font-semibold text-slate-500 dark:text-navy-300">
            種目（選んだら固定。途中で変えたい時だけタップ）
          </div>
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(CARDIO_ACTIVITIES) as CardioKind[]).map((k) => {
              const a = CARDIO_ACTIVITIES[k];
              const active = selected === k;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setSelected(k)}
                  className={`rounded-xl px-3 py-2.5 text-sm font-semibold transition active:scale-95 ${
                    active
                      ? "bg-orange-500 text-white"
                      : "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-navy-200"
                  }`}
                >
                  {a.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-3">
          <Stat label="距離" value={formatKm(distanceM)} />
          <Stat label="時間" value={`${mm}:${ss}`} />
          <Stat label="ペース" value={paceMinPerKm(distanceM, elapsedSec) || "—"} />
          <Stat label="消費カロリー(推定)" value={kcal != null ? `${kcal} kcal` : "体重未設定"} />
        </div>
        {phase === "tracking" && (
          <div className="mb-4 -mt-2 text-[11px] text-slate-400">
            今の速さ: 約 {speed.toFixed(1)} km/h（止まっている時は距離は増えません）
          </div>
        )}

        {phase === "idle" && (
          <button
            type="button"
            onClick={start}
            className="w-full rounded-xl bg-orange-500 py-3 text-base font-bold text-white transition active:scale-95"
          >
            ▶ スタート
          </button>
        )}
        {phase === "tracking" && (
          <button
            type="button"
            onClick={stop}
            className="w-full rounded-xl bg-slate-800 py-3 text-base font-bold text-white transition active:scale-95 dark:bg-navy-700"
          >
            ■ ストップ
          </button>
        )}
        {phase === "done" && !saved && (
          <>
            {!canSave && (
              <div className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-400/10 dark:text-amber-300">
                まだ距離が記録されていません。少し歩く/走ると保存できます（GPSが動きを拾うまで数秒かかることがあります）。
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={reset}
                className="flex-1 rounded-xl bg-slate-100 py-3 text-base font-bold text-slate-600 transition active:scale-95 dark:bg-navy-800 dark:text-navy-200"
              >
                やり直す
              </button>
              <button
                type="button"
                onClick={save}
                disabled={!canSave}
                className={`flex-1 rounded-xl py-3 text-base font-bold transition active:scale-95 ${
                  canSave
                    ? "bg-orange-500 text-white"
                    : "cursor-not-allowed bg-slate-200 text-slate-400 dark:bg-navy-800 dark:text-navy-500"
                }`}
              >
                運動ログに保存
              </button>
            </div>
          </>
        )}
        {saved && (
          <div className="text-center">
            <div className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm font-semibold text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-300">
              ✓ 運動ログに保存しました（{activity.label} {formatKm(distanceM)} / {kcal ?? "—"} kcal）
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={reset}
                className="flex-1 rounded-xl bg-slate-100 py-3 text-sm font-bold text-slate-600 dark:bg-navy-800 dark:text-navy-200"
              >
                もう一回
              </button>
              <button
                type="button"
                onClick={() => router.push("/workout")}
                className="flex-1 rounded-xl bg-orange-500 py-3 text-sm font-bold text-white"
              >
                記録を見る
              </button>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 dark:border-navy-700 dark:bg-navy-900">
      <div className="text-[11px] text-slate-400 dark:text-navy-300">{label}</div>
      <div className="text-lg font-bold tabular-nums">{value}</div>
    </div>
  );
}
