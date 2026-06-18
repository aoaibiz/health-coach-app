// Pure-logic helpers for the profile screen's view/edit toggle, the access-key
// status indicator, and read-only profile summary formatting.
//
// These have no DOM/storage/network so they're fully unit-testable in the
// node test environment (matching the rest of src/lib). The React components
// consume them.

import type {
  ActivityLevel,
  BodyType,
  Goal,
  Profile,
  Sex,
} from "./types";

// ---- Access-key status (gap #3) --------------------------------------------

export type ApiKeyStatus = "set" | "unset";

/**
 * Derive whether an access key is configured from its stored string.
 * `null`/`undefined`/blank (whitespace-only) all count as unset; the key
 * auto-saves elsewhere, this only surfaces the resulting state.
 */
export function apiKeyStatus(token: string | null | undefined): ApiKeyStatus {
  return token != null && token.trim() !== "" ? "set" : "unset";
}

const API_KEY_STATUS_LABEL: Record<ApiKeyStatus, string> = {
  set: "設定済み ✓",
  unset: "未設定",
};

/** Japanese label shown next to the access-key field. */
export function apiKeyStatusLabel(status: ApiKeyStatus): string {
  return API_KEY_STATUS_LABEL[status];
}

// ---- View vs edit mode (gap #2) --------------------------------------------

export type ProfileScreenMode = "view" | "edit";

/**
 * Initial mode for the profile screen:
 *  - no profile yet (first run)  → "edit" (go straight to the form, as today)
 *  - a profile exists            → "view" (read-only summary + 編集 button)
 */
export function initialProfileMode(profile: Profile | null): ProfileScreenMode {
  return profile ? "view" : "edit";
}

/**
 * Whether saving the form should return to the read-only view.
 * True only when this was an edit of an existing profile (first-time setup
 * navigates away to the dashboard instead).
 */
export function shouldReturnToViewAfterSave(hadProfile: boolean): boolean {
  return hadProfile;
}

// ---- Read-only summary formatting ------------------------------------------

const SEX_LABEL: Record<Sex, string> = {
  male: "男性",
  female: "女性",
  other: "その他",
};

const BODY_TYPE_LABEL: Record<BodyType, string> = {
  slim: "細身",
  average: "標準",
  muscular: "筋肉質",
  heavy: "がっしり",
};

const ACTIVITY_LABEL: Record<ActivityLevel, string> = {
  sedentary: "ほぼ運動なし",
  light: "軽い運動",
  moderate: "中程度",
  active: "活発",
  very_active: "非常に活発",
};

const GOAL_LABEL: Record<Goal, string> = {
  lose_fat: "減量",
  maintain: "維持",
  gain_muscle: "増量",
};

export function sexLabel(sex: Sex): string {
  return SEX_LABEL[sex];
}
export function bodyTypeLabel(t: BodyType): string {
  return BODY_TYPE_LABEL[t];
}
export function activityLabel(a: ActivityLevel): string {
  return ACTIVITY_LABEL[a];
}
export function goalLabel(g: Goal): string {
  return GOAL_LABEL[g];
}

/**
 * The display name, or a neutral fallback when the user hasn't set one.
 * Trims whitespace; blank names fall back. Kept here (not in the component) so
 * it's testable.
 */
export function displayName(profile: Pick<Profile, "name">): string {
  const n = profile.name?.trim();
  return n ? n : "あなた";
}

/** First grapheme of the display name, for an avatar fallback initial. */
export function avatarInitial(profile: Pick<Profile, "name">): string {
  return Array.from(displayName(profile))[0] ?? "あ";
}
