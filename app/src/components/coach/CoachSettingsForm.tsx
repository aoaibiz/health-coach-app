"use client";

import { useEffect, useRef, useState } from "react";
import { compressImage } from "@/lib/image";
import { deleteAvatar, getAvatar, putAvatar } from "@/lib/avatarStore";
import {
  coachConfigured,
  coachDisplayName,
  coachGenderLabel,
  coachStyleLabel,
  COACH_AVATAR_PRESETS,
  DEFAULT_COACH_AVATAR_SRC,
  initialCoachMode,
  MAX_COACH_NAME_CHARS,
  presetAvatarSrc,
  sanitizeCoachName,
  type CoachGender,
  type CoachScreenMode,
  type CoachSettings,
  type CoachStyle,
} from "@/lib/coachSettings";
import { PencilIcon, TrashIcon, UserIcon } from "@/components/icons";

interface Props {
  existing: CoachSettings;
  onSave: (settings: CoachSettings) => void;
}

/**
 * Mode-managing wrapper (Fix 2). Mirrors the profile page's view/edit pattern:
 * a coach that's already configured opens in a clear read-only VIEW (avatar +
 * name + gender + style + 編集 button); first run opens straight in the edit form.
 * Saving the form returns to the view (a "registered, here's your coach" screen),
 * not just a "保存しました ✓" checkmark. The edit form below is unchanged in
 * behaviour — only its save callback now flips back to the view.
 */
export function CoachSettingsForm({ existing, onSave }: Props) {
  // Initial mode is chosen ONCE from the loaded settings (configured → view).
  // Like the profile page, we don't yank the user out of the form on a later
  // save — the edit form drives the transition to view itself via onSaved.
  const [mode, setMode] = useState<CoachScreenMode>(() => initialCoachMode(existing));

  if (mode === "view") {
    return <CoachSettingsView settings={existing} onEdit={() => setMode("edit")} />;
  }
  return (
    <CoachSettingsEditForm
      existing={existing}
      onSave={onSave}
      onSaved={() => setMode("view")}
    />
  );
}

/** Read-only avatar for the saved view (custom blob > preset > default mascot). */
function ViewAvatar({ settings, name }: { settings: CoachSettings; name: string }) {
  const [customUrl, setCustomUrl] = useState<string | null>(null);
  const { avatarPhotoId, presetAvatar } = settings;

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    if (avatarPhotoId) {
      getAvatar(avatarPhotoId)
        .then((blob) => {
          if (cancelled || !blob) return;
          url = URL.createObjectURL(blob);
          setCustomUrl(url);
        })
        .catch(() => undefined);
    } else {
      setCustomUrl(null);
    }
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [avatarPhotoId]);

  const src = customUrl ?? presetAvatarSrc(presetAvatar);
  return (
    <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-slate-100 text-slate-400 dark:border-navy-700 dark:bg-navy-800 dark:text-navy-300">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={`${name}の写真`} className="h-full w-full object-cover" />
      ) : (
        <UserIcon className="h-7 w-7" />
      )}
    </div>
  );
}

/**
 * The saved/confirmation VIEW of the configured coach (Fix 2). Clear "設定済み"
 * header + the chosen avatar/name/gender/style at a glance + a prominent 編集
 * button — the coach analogue of ProfileView. White/navy theme unchanged.
 */
export function CoachSettingsView({
  settings,
  onEdit,
}: {
  settings: CoachSettings;
  onEdit: () => void;
}) {
  const name = coachDisplayName(settings);
  const rows: { label: string; value: string }[] = [
    { label: "名前", value: name },
    { label: "性別", value: coachGenderLabel(settings.gender) },
    { label: "性格・話し方", value: coachStyleLabel(settings.style) },
  ];
  return (
    <div className="surface space-y-4 p-5">
      <div className="flex items-center gap-4">
        <ViewAvatar settings={settings} name={name} />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-accent dark:text-accent-light">
            コーチ設定済み
          </p>
          <p className="mt-0.5 truncate text-lg font-bold text-slate-900 dark:text-navy-50">
            {name}
          </p>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-navy-300">
            {coachGenderLabel(settings.gender)}・{coachStyleLabel(settings.style)}
          </p>
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="btn-primary shrink-0 px-4 py-2"
        >
          <PencilIcon className="h-4 w-4" />
          編集
        </button>
      </div>

      <dl className="grid grid-cols-1 gap-y-2">
        {rows.map((r) => (
          <div
            key={r.label}
            className="flex items-baseline justify-between border-b border-slate-100 pb-2 dark:border-navy-800"
          >
            <dt className="text-xs text-slate-400 dark:text-navy-400">{r.label}</dt>
            <dd className="text-sm font-semibold text-slate-800 dark:text-navy-50">
              {r.value}
            </dd>
          </div>
        ))}
      </dl>

      <p className="text-xs leading-relaxed text-slate-400 dark:text-navy-400">
        専門知識とアドバイスの正確さは設定に関わらず変わりません（話し方の雰囲気だけ変わります）。
      </p>
    </div>
  );
}

