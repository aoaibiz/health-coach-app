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
  classifyActivity,
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
  const [override, setOverride] = useState<CardioKind | null>(null);
  const [error, setError] = useState<string>("");
  const [, setTick] = useState<number>(0); // forces a re-render each second while tracking
  const [saved, setSaved] = useState(false);

  const watchId = useRef<number | null>(null);
  const wakeLock = useRef<WakeLockSentinel | null>(null);

  // --- live numbers (recomputed each render from the kept points) ---
  const stats = trackStats(points);
  const speed = avgSpeedKmh(stats.distanceM, stats.durationSec);
  const auto = classifyActivity(speed);
  const activity = override ? CARDIO_ACTIVITIES[override] : auto;
  const durationMin = Math.max(0, Math.round(stats.durationSec / 60));
  const weightKg = profile?.weightKg ?? 0;

  // Calorie preview via the EXISTING burn model (MET × 体重 × 時間). We never invent a
  // number — burn.ts resolves the MET from the activity name (ランニング/ウォーキング/
  // サイクリング) and the user's weight.
  const previewExercise: Exercise = {
    id: "preview",
    name: activity.name,
    sets: 1,
    reps: 0,
    weight: 0,
    durationMin: Math.max(1, durationMin),
    intensity: "moderate",
  };
  const kcal = weightKg > 0 ? exerciseBurn(previewExercise, weightKg).caloriesBurned : null;

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
    setOverride(null);
    setSaved(false);
    setPhase("tracking");
    // Keep the screen awake during tracking (best-effort). A PWA can't track in the
    // background, so the screen must stay on / the app foregrounded.
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
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
    );
  }

  function stop() {
    stopWatch();
    releaseWake();
    setPhase("done");
  }

  function save() {
    if (stats.distanceM < 1 || durationMin < 1) return;
    const exercise: Exercise = {
      id: makeId(),
      name: `${activity.name} ${formatKm(stats.distanceM)}`,
      sets: 1,
      reps: 0,
      weight: 0,
      durationMin,
      intensity: "moderate",
    };
    addExercise(exercise);
    setSaved(true);
  }

  function reset() {
    setPhase("idle");
    setPoints([]);
    setOverride(null);
    setError("");
    setSaved(false);
  }

  const elapsed = stats.durationSec;
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(Math.floor(elapsed % 60)).padStart(2, "0");

  return (
    <AppShell>
      <div className="mx-auto max-w-md px-4 py-4">
        <h1 className="mb-1 flex items-center gap-2 text-lg font-bold">
          <FlameIcon className="h-5 w-5 text-orange-500" /> 有酸素運動
        </h1>
        <p className="mb-4 text-xs text-slate-500 dark:text-navy-300">
          スタートを押して歩く・走る・自転車。GPSで距離と時間を測ります。
          <br />
          ※測定中は<strong>アプリを開いたまま・画面ON</strong>にしてください（ブラウザアプリなので、画面を消すと計測が止まります）。
        </p>

        {error && (
          <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-300">
            {error}
          </div>
        )}

        <div className="mb-4 grid grid-cols-2 gap-3">
          <Stat label="距離" value={formatKm(stats.distanceM)} />
          <Stat label="時間" value={`${mm}:${ss}`} />
          <Stat label="ペース" value={paceMinPerKm(stats.distanceM, stats.durationSec) || "—"} />
          <Stat label="消費カロリー(推定)" value={kcal != null ? `${kcal} kcal` : "体重未設定"} />
        </div>

        <div className="mb-4">
          <div className="mb-1.5 text-xs font-semibold text-slate-500 dark:text-navy-300">
            種目（自動判定・タップで変更できます）
          </div>
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(CARDIO_ACTIVITIES) as CardioKind[]).map((k) => {
              const a = CARDIO_ACTIVITIES[k];
              const active = activity.kind === k;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setOverride(k)}
                  className={`rounded-xl px-3 py-2 text-sm font-semibold transition active:scale-95 ${
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
          {!override && phase !== "idle" && (
            <div className="mt-1 text-[11px] text-slate-400">
              速さから「{auto.label}」と判定しています。
            </div>
          )}
        </div>

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
              disabled={stats.distanceM < 1 || durationMin < 1}
              className="flex-1 rounded-xl bg-orange-500 py-3 text-base font-bold text-white transition active:scale-95 disabled:opacity-40"
            >
              運動ログに保存
            </button>
          </div>
        )}
        {saved && (
          <div className="text-center">
            <div className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm font-semibold text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-300">
              ✓ 運動ログに保存しました（{activity.label} {formatKm(stats.distanceM)} / {kcal ?? "—"} kcal）
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
