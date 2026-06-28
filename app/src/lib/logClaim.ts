// Detect a FALSE "recorded it" claim in the coach's prose (Task 1 — recording
// reliability).
//
// THE BUG THIS GUARDS AGAINST: the chat coach is instructed to say something
// like "食事に登録しておきました" in prose AND append a «MEAL_LOG»/«WORKOUT_LOG»
// sentinel block the app actually parses into a saved record. The two are
// independent: a model that writes the prose claim but FORGETS the block (or
// emits a malformed one that parses to nothing) leaves the user reading
// "記録しました" while NOTHING was saved. The coach itself has been observed to
// later admit "実際には記録ブロックが付いていなかったので反映されていませんでした".
//
// This module is the client-side detector for that mismatch. It is PURE (no DOM,
// no network) so it's unit-tested in isolation, and it only inspects the prose
// the user will actually SEE (the sentinel block is already stripped upstream by
// parseCoachReply / parseWorkoutReply). The caller (ChatProvider) cross-checks the
// detector against whether a record was REALLY produced, and — when the coach
// claimed a save that didn't happen — rewrites the bubble to be honest and
// withholds the "記録しました" chip. The user-visible guarantee becomes:
//
//   IF the app shows "記録しました" (chip or unedited claim) → a record EXISTS.
//
// We never fabricate to make the claim true (no calorie invention); we make the
// MESSAGE honest instead, and ask the user to restate so a grounded record can
// be produced on the next turn.

/**
 * Phrases that, in the coach's prose, assert a COMPLETED save of a meal/workout.
 * Matched loosely (substring) because the model phrases it many ways. These are
 * the "past/perfective" forms the AUTO_LOG_PROTOCOL tells the coach to use when it
 * appends the block ("登録しておきました" / "記録しておきました" / "記録しました" …).
 *
 * IMPORTANT — these are COMPLETED-action claims only. We deliberately do NOT
 * include:
 *   - future/offer forms ("記録しておきますね" / "記録します" without 〜ました) — the
 *     coach is saying it WILL, on a later confirmed turn, not that it just did;
 *   - negated forms ("記録できませんでした" / "記録していません") — already honest;
 *   - questions ("記録しますか？").
 * Including only the perfective completed forms keeps the detector from firing on
 * an honest "I'll log it once you confirm" rally turn (which correctly carries no
 * block yet).
 */
const COMPLETED_SAVE_CLAIM_PATTERNS: RegExp[] = [
  // 記録/登録 + (best-effort おき) + ました/ましたよ/ました！  → "(it) has been recorded/registered"
  /(記録|登録)し(て(おき|あり))?まし(た|たよ)/,
  // 〜を記録／登録済み／済みです
  /(記録|登録)済み/,
  // 反映しておきました / 反映しました（"reflected it into your log"）
  /反映し(て(おき|あり))?まし(た|たよ)/,
];

const COMPLETED_CORRECTION_CLAIM_PATTERNS: RegExp[] = [
  // 修正/訂正/変更/直しました — same risk as a save claim: if no structured
  // block was applied, the stored value did NOT change.
  /(修正|訂正|変更)し(て(おき|あり))?まし(た|たよ)/,
  /直し(て(おき|あり))?まし(た|たよ)/,
];

/**
 * Patterns that make a "claim" actually HONEST/non-assertive even though they
 * contain 記録/登録. If any of these is present we treat the prose as NOT claiming
 * a completed save, so we never "correct" an already-honest message. Covers
 * negation (できませんでした / されていません / 失敗) and explicit future-tense offers
 * that slipped a ました nearby ("確定したら記録しておきますね" is future → no 〜ました,
 * already excluded; this list catches the negated/failed cases).
 */
const HONEST_OR_NEGATED_PATTERNS: RegExp[] = [
  /記録(でき|され|し)て?(い)?ませ(ん|んでした)/, // 記録できません / 記録されていません / 記録していません
  /登録(でき|され|し)て?(い)?ませ(ん|んでした)/,
  /修正(でき|され|し)て?(い)?ませ(ん|んでした)/,
  /訂正(でき|され|し)て?(い)?ませ(ん|んでした)/,
  /変更(でき|され|し)て?(い)?ませ(ん|んでした)/,
  /直し(て)?(い)?ませ(ん|んでした)/,
  /(記録|登録|反映)(でき|され)ませんでした/,
  /(修正|訂正|変更|直すこと)(でき|され)ませんでした/,
  /(記録|登録|反映|修正|訂正|変更)に失敗/,
  /(記録|登録|反映|修正|訂正|変更)できなかった/,
];

/**
 * True when the coach's (already block-stripped) prose asserts it COMPLETED a
 * meal/workout save. Returns false for honest/negated/future phrasing, so it only
 * flags the dangerous "I saved it" claim. Pure — safe to call on every reply.
 */
export function claimsCompletedLog(prose: string): boolean {
  if (typeof prose !== "string" || !prose) return false;
  // An explicitly honest/negated statement is never a false claim.
  if (HONEST_OR_NEGATED_PATTERNS.some((re) => re.test(prose))) return false;
  return (
    COMPLETED_SAVE_CLAIM_PATTERNS.some((re) => re.test(prose)) ||
    COMPLETED_CORRECTION_CLAIM_PATTERNS.some((re) => re.test(prose))
  );
}

export function claimsCompletedCorrection(prose: string): boolean {
  if (typeof prose !== "string" || !prose) return false;
  if (HONEST_OR_NEGATED_PATTERNS.some((re) => re.test(prose))) return false;
  return COMPLETED_CORRECTION_CLAIM_PATTERNS.some((re) => re.test(prose));
}

/**
 * The honest note appended to the bubble when the coach CLAIMED a save but no
 * grounded record was actually produced this turn. It does not blame the user; it
 * states plainly that nothing was saved and asks them to restate so the app can
 * produce a real, grounded record next turn. Kept as an exported constant so the
 * UI copy is testable and consistent.
 */
export const UNSAVED_CLAIM_NOTICE =
  "（ごめんなさい、システムの都合で今の内容はまだ記録できていません。修正依頼の場合も、保存値はまだ変わっていません。お手数ですが、記録・修正したい食事や運動の内容（品目と量／種目・回数など）をもう一度教えてください。次のお返事できちんと反映します。）";

/**
 * Make a coach reply HONEST when it claimed a completed save that did not happen.
 * - When the prose claimed a save AND no record was produced → append the
 *   UNSAVED_CLAIM_NOTICE so the user is never told "記録しました" falsely.
 * - Otherwise (no false claim, or a record WAS produced) → return the prose
 *   unchanged.
 *
 * Pure: the caller passes whether a record was actually produced this turn
 * (`recorded`); this never inspects storage itself. It deliberately does NOT try
 * to delete/alter the original claim text (which can be arbitrary prose) — it
 * appends a clear correction, the least-surprising honest fix.
 */
export function reconcileLogClaim(prose: string, recorded: boolean): string {
  if (recorded) return prose; // claim is true (a record exists) → leave as-is.
  if (!claimsCompletedLog(prose)) return prose; // no false claim → leave as-is.
  const base = typeof prose === "string" ? prose.trim() : "";
  return base ? `${base}\n\n${UNSAVED_CLAIM_NOTICE}` : UNSAVED_CLAIM_NOTICE;
}

export function reconcileLogClaimWithFailedCorrection(
  prose: string,
  recorded: boolean,
  failedCorrection: boolean,
): string {
  const correctionClaimWasNotApplied =
    failedCorrection && claimsCompletedCorrection(prose);
  return reconcileLogClaim(prose, correctionClaimWasNotApplied ? false : recorded);
}