interface EditProps extends Props {
  /** Called after a successful save so the wrapper can return to the view. */
  onSaved?: () => void;
}

const GENDER_OPTIONS: { value: CoachGender; label: string }[] = [
  { value: "female", label: "女性" },
  { value: "male", label: "男性" },
  { value: "unspecified", label: "指定なし" },
];

const STYLE_OPTIONS: { value: CoachStyle; label: string; hint: string }[] = [
  { value: "gentle", label: "やさしく励ます", hint: "あたたかく前向き" },
  { value: "hardcore", label: "熱血・ストイック", hint: "情熱的に鼓舞" },
  { value: "logical", label: "冷静・論理的", hint: "根拠と数字で" },
  { value: "friendly", label: "フレンドリー", hint: "気さくで親しみやすい" },
];

const DEFAULT_GENDER: CoachGender = "unspecified";
const DEFAULT_STYLE: CoachStyle = "gentle";

/** A segmented control matching the profile-form aesthetic (white/navy theme). */
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

/**
 * Settings panel for the user-customisable coach (name / avatar / personality).
 * Persona-only: it shapes the coach's VOICE + on-screen identity; the elite
 * expertise + safety floor in the prompt are constant and untouched here.
 *
 * Avatar reuses the EXACT mechanism the profile avatar uses (avatarStore →
 * IndexedDB blob, only the id ref persisted) plus a built-in preset + a default
 * mascot. The name is sanitised to a single safe line on save (anti prompt-
 * injection — the name reaches the prompt); the server re-sanitises too.
 */
