"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ActivityLevel,
  BodyType,
  Goal,
  Profile,
  Sex,
} from "@/lib/types";
import { calcTargets } from "@/lib/nutrition";
import { API_TOKEN_STORAGE_KEY } from "@/lib/analyzeMeal";
import { setApiToken } from "@/lib/apiTokenStore";
import { pushSectionBestEffort } from "@/lib/syncData";
import { apiKeyStatus, apiKeyStatusLabel } from "@/lib/profileView";
import { compressAvatarToDataUrl } from "@/lib/image";
import { deleteAvatar, resolveAvatarUrl } from "@/lib/avatarStore";
import { formatNumber } from "@/lib/workout";
import { Disclaimer } from "@/components/Disclaimer";
import { CameraIcon, TrashIcon } from "@/components/icons";

interface Props {
  existing: Profile | null;
  onSave: (profile: Profile) => void;
  /** Shown after a successful save (e.g. navigate to the dashboard). */
  onSaved?: () => void;
  /** When editing an existing profile, lets the user return to the view. */
  onCancel?: () => void;
}

const SEX_OPTIONS: { value: Sex; label: string }[] = [
  { value: "male", label: "男性" },
  { value: "female", label: "女性" },
  { value: "other", label: "その他" },
];

const BODY_TYPE_OPTIONS: { value: BodyType; label: string }[] = [
  { value: "slim", label: "細身" },
  { value: "average", label: "標準" },
  { value: "muscular", label: "筋肉質" },
  { value: "heavy", label: "がっしり" },
];

const ACTIVITY_OPTIONS: { value: ActivityLevel; label: string; hint: string }[] = [
  { value: "sedentary", label: "ほぼ運動なし", hint: "デスクワーク中心" },
  { value: "light", label: "軽い運動", hint: "週1〜3回" },
  { value: "moderate", label: "中程度", hint: "週3〜5回" },
  { value: "active", label: "活発", hint: "週6〜7回" },
  { value: "very_active", label: "非常に活発", hint: "毎日・肉体労働" },
];

const GOAL_OPTIONS: { value: Goal; label: string; hint: string }[] = [
  { value: "lose_fat", label: "減量", hint: "脂肪を落とす" },
  { value: "maintain", label: "維持", hint: "今の体型をキープ" },
  { value: "gain_muscle", label: "増量", hint: "筋肉をつける" },
];

