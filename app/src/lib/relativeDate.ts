// Relative-date parsing for chat logging (Feature ②) — "これ昨日の分で記入して".
//
// THE PROBLEM IT FIXES: a chat-logged meal/workout always landed on TODAY, so a
// late-night "これ昨日の分で" couldn't be recorded on the right day. This resolves a
// relative-date phrase in the user's message to a concrete dateKey, so the
// auto-log can target that day. The SAFE DEFAULT is unchanged: an ambiguous /
// absent date → null → the caller logs today exactly as before (no surprise
// back-dating). Pure + framework-free so it's unit-tested with no DOM/clock.

import { shiftDateKey, toDateKey } from "./date";

/**
 * The recognised relative-day markers, MOST-SPECIFIC FIRST (so 一昨々日/さきおととい
 * beats 一昨日 beats 昨日). Each maps a matching regex to a day OFFSET from today.
 * Shared by every resolver below so the marker set can never drift between the
 * whole-message and the per-block (kind-aware) paths. Future days (明日) are NOT
 * here — you can't have eaten/done something tomorrow.
 */
const DAY_MARKERS: Array<{ re: RegExp; offset: number }> = [
  { re: /一昨昨日|一昨々日|さきおととい/, offset: -3 },
  { re: /一昨日|おととい|おとつい/, offset: -2 },
  { re: /昨日|きのう|キノウ|前日/, offset: -1 },
  { re: /今日|きょう|本日/, offset: 0 },
];

/** A logging/recording instruction (vs a passing mention). The "…分" form
 *  ("昨日の分で") is canonical, plus the common record verbs. */
const LOG_INTENT_RE = /記録|記入|登録|つけ|付け|入れ|メモ|分(?:で|として|に)?|として記|に記/;

/**
 * Resolve an EXPLICIT relative day from the message, or null when none is named
 * (→ caller uses today, the safe default). Recognised, in priority order:
 *   - 一昨日 / おととい / 一昨昨日(さきおととい) → −2 / −3 days
 *   - 昨日 / きのう / 前日 → −1 day
 *   - 今日 / きょう / 本日 → 0 (explicit today)
 * Deliberately CONSERVATIVE: it requires a clear day word, and only fires when the
 * message also signals a logging/recording intent (記録/記入/登録/つけて/入れて/
 * メモ/分) so a casual mention ("昨日は食べすぎた") never silently back-dates a log.
 * Future days (明日) are NOT supported for logging (you can't have eaten tomorrow).
 */
export function resolveRelativeDateKey(
  text: string,
  now: Date = new Date(),
): string | null {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return null;
  if (!LOG_INTENT_RE.test(t)) return null;

  const todayKey = toDateKey(now);
  for (const { re, offset } of DAY_MARKERS) {
    if (re.test(t)) return shiftDateKey(todayKey, offset);
  }
  return null;
}

// ---------------------------------------------------------------------------
// PER-BLOCK (kind-aware) relative-date resolution.
//
// A single chat turn can log SEVERAL kinds at once ("昨日の夕食と今日の筋トレ").
// Applying ONE whole-message date to every block would mis-backdate the others
// (the 昨日 from the meal phrase would drag the 今日 workout to yesterday). So the
// auto-log resolves EACH block's date from its OWN wording: we find the day word
// that GOVERNS that kind's phrase (in Japanese the date word precedes the noun:
// "昨日の/夕食"), and only fall back to today when the kind has no nearby day word.
// When the message carries CONFLICTING day words that we can't safely attribute to
// the kind, we report `ambiguous` so the caller can confirm instead of guessing.
// ---------------------------------------------------------------------------

/** The block kinds the chat can auto-log; each has its own keyword vocabulary. */
export type LogKind = "meal" | "workout" | "sleep";

/** Per-kind keyword regexes used to locate WHERE that kind is mentioned, so a day
 *  word can be attributed to the right block. Kept broad but kind-specific. */
const KIND_KEYWORDS: Record<LogKind, RegExp> = {
  meal: /食事|朝食|昼食|夕食|夜食|朝ご?飯|昼ご?飯|夜ご?飯|晩ご?飯|間食|おやつ|食べ|飲ん|ランチ|ディナー|献立|メニュー/g,
  workout: /筋トレ|トレーニング|運動|ワークアウト|ジム|ベンチ|スクワット|デッドリフト|腹筋|腕立て|懸垂|ランニング|ジョギング|走っ|歩い|ウォーキング|有酸素|セット|レップ/g,
  sleep: /睡眠|就寝|起床|寝た|寝て|寝る|眠っ|眠り|起き|寝落ち/g,
};