function CoachSettingsEditForm({ existing, onSave, onSaved }: EditProps) {
  const [name, setName] = useState(existing.name ?? "");
  const [gender, setGender] = useState<CoachGender>(existing.gender ?? DEFAULT_GENDER);
  const [style, setStyle] = useState<CoachStyle>(existing.style ?? DEFAULT_STYLE);
  const [presetAvatar, setPresetAvatar] = useState<string | undefined>(existing.presetAvatar);

  // Custom avatar: blob in IndexedDB, only the id ref persisted (mirrors profile).
  const [avatarPhotoId, setAvatarPhotoId] = useState<string | undefined>(existing.avatarPhotoId);
  const [customUrl, setCustomUrl] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarFileRef = useRef<HTMLInputElement>(null);
  // Avatar staged this session but not yet committed — clean up on swap.
  const stagedAvatarRef = useRef<string | null>(null);

  // Load a preview for the current custom avatar id.
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    if (avatarPhotoId) {
      getAvatar(avatarPhotoId).then((blob) => {
        if (cancelled || !blob) return;
        url = URL.createObjectURL(blob);
        setCustomUrl(url);
      });
    } else {
      setCustomUrl(null);
    }
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [avatarPhotoId]);

  async function handleAvatarFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    setAvatarBusy(true);
    try {
      const blob = await compressImage(file);
      const id = await putAvatar(blob);
      // Drop a previously staged (uncommitted) custom avatar.
      if (stagedAvatarRef.current && stagedAvatarRef.current !== existing.avatarPhotoId) {
        await deleteAvatar(stagedAvatarRef.current).catch(() => undefined);
      }
      stagedAvatarRef.current = id;
      setAvatarPhotoId(id);
      setPresetAvatar(undefined); // a custom photo overrides any preset
    } finally {
      setAvatarBusy(false);
    }
  }

  async function removeCustomAvatar() {
    if (avatarPhotoId && avatarPhotoId !== existing.avatarPhotoId) {
      await deleteAvatar(avatarPhotoId).catch(() => undefined);
    }
    if (stagedAvatarRef.current === avatarPhotoId) stagedAvatarRef.current = null;
    setAvatarPhotoId(undefined);
  }

  function choosePreset(id: string) {
    setPresetAvatar(id);
    // Choosing a preset clears any custom photo selection (presets win in UI).
    void removeCustomAvatar();
  }

  function handleSubmit() {
    // If a custom avatar was swapped vs the saved one, drop the old orphan blob.
    if (existing.avatarPhotoId && existing.avatarPhotoId !== avatarPhotoId) {
      deleteAvatar(existing.avatarPhotoId).catch(() => undefined);
    }
    const cleanName = sanitizeCoachName(name);
    const settings: CoachSettings = {
      name: cleanName ? cleanName : undefined,
      gender,
      style,
      avatarPhotoId,
      presetAvatar: avatarPhotoId ? undefined : presetAvatar,
    };
    stagedAvatarRef.current = null; // committed
    onSave(settings);
    // Return to the saved/confirmation view (Fix 2) — the parent re-reads the
    // now-persisted settings, so the view reflects exactly what was saved.
    onSaved?.();
  }

  // The avatar shown in the live preview (custom > preset > default mascot).
  const previewSrc =
    customUrl ?? presetAvatarSrc(presetAvatar) ?? DEFAULT_COACH_AVATAR_SRC;
  const previewName = coachDisplayName({ name: sanitizeCoachName(name) });

  return (
    <div className="surface space-y-5 p-5">
      <div>
        <h2 className="text-sm font-bold text-slate-700 dark:text-navy-100">
          コーチの設定
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-navy-300">
          AIコーチの名前・写真・性格を選べます。専門知識とアドバイスの正確さは変わりません（話し方の雰囲気だけ変わります）。
        </p>
      </div>

      {/* Avatar (custom upload + preset) + name */}
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
            aria-label={customUrl ? "写真を変更" : "コーチの写真を追加"}
            className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-slate-100 text-slate-400 transition active:scale-95 disabled:opacity-50 dark:border-navy-700 dark:bg-navy-800 dark:text-navy-300"
          >
            {avatarBusy ? (
              <span className="text-[11px]">…</span>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={previewSrc} alt={previewName} className="h-full w-full object-cover" />
            )}
          </button>
          {customUrl && (
            <button
              type="button"
              onClick={() => void removeCustomAvatar()}
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
            onChange={(e) => setName(e.target.value)}
            maxLength={MAX_COACH_NAME_CHARS}
            className="field"
            placeholder={coachDisplayName(null)}
          />
        </label>
      </div>

      {/* Preset faces (default mascot + any built-in presets) */}
      {COACH_AVATAR_PRESETS.length > 0 && (
        <div>
          <span className="mb-2 block text-sm font-semibold text-slate-700 dark:text-navy-100">
            プリセットの顔
          </span>
          <div className="flex flex-wrap gap-2">
            {COACH_AVATAR_PRESETS.map((p) => {
              const active = !customUrl && presetAvatar === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => choosePreset(p.id)}
                  aria-pressed={active}
                  aria-label={p.label}
                  className={`flex h-12 w-12 items-center justify-center overflow-hidden rounded-full ring-2 transition active:scale-95 ${
                    active ? "ring-accent" : "ring-transparent"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.src} alt={p.label} className="h-full w-full object-cover" />
                </button>
              );
            })}
          </div>
        </div>
      )}

      <Segmented
        label="性別"
        options={GENDER_OPTIONS}
        value={gender}
        onChange={(v) => setGender(v)}
        cols={3}
      />

      <Segmented
        label="性格・話し方"
        options={STYLE_OPTIONS}
        value={style}
        onChange={(v) => setStyle(v)}
        cols={2}
      />

      <div className="flex gap-2">
        {onSaved && coachConfigured(existing) && (
          <button
            type="button"
            onClick={onSaved}
            className="rounded-xl bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-600 transition active:scale-[0.98] dark:bg-navy-800 dark:text-navy-200"
          >
            キャンセル
          </button>
        )}
        <button type="button" onClick={handleSubmit} className="btn-primary flex-1 py-3">
          コーチの設定を保存
        </button>
      </div>
    </div>
  );
}