/** A segmented control matching the meal-type chip aesthetic. */
function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  cols = 3,
}: {
  label: string;
  options: { value: T; label: string; hint?: string }[];
  value: T;
  onChange: (v: T) => void;
  cols?: number;
}) {
  return (
    <div>
      <span className="mb-2 block text-sm font-semibold text-slate-700 dark:text-navy-100">
        {label}
      </span>
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        role="radiogroup"
        aria-label={label}
      >
        {options.map((o) => {
          const active = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(o.value)}
              className={`flex flex-col items-center justify-center rounded-xl px-2 py-2.5 text-sm font-medium transition active:scale-[0.97] ${
                active
                  ? "bg-accent text-white shadow-sm"
                  : "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-navy-200"
              }`}
            >
              <span>{o.label}</span>
              {o.hint && (
                <span
                  className={`mt-0.5 text-[10px] font-normal ${
                    active ? "text-white/80" : "text-slate-400 dark:text-navy-400"
                  }`}
                >
                  {o.hint}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A labeled number field with validation message. */
function NumberField({
  label,
  unit,
  value,
  onChange,
  error,
  placeholder,
  optional,
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  placeholder?: string;
  optional?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-navy-100">
        {label}
        {optional && (
          <span className="text-[11px] font-normal text-slate-400 dark:text-navy-400">
            任意
          </span>
        )}
      </span>
      <div className="relative">
        <input
          type="number"
          inputMode="decimal"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={`field pr-12 ${error ? "border-rose-400 focus:border-rose-400 focus:ring-rose-300/40" : ""}`}
          aria-invalid={!!error}
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400 dark:text-navy-400">
          {unit}
        </span>
      </div>
      {error && <p className="mt-1 text-xs text-rose-500">{error}</p>}
    </label>
  );
}

interface FormErrors {
  heightCm?: string;
  weightKg?: string;
  targetWeightKg?: string;
  age?: string;
  bodyFatPct?: string;
}

export function ProfileForm({ existing, onSave, onSaved, onCancel }: Props) {
  const [name, setName] = useState(existing?.name ?? "");
  const [heightCm, setHeightCm] = useState(existing ? String(existing.heightCm) : "");
  const [weightKg, setWeightKg] = useState(existing ? String(existing.weightKg) : "");
  const [targetWeightKg, setTargetWeightKg] = useState(
    existing?.targetWeightKg != null ? String(existing.targetWeightKg) : "",
  );
  const [age, setAge] = useState(existing ? String(existing.age) : "");
  const [bodyFatPct, setBodyFatPct] = useState(
    existing?.bodyFatPct != null ? String(existing.bodyFatPct) : "",
  );
  const [sex, setSex] = useState<Sex>(existing?.sex ?? "male");
  const [bodyType, setBodyType] = useState<BodyType>(existing?.bodyType ?? "average");
  const [activityLevel, setActivityLevel] = useState<ActivityLevel>(
    existing?.activityLevel ?? "moderate",
  );
  const [goal, setGoal] = useState<Goal>(existing?.goal ?? "maintain");
  const [saved, setSaved] = useState(false);
  const [apiToken, setApiTokenState] = useState("");

  // Avatar: the image is now embedded as a small data: URL ON the profile so it
  // SYNCS across devices (legacy avatarPhotoId / IndexedDB no longer crosses
  // devices). We still read a legacy blob ref as a fallback preview, and clean
  // the old IndexedDB blob up when the avatar is replaced/removed/committed.
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | undefined>(
    existing?.avatarDataUrl,
  );
  // Explicit "the user cleared the avatar this session" flag. Needed because a
  // legacy-only profile starts with avatarDataUrl === undefined, so removeAvatar
  // setting it to undefined again is a no-op that wouldn't refresh the preview
  // (it would keep showing the legacy blob). This flag suppresses the legacy
  // fallback so the preview honestly reflects the removal.
  const [avatarCleared, setAvatarCleared] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      setApiTokenState(window.localStorage.getItem(API_TOKEN_STORAGE_KEY) ?? "");
    } catch {
      setApiTokenState("");
    }
  }, []);

  // Load a preview: prefer the synced data URL; fall back to the legacy
  // IndexedDB blob (only when no data URL is set AND the user hasn't cleared it
  // this session).
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    if (avatarDataUrl) {
      setAvatarUrl(avatarDataUrl);
    } else if (avatarCleared) {
      // User removed the avatar → show nothing, never re-show the legacy blob.
      setAvatarUrl(null);
    } else {
      // No data URL on the draft → show the legacy blob preview if one exists.
      resolveAvatarUrl({ avatarPhotoId: existing?.avatarPhotoId })
        .then((res) => {
          if (!res) {
            if (!cancelled) setAvatarUrl(null);
            return;
          }
          if (res.revoke) {
            // If cleanup already ran (cancelled), revoke right here — the cleanup
            // saw objectUrl===null and couldn't, so a late resolve would leak.
            if (cancelled) {
              URL.revokeObjectURL(res.url);
              return;
            }
            objectUrl = res.url; // cleanup will revoke it.
          }
          if (cancelled) return;
          setAvatarUrl(res.url);
        })
        .catch(() => {
          if (!cancelled) setAvatarUrl(null);
        });
    }
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [avatarDataUrl, avatarCleared, existing?.avatarPhotoId]);

  async function handleAvatarFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    setAvatarBusy(true);
    try {
      const dataUrl = await compressAvatarToDataUrl(file);
      if (!dataUrl) return; // undecodable / over budget → keep the current avatar.
      setAvatarCleared(false); // a fresh pick un-clears.
      setAvatarDataUrl(dataUrl);
      setSaved(false);
    } finally {
      setAvatarBusy(false);
    }
  }

  function removeAvatar() {
    setAvatarDataUrl(undefined);
    setAvatarCleared(true); // suppress the legacy fallback so the preview clears.
    setSaved(false);
  }

  function handleCancel() {
    onCancel?.();
  }

  function handleApiTokenChange(value: string) {
    setApiTokenState(value);
    // Persist via the sync store: writes the raw token to the ORIGINAL
    // localStorage key (so every existing reader is unchanged) AND stamps an
    // updatedAt companion so the cross-device merge keeps the newest key. Then
    // best-effort push it up so a later device wipe/re-add can restore it (no-op
    // when logged out / before the login-merge gate opens; never throws).
    setApiToken(value);
    pushSectionBestEffort("apiToken");
  }

  const errors = useMemo<FormErrors>(() => {
    const e: FormErrors = {};
    const h = Number(heightCm);
    const w = Number(weightKg);
    const a = Number(age);

    if (heightCm === "" || !Number.isFinite(h) || h <= 0)
      e.heightCm = "正しい身長を入力してください";
    else if (h < 100 || h > 250) e.heightCm = "100〜250cm の範囲で入力してください";

    if (weightKg === "" || !Number.isFinite(w) || w <= 0)
      e.weightKg = "正しい体重を入力してください";
    else if (w < 25 || w > 300) e.weightKg = "25〜300kg の範囲で入力してください";

    if (age === "" || !Number.isFinite(a) || a <= 0)
      e.age = "正しい年齢を入力してください";
    else if (!Number.isInteger(a) || a < 10 || a > 120)
      e.age = "10〜120 歳の範囲で入力してください";

    if (bodyFatPct !== "") {
      const bf = Number(bodyFatPct);
      if (!Number.isFinite(bf) || bf <= 0 || bf >= 60)
        e.bodyFatPct = "1〜59% の範囲で入力してください";
    }

    if (targetWeightKg !== "") {
      const tw = Number(targetWeightKg);
      if (!Number.isFinite(tw) || tw <= 0)
        e.targetWeightKg = "正しい目標体重を入力してください";
      else if (tw < 25 || tw > 300)
        e.targetWeightKg = "25〜300kg の範囲で入力してください";
    }
    return e;
  }, [heightCm, weightKg, age, bodyFatPct, targetWeightKg]);

  const valid = Object.keys(errors).length === 0;

  // Live preview of derived targets (only when inputs are valid).
  const preview = useMemo(() => {
    if (!valid) return null;
    const draft: Profile = {
      heightCm: Number(heightCm),
      weightKg: Number(weightKg),
      targetWeightKg: targetWeightKg !== "" ? Number(targetWeightKg) : undefined,
      age: Number(age),
      sex,
      bodyType,
      activityLevel,
      goal,
      bodyFatPct: bodyFatPct !== "" ? Number(bodyFatPct) : undefined,
      updatedAt: new Date().toISOString(),
    };
    return calcTargets(draft);
  }, [valid, heightCm, weightKg, targetWeightKg, age, sex, bodyType, activityLevel, goal, bodyFatPct]);

  function handleSubmit() {
    if (!valid) return;
    const hadLegacyAvatar = !!existing?.avatarPhotoId;
    // Whether the avatar changed this session: a new synced data URL was set, or
    // the user cleared it. If NEITHER happened, a legacy-only profile must KEEP
    // its avatar (don't delete the blob, keep the avatarPhotoId ref) — otherwise
    // editing an unrelated field would silently wipe the avatar.
    const avatarChanged = avatarDataUrl !== existing?.avatarDataUrl || avatarCleared;
    // Drop the legacy IndexedDB blob ONLY when the avatar was changed/cleared
    // (it's being replaced by the data URL or removed). Best-effort; never blocks.
    if (hadLegacyAvatar && avatarChanged) {
      deleteAvatar(existing!.avatarPhotoId!).catch(() => undefined);
    }
    const trimmedName = name.trim();
    const profile: Profile = {
      name: trimmedName ? trimmedName : undefined,
      heightCm: Number(heightCm),
      weightKg: Number(weightKg),
      targetWeightKg: targetWeightKg !== "" ? Number(targetWeightKg) : undefined,
      age: Number(age),
      sex,
      bodyType,
      activityLevel,
      goal,
      bodyFatPct: bodyFatPct !== "" ? Number(bodyFatPct) : undefined,
      // Synced avatar (follows the user across devices). The legacy avatarPhotoId
      // is preserved ONLY when the avatar was untouched on a legacy-only profile,
      // so an unrelated edit can't wipe it (it still shows via the legacy
      // fallback and migrates to the synced data URL on the next re-pick).
      avatarDataUrl,
      avatarPhotoId: !avatarChanged && hadLegacyAvatar ? existing!.avatarPhotoId : undefined,
      updatedAt: new Date().toISOString(),
    };
    onSave(profile);
    setSaved(true);
    onSaved?.();
  }

  return (
    <div className="space-y-5">
      <div className="surface space-y-4 p-5">
        {/* Name + avatar (both optional) */}
        <div className="flex items-center gap-4">
          <input
            ref={avatarFileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleAvatarFile}
          />
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => avatarFileRef.current?.click()}
              disabled={avatarBusy}
              aria-label={avatarUrl ? "写真を変更" : "写真を追加"}
              className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-slate-100 text-slate-400 transition active:scale-95 disabled:opacity-50 dark:border-navy-700 dark:bg-navy-800 dark:text-navy-300"
            >
              {avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={avatarUrl} alt="プロフィール写真" className="h-full w-full object-cover" />
              ) : avatarBusy ? (
                <span className="text-[11px]">…</span>
              ) : (
                <CameraIcon className="h-6 w-6" />
              )}
            </button>
            {avatarUrl && (
              <button
                type="button"
                onClick={removeAvatar}
                aria-label="写真を削除"
                className="absolute -right-1 -top-1 flex h-6 w-6 items-center justify-center rounded-full bg-slate-700 text-white shadow-sm active:scale-95 dark:bg-navy-700"
              >
                <TrashIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <label className="block flex-1">
            <span className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-navy-100">
              名前
              <span className="text-[11px] font-normal text-slate-400 dark:text-navy-400">
                任意
              </span>
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSaved(false);
              }}
              maxLength={40}
              className="field"
              placeholder="ニックネーム"
            />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label="身長"
            unit="cm"
            value={heightCm}
            onChange={(v) => {
              setHeightCm(v);
              setSaved(false);
            }}
            error={errors.heightCm}
            placeholder="170"
          />
          <NumberField
            label="体重"
            unit="kg"
            value={weightKg}
            onChange={(v) => {
              setWeightKg(v);
              setSaved(false);
            }}
            error={errors.weightKg}
            placeholder="65"
          />
          <NumberField
            label="目標体重"
            unit="kg"
            value={targetWeightKg}
            onChange={(v) => {
              setTargetWeightKg(v);
              setSaved(false);
            }}
            error={errors.targetWeightKg}
            placeholder="—"
            optional
          />
          <NumberField
            label="年齢"
            unit="歳"
            value={age}
            onChange={(v) => {
              setAge(v);
              setSaved(false);
            }}
            error={errors.age}
            placeholder="30"
          />
          <NumberField
            label="体脂肪率"
            unit="%"
            value={bodyFatPct}
            onChange={(v) => {
              setBodyFatPct(v);
              setSaved(false);
            }}
            error={errors.bodyFatPct}
            placeholder="—"
            optional
          />
        </div>

        <Segmented label="性別" options={SEX_OPTIONS} value={sex} onChange={(v) => { setSex(v); setSaved(false); }} cols={3} />
        <Segmented label="体型" options={BODY_TYPE_OPTIONS} value={bodyType} onChange={(v) => { setBodyType(v); setSaved(false); }} cols={4} />
        <Segmented label="活動量" options={ACTIVITY_OPTIONS} value={activityLevel} onChange={(v) => { setActivityLevel(v); setSaved(false); }} cols={2} />
        <Segmented label="目標" options={GOAL_OPTIONS} value={goal} onChange={(v) => { setGoal(v); setSaved(false); }} cols={3} />

        <label className="block">
          <span className="mb-1.5 flex items-center justify-between gap-2 text-sm font-semibold text-slate-700 dark:text-navy-100">
            <span>アクセスキー</span>
            {(() => {
              const status = apiKeyStatus(apiToken);
              return (
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                    status === "set"
                      ? "bg-accent/12 text-accent dark:bg-accent-light/15 dark:text-accent-light"
                      : "bg-slate-100 text-slate-500 dark:bg-navy-800 dark:text-navy-300"
                  }`}
                >
                  {apiKeyStatusLabel(status)}
                </span>
              );
            })()}
          </span>
          <input
            type="password"
            value={apiToken}
            onChange={(e) => handleApiTokenChange(e.target.value)}
            className="field"
            autoComplete="off"
            placeholder="解析用アクセスキー"
          />
          <span className="mt-1.5 block text-xs leading-relaxed text-slate-500 dark:text-navy-300">
            これを入れるとAI機能が使えるようになります（写真・テキストのカロリー自動解析と、健康マンチャット）。未設定だとこの2つは動きません。記録・カロリーの手入力・目標計算・筋トレ記録はキーなしでも使えます。
            <br />
            このアプリ用の合言葉です。外部の有料APIキーではありません（料金はかかりません）。入力すると自動で保存されます。
          </span>
        </label>
      </div>

      {/* Live target preview */}
      {preview && (
        <div className="surface p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-700 dark:text-navy-100">
              あなたの1日の目標
            </h2>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-navy-800 dark:text-navy-300">
              {preview.bmrMethod}
            </span>
          </div>
          <div className="flex items-end gap-2">
            <span className="text-4xl font-bold tabular-nums text-accent dark:text-accent-light">
              {formatNumber(preview.calories)}
            </span>
            <span className="mb-1 text-sm font-medium text-slate-400 dark:text-navy-300">
              kcal / 日
            </span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            {[
              { label: "P", value: preview.proteinG, color: "text-rose-500" },
              { label: "F", value: preview.fatG, color: "text-amber-500" },
              { label: "C", value: preview.carbG, color: "text-sky-500" },
            ].map((m) => (
              <div key={m.label} className="rounded-xl bg-slate-50 py-2 dark:bg-navy-800/60">
                <span className={`text-xs font-bold ${m.color}`}>{m.label}</span>
                <p className="text-lg font-bold tabular-nums text-slate-800 dark:text-navy-50">
                  {formatNumber(m.value)}
                  <span className="ml-0.5 text-xs font-normal text-slate-400">g</span>
                </p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-400 dark:text-navy-400">
            BMR {formatNumber(preview.bmr)} · TDEE {formatNumber(preview.tdee)} kcal
          </p>
          <Disclaimer className="mt-3" />
        </div>
      )}

      <div className="flex gap-2">
        {existing && onCancel && (
          <button
            type="button"
            onClick={handleCancel}
            className="btn-ghost flex-1 border border-slate-200 py-3 dark:border-navy-700"
          >
            キャンセル
          </button>
        )}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!valid}
          className="btn-primary flex-1 py-3"
        >
          {saved ? "保存しました ✓" : existing ? "プロフィールを更新" : "保存して始める"}
        </button>
      </div>
    </div>
  );
}
