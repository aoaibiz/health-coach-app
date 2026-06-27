// Client-side persistence + sanitisation for the user-customisable coach persona
// (name / avatar / personality). Mirrors the user-profile store pattern
// (storage.ts + avatarStore.ts): the persona's small JSON lives in localStorage
// under a dedicated key, and the avatar BLOB reuses the SAME IndexedDB photo
// store as the profile/meal photos (only the string id ref is kept here).
//
// IMPORTANT (security): the name flows into the coach prompt, so it is UNTRUSTED.
// We sanitise it to a single safe line (strip newlines/control chars + clamp)
// at the boundary, and gender/style are fixed enums — never free text. The
// server (functions/api/chat.ts shapeCoach) re-applies the SAME discipline as
// defense-in-depth, so a tampered request can't inject prompt content either.

// The synced coach avatar (avatarDataUrl) shares the profile avatar's size
// budget — re-use the single source of truth (a plain numeric const; image.ts
// has no module-load side effects, so this is SSR/node-test safe).
import { AVATAR_MAX_DATA_URL_CHARS } from "./image";
// Best-effort server backup on save (same pattern as storage.ts → saveProfile).
// syncData imports THIS module too; the cycle is runtime-only (the function is
// called, not evaluated at module load) — identical to storage.ts's cycle.
import { pushSectionBestEffort } from "./syncData";

/** Coach gender — enum only (matches the server CoachGender). */
export type CoachGender = "female" | "male" | "unspecified";
/** Coach behaviour style — enum only (matches the server CoachStyle). */
export type CoachStyle = "gentle" | "hardcore" | "logical" | "friendly";

export const COACH_GENDERS: readonly CoachGender[] = ["female", "male", "unspecified"];
export const COACH_STYLES: readonly CoachStyle[] = [
  "gentle",
  "hardcore",
  "logical",
  "friendly",
];

/** Default on-screen coach name (matches the server DEFAULT_COACH_NAME). */
export const DEFAULT_COACH_NAME = "健康マン";
/** Max coach-name length (matches the server MAX_COACH_NAME_CHARS). */
export const MAX_COACH_NAME_CHARS = 24;

/**
 * The user's coach persona, as persisted. All fields optional/additive so an
 * absent store (never configured) is valid and yields the default 健康マン coach.
 */
export interface CoachSettings {
  /** Chosen display name; absent/blank → default 健康マン. */
  name?: string;
  /**
   * IndexedDB key of a chosen avatar photo (reuses avatarStore/photoStore).
   *
   * @deprecated Device-local only — an IndexedDB blob ref does NOT cross devices,
   * so a custom coach photo "disappeared" after a device switch (same bug the
   * profile avatar had). New saves embed the image in `avatarDataUrl` (below),
   * which rides the synced coachSettings blob. Still READ as a fallback so a
   * coach photo saved before the change keeps showing on the SAME device, and
   * migrated to `avatarDataUrl` on the next login (see avatarMigration.ts).
   */
  avatarPhotoId?: string;
  /**
   * Custom coach avatar as a small compressed JPEG **data: URL** (see
   * compressAvatarToDataUrl). UNLIKE avatarPhotoId this lives ON the settings
   * object, so it is part of the synced coachSettings blob and follows the user
   * across devices (fixes "コーチの写真が消える"). Bounded (≤ ~180KB) so it never
   * bloats the per-section sync budget. Additive/optional → existing settings
   * load fine. A custom photo (data URL or legacy blob) overrides any preset.
   */
  avatarDataUrl?: string;
  /** Preset avatar id, when a built-in preset (not a custom upload) was chosen. */
  presetAvatar?: string;
  gender?: CoachGender;
  style?: CoachStyle;
}

export const COACH_SETTINGS_KEY = "health-app:coachSettings";

/**
 * Strip a string to a single safe line: remove C0/DEL/C1 control chars (covers
 * \n \r \t etc.) so the name can never carry an embedded heading/instruction
 * onto its own line, then trim. Mirrors the server's sanitizeLine.
 */
export function sanitizeCoachName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, "")
    .trim()
    .slice(0, MAX_COACH_NAME_CHARS);
}

/** Validate/normalise a raw parsed value into clean CoachSettings. Pure. */
export function sanitizeCoachSettings(raw: unknown): CoachSettings {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: CoachSettings = {};

  if (typeof r.name === "string") {
    const name = sanitizeCoachName(r.name);
    if (name) out.name = name;
  }
  if (typeof r.avatarPhotoId === "string" && r.avatarPhotoId.trim()) {
    out.avatarPhotoId = r.avatarPhotoId.trim();
  }
  // Synced custom coach avatar (data: URL). Accept ONLY a JPEG/PNG data: URL
  // within the SAME size budget as the profile avatar, so a tampered/oversized
  // value can never bloat the synced coachSettings blob. Mirrors the discipline
  // image.ts applies on the way in (compressAvatarToDataUrl).
  if (
    typeof r.avatarDataUrl === "string" &&
    /^data:image\/(jpeg|png|webp);base64,/.test(r.avatarDataUrl) &&
    r.avatarDataUrl.length <= AVATAR_MAX_DATA_URL_CHARS
  ) {
    out.avatarDataUrl = r.avatarDataUrl;
  }
  if (typeof r.presetAvatar === "string" && r.presetAvatar.trim()) {
    out.presetAvatar = r.presetAvatar.trim();
  }
  if (typeof r.gender === "string" && COACH_GENDERS.includes(r.gender as CoachGender)) {
    out.gender = r.gender as CoachGender;
  }
  if (typeof r.style === "string" && COACH_STYLES.includes(r.style as CoachStyle)) {
    out.style = r.style as CoachStyle;
  }
  return out;
}