/** All day-marker matches in the text, as {index, offset}, in occurrence order.
 *  DAY_MARKERS is scanned MOST-SPECIFIC FIRST, and a less-specific marker that
 *  overlaps the span of an already-found more-specific one is DROPPED — so 一昨日
 *  (−2) does not also register the 昨日 (−1) it contains (which would mis-attribute
 *  a nearby phrase to yesterday instead of two days ago). */
function findDayMarkers(t: string): Array<{ index: number; end: number; offset: number }> {
  const spans: Array<{ start: number; end: number; offset: number }> = [];
  for (const { re, offset } of DAY_MARKERS) {
    // Each DAY_MARKERS regex is non-global; scan all of its matches.
    const g = new RegExp(re.source, "g");
    let m: RegExpExecArray | null;
    while ((m = g.exec(t)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      // Skip a match that overlaps an already-recorded (more-specific) span.
      const overlaps = spans.some((s) => start < s.end && end > s.start);
      if (!overlaps) spans.push({ start, end, offset });
      if (m.index === g.lastIndex) g.lastIndex++; // guard against zero-width loops
    }
  }
  return spans
    .map((s) => ({ index: s.start, end: s.end, offset: s.offset }))
    .sort((a, b) => a.index - b.index);
}

/** Indices where the kind is mentioned in the text (keyword start positions). */
function findKindIndices(t: string, kind: LogKind): number[] {
  const out: number[] = [];
  const re = new RegExp(KIND_KEYWORDS[kind].source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    out.push(m.index);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

/** The set of DISTINCT day offsets present anywhere in the text. */
function distinctOffsets(markers: Array<{ offset: number }>): Set<number> {
  return new Set(markers.map((m) => m.offset));
}

/**
 * A day word can describe the SOURCE being copied ("一昨日と同じメニュー") rather
 * than the day to SAVE TO. Those markers must not backdate the new record. We
 * detect the common adjacent forms:
 *   - 昨日と同じ / 昨日と一緒 / 昨日同様
 *   - 昨日のと同じ / 昨日のメニューと同じ
 * Kept local to the resolver: the full food copy still belongs to the coach /
 * meal-log block; this only prevents the SAVE DATE from being stolen by the
 * source date.
 */
function isSourceComparisonMarker(
  t: string,
  marker: { index: number; end: number },
): boolean {
  const after = t.slice(marker.end, marker.end + 18);
  return /^(?:の)?(?:[^、。,.，．\s]{0,8})?(?:と)?(?:同じ|おなじ|一緒|いっしょ|同様)/.test(after);
}

/**
 * Explicit record-target phrases outrank kind proximity:
 *   - 昨日の記録として / 昨日の分として / 昨日の日付で
 *   - 昨日として記録 / 昨日に記録
 *
 * This is the key distinction for "昨日の記録として、一昨日と同じメニュー": yesterday
 * is the target day, while two-days-ago is merely the source template.
 */
function findExplicitRecordTargetMarkers(
  t: string,
  markers: Array<{ index: number; end: number; offset: number }>,
): Array<{ index: number; end: number; offset: number }> {
  return markers.filter((m) => {
    const after = t.slice(m.end, m.end + 16);
    return /^(?:の)?(?:記録|分|日付)(?:として|で|に)?/.test(after) || /^(?:として|に)記録/.test(after);
  });
}

export interface KindDateResolution {
  /** Resolved date key for this kind, or null → caller uses today (safe default). */
  dateKey: string | null;
  /**
   * True when the message has conflicting day words that we could NOT safely
   * attribute to this kind (so the caller should confirm rather than auto-save to
   * a possibly-wrong day). False for the unambiguous cases (no day word, a single
   * consistent day word, or a day word clearly governing this kind's phrase).
   */
  ambiguous: boolean;
}

/**
 * Resolve the relative date for ONE block kind from the user's message.
 *
 * Rules (conservative, anti-mis-backdate):
 *   1. No logging intent OR no day word at all → today (dateKey null, not ambiguous).
 *   2. Exactly ONE distinct day word in the whole message → that day (it applies to
 *      whatever is being logged; no conflict possible). Preserves the original
 *      single-intent behaviour ("これ昨日の分で記入して").
 *   3. MULTIPLE distinct day words (conflict): attribute by PROXIMITY — the day
 *      word that most-closely PRECEDES (Japanese order) a keyword of THIS kind wins
 *      (fallback: the nearest day word on either side). If this kind has NO keyword
 *      in the message, we will NOT drag another block's day onto it → today, and we
 *      flag `ambiguous` so the caller can confirm. If the nearest day words around
 *      the kind's keyword themselves disagree, we also flag `ambiguous`.
 */
export function resolveRelativeDateKeyForKind(
  text: string,
  kind: LogKind,
  now: Date = new Date(),
): KindDateResolution {
  const t = typeof text === "string" ? text.trim() : "";
  const todayKey = toDateKey(now);
  if (!t || !LOG_INTENT_RE.test(t)) return { dateKey: null, ambiguous: false };

  const markers = findDayMarkers(t);
  if (markers.length === 0) return { dateKey: null, ambiguous: false };

  const resolutionMarkers = markers.filter((m) => !isSourceComparisonMarker(t, m));
  if (resolutionMarkers.length === 0) return { dateKey: null, ambiguous: false };

  const removedSourceMarker = resolutionMarkers.length !== markers.length;
  const offsets = distinctOffsets(resolutionMarkers);

  const explicitTargets = findExplicitRecordTargetMarkers(t, resolutionMarkers);
  if (explicitTargets.length > 0 && offsets.size === 1) {
    const targetOffsets = distinctOffsets(explicitTargets);
    if (targetOffsets.size === 1) {
      const offset = [...targetOffsets][0];
      return { dateKey: shiftDateKey(todayKey, offset), ambiguous: false };
    }
    return { dateKey: null, ambiguous: true };
  }
  // (2) A single consistent day word governs the whole message — no conflict.
  if (!removedSourceMarker && offsets.size === 1) {
    return { dateKey: shiftDateKey(todayKey, resolutionMarkers[0].offset), ambiguous: false };
  }

  // (3) Conflicting day words. Attribute to THIS kind by proximity to its keyword.
  const kindIdx = findKindIndices(t, kind);
  if (kindIdx.length === 0) {
    // This kind isn't named, but the message backdates SOMETHING — don't guess a
    // day for it; default to today and let the caller confirm (anti-mis-record).
    return { dateKey: null, ambiguous: true };
  }

  // For each keyword occurrence of this kind, pick the day word that best governs
  // it: the closest marker that PRECEDES the keyword (Japanese: "昨日の夕食"); if
  // none precedes, the closest following marker. Collect the chosen offsets.
  const chosen = new Set<number>();
  for (const ki of kindIdx) {
    let best: { dist: number; offset: number; preceding: boolean } | null = null;
    for (const mk of resolutionMarkers) {
      const preceding = mk.index <= ki;
      const dist = Math.abs(ki - mk.index);
      // Prefer a preceding marker over a following one at equal distance; among the
      // same side, the closer wins.
      if (
        best === null ||
        (preceding && !best.preceding) ||
        (preceding === best.preceding && dist < best.dist)
      ) {
        best = { dist, offset: mk.offset, preceding };
      }
    }
    if (best) chosen.add(best.offset);
  }

  // If every occurrence of this kind resolved to the SAME day → use it (confident).
  if (chosen.size === 1) {
    const offset = [...chosen][0];
    return { dateKey: shiftDateKey(todayKey, offset), ambiguous: false };
  }
  // The kind's own occurrences disagree → don't guess; today + confirm.
  return { dateKey: null, ambiguous: true };
}

/**
 * A short, honest note appended to the coach bubble when a chat log was recorded
 * for a PAST day (so the user can see it didn't land on today). Empty string when
 * the date is today / null (no note needed). Pure.
 */
export function backdatedNote(dateKey: string | null, now: Date = new Date()): string {
  if (!dateKey) return "";
  const todayKey = toDateKey(now);
  if (dateKey === todayKey) return "";
  return `（${dateKey} の記録として保存しました）`;
}

/**
 * The note appended (instead of auto-saving) when the message's relative date is
 * AMBIGUOUS for a block — e.g. several day words for several block kinds that we
 * can't safely attribute. We ask the user to confirm the day rather than risk
 * recording it on the wrong date (anti-mis-record; per the Major-2 fix). Pure.
 */
export function ambiguousDateNote(): string {
  return "（どの日の記録か曖昧だったので、まだ保存していません。例: 「昨日の夕食」「今日の筋トレ」のように日付を分けて教えてください。）";
}