/** Load the persisted coach settings (SSR-safe; corrupt/missing → {}). */
export function loadCoachSettings(): CoachSettings {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(COACH_SETTINGS_KEY);
    if (!raw) return {};
    return sanitizeCoachSettings(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** Persist the coach settings (sanitised on the way in). Also fires a best-effort
 *  server push so a coach-settings change (incl. the synced avatar) reaches the
 *  server immediately, exactly like saveProfile — instead of only on the next
 *  visibility/pagehide flush. No-op when logged out or before the section's
 *  login-merge has run (the wipe fuse); never throws. */
export function saveCoachSettings(settings: CoachSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      COACH_SETTINGS_KEY,
      JSON.stringify(sanitizeCoachSettings(settings)),
    );
  } catch {
    /* quota/serialisation errors are non-fatal for settings */
  }
  // Best-effort backup (gated by syncData's merge fuse; no-op when logged out).
  try {
    pushSectionBestEffort("coachSettings");
  } catch {
    /* a failed push leaves local intact; the next flush/login retries it */
  }
}

/** The display name to show in the UI (chosen, sanitised, or the default). */
export function coachDisplayName(settings: CoachSettings | null | undefined): string {
  const n = settings?.name ? sanitizeCoachName(settings.name) : "";
  return n || DEFAULT_COACH_NAME;
}

/**
 * Reduce the persisted settings to the persona that travels to the prompt
 * (presentation only — name/gender/style, NO avatar id). Omits fields that are
 * absent so the server/prompt fall back to defaults. The name is re-sanitised
 * here as the last client-side gate before it leaves for the server.
 */
export function coachToPersona(
  settings: CoachSettings | null | undefined,
): { name?: string; gender?: CoachGender; style?: CoachStyle } | undefined {
  if (!settings) return undefined;
  const out: { name?: string; gender?: CoachGender; style?: CoachStyle } = {};
  const name = settings.name ? sanitizeCoachName(settings.name) : "";
  if (name) out.name = name;
  if (settings.gender && COACH_GENDERS.includes(settings.gender)) out.gender = settings.gender;
  if (settings.style && COACH_STYLES.includes(settings.style)) out.style = settings.style;
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---- Preset avatars --------------------------------------------------------
// A few built-in coach faces shipped as static assets, plus the existing mascot
// as the default. Custom upload is handled separately (reuses avatarStore). A
// preset is referenced by a stable id; its src is resolved by the UI/helpers.

export interface CoachAvatarPreset {
  id: string;
  /** Static asset path (served from /public). */
  src: string;
  /** Short JP label for the picker. */
  label: string;
}

/** The default mascot (健康マン) avatar asset — the no-selection fallback. */
export const DEFAULT_COACH_AVATAR_SRC = "/mascot/assistant-avatar-256.png";

/**
 * Built-in preset faces. The default mascot is always offered; the rest reuse
 * existing mascot art so no new binary assets are required (honest: only the
 * mascot ships today, so the meaningful customisation is name/style/gender +
 * custom-upload, with the mascot as the default preset).
 */
export const COACH_AVATAR_PRESETS: readonly CoachAvatarPreset[] = [
  { id: "mascot", src: DEFAULT_COACH_AVATAR_SRC, label: "健康マン" },
];

/** Resolve a preset id to its asset src, or null if unknown. */
export function presetAvatarSrc(presetId: string | undefined): string | null {
  if (!presetId) return null;
  const found = COACH_AVATAR_PRESETS.find((p) => p.id === presetId);
  return found ? found.src : null;
}

// ---- View vs edit mode (Fix 2 — saved confirmation view) -------------------
// Mirrors profileView.ts so the coach-settings panel shows a clear "registered"
// view (avatar + name + gender + style) after save, with an 編集 button — the
// same pattern as the profile page, not just a "保存しました ✓" checkmark.

export type CoachScreenMode = "view" | "edit";

/**
 * Whether the user has actually configured a coach (any meaningful field set).
 * Avatar-only counts as configured too (they chose a face). Used to pick the
 * initial mode: configured → "view", untouched → "edit" (go straight to the form
 * on first run, like the profile page).
 */
export function coachConfigured(settings: CoachSettings | null | undefined): boolean {
  if (!settings) return false;
  const name = settings.name ? sanitizeCoachName(settings.name) : "";
  return Boolean(
    name ||
      (settings.gender && COACH_GENDERS.includes(settings.gender)) ||
      (settings.style && COACH_STYLES.includes(settings.style)) ||
      (settings.avatarDataUrl && settings.avatarDataUrl.trim()) ||
      (settings.avatarPhotoId && settings.avatarPhotoId.trim()) ||
      (settings.presetAvatar && settings.presetAvatar.trim()),
  );
}

/** Initial mode for the coach-settings panel: configured → view, else edit. */
export function initialCoachMode(settings: CoachSettings | null | undefined): CoachScreenMode {
  return coachConfigured(settings) ? "view" : "edit";
}

const COACH_GENDER_LABEL: Record<CoachGender, string> = {
  female: "女性",
  male: "男性",
  unspecified: "指定なし",
};

const COACH_STYLE_LABEL: Record<CoachStyle, string> = {
  gentle: "やさしく励ます",
  hardcore: "熱血・ストイック",
  logical: "冷静・論理的",
  friendly: "フレンドリー",
};

/** Localised gender label for the read-only view (default → 指定なし). */
export function coachGenderLabel(gender: CoachGender | undefined): string {
  return COACH_GENDER_LABEL[gender && COACH_GENDERS.includes(gender) ? gender : "unspecified"];
}

/** Localised style label for the read-only view (default → やさしく励ます). */
export function coachStyleLabel(style: CoachStyle | undefined): string {
  return COACH_STYLE_LABEL[style && COACH_STYLES.includes(style) ? style : "gentle"];
}
