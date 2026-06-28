import { describe, it, expect } from "vitest";
import {
  claimsCompletedCorrection,
  claimsCompletedLog,
  reconcileLogClaim,
  reconcileLogClaimWithFailedCorrection,
  UNSAVED_CLAIM_NOTICE,
} from "./logClaim";

// Task 1 (recording reliability): the detector that catches a coach reply which
// CLAIMS a completed save in prose while no grounded record was actually produced
// — the exact bug Ao reported ("記録しておきました" with no «MEAL_LOG» block, so
// nothing was saved). These are pure tests (no DOM/network).

describe("claimsCompletedLog — flags only COMPLETED-save claims", () => {
  it("flags the perfective forms the protocol tells the coach to use", () => {
    expect(claimsCompletedLog("食事に登録しておきました。")).toBe(true);
    expect(claimsCompletedLog("記録しておきました！")).toBe(true);
    expect(claimsCompletedLog("筋トレを記録しました。お疲れさまでした。")).toBe(true);
    expect(claimsCompletedLog("今日の昼食として登録しましたよ")).toBe(true);
    expect(claimsCompletedLog("カレンダーに反映しておきました。")).toBe(true);
    expect(claimsCompletedLog("もう記録済みです。")).toBe(true);
    expect(claimsCompletedLog("タンパク質量を修正しました。")).toBe(true);
    expect(claimsCompletedLog("プロテインの量を直しました。")).toBe(true);
    expect(claimsCompletedLog("120gから15gに訂正しておきました。")).toBe(true);
  });

  it("can distinguish correction claims from ordinary save claims", () => {
    expect(claimsCompletedCorrection("タンパク質量を修正しました。")).toBe(true);
    expect(claimsCompletedCorrection("プロテインの量を直しました。")).toBe(true);
    expect(claimsCompletedCorrection("食事に登録しておきました。")).toBe(false);
    expect(claimsCompletedCorrection("まだ修正できていません。")).toBe(false);
  });

  it("does NOT flag honest FUTURE / offer phrasing (no false positive on rally turns)", () => {
    // "I'll log it once you confirm" — correctly carries no block yet.
    expect(claimsCompletedLog("分量を教えてもらえたら記録しますね。")).toBe(false);
    expect(claimsCompletedLog("確定したら記録しておきますね。")).toBe(false);
    expect(claimsCompletedLog("食べていたら記録しておきますね。")).toBe(false);
    expect(claimsCompletedLog("これは記録しますか？")).toBe(false);
    expect(claimsCompletedLog("正しい量が分かったら修正しますね。")).toBe(false);
  });

  it("does NOT flag explicitly NEGATED / failed phrasing (already honest)", () => {
    expect(
      claimsCompletedLog("実際には記録ブロックが付いていなかったので記録できていません。"),
    ).toBe(false);
    expect(claimsCompletedLog("ごめんなさい、まだ記録できませんでした。")).toBe(false);
    expect(claimsCompletedLog("この内容は記録されていません。")).toBe(false);
    expect(claimsCompletedLog("記録に失敗しました。")).toBe(false);
    expect(claimsCompletedLog("まだ修正できていません。")).toBe(false);
  });

  it("ignores empty / non-string / unrelated prose", () => {
    expect(claimsCompletedLog("")).toBe(false);
    expect(claimsCompletedLog("今日はよく頑張りましたね！")).toBe(false);
    // @ts-expect-error — defensive: a non-string must not throw.
    expect(claimsCompletedLog(undefined)).toBe(false);
  });
});

describe("reconcileLogClaim — make a false 'recorded' claim honest", () => {
  it("when the prose claims a save but NO record was produced → append the honest notice", () => {
    const prose = "鶏むね肉とごはん、しっかり食事に登録しておきました！";
    const out = reconcileLogClaim(prose, /* recorded */ false);
    expect(out).toContain(prose);
    expect(out).toContain(UNSAVED_CLAIM_NOTICE);
    // The honest notice tells the user it was NOT saved + asks them to restate.
    expect(out).toContain("まだ記録できていません");
  });

  it("also corrects a false completed-correction claim when no record was updated", () => {
    const prose = "プロテインの量を15gに直しました。";
    const out = reconcileLogClaim(prose, /* recorded */ false);
    expect(out).toContain(prose);
    expect(out).toContain(UNSAVED_CLAIM_NOTICE);
  });

  it("when a record WAS produced → leave the (true) claim untouched", () => {
    const prose = "食事に登録しておきました！";
    expect(reconcileLogClaim(prose, /* recorded */ true)).toBe(prose);
  });

  it("when the prose makes NO save claim → leave it untouched even if nothing was recorded", () => {
    // A normal rally/coaching turn that recorded nothing must not get the notice.
    const prose = "いいですね！分量を教えてもらえますか？";
    expect(reconcileLogClaim(prose, false)).toBe(prose);
  });

  it("an already-honest 'could not record' message is NOT double-corrected", () => {
    const prose = "ごめんなさい、今は記録できませんでした。";
    expect(reconcileLogClaim(prose, false)).toBe(prose);
  });

  it("guarantee: notice appears IFF a completed-save claim was made AND nothing was recorded", () => {
    // 4-way truth table over (claims, recorded).
    const claim = "記録しておきました。";
    const noClaim = "頑張りましたね。";
    expect(reconcileLogClaim(claim, false)).toContain(UNSAVED_CLAIM_NOTICE); // claim + not recorded → notice
    expect(reconcileLogClaim(claim, true)).not.toContain(UNSAVED_CLAIM_NOTICE); // claim + recorded → no notice
    expect(reconcileLogClaim(noClaim, false)).not.toContain(UNSAVED_CLAIM_NOTICE); // no claim → no notice
    expect(reconcileLogClaim(noClaim, true)).not.toContain(UNSAVED_CLAIM_NOTICE);
  });

  it("does not let another successful write validate a failed correction claim", () => {
    const prose = "食事は記録しました。プロテインの量も15gに直しました。";
    const out = reconcileLogClaimWithFailedCorrection(
      prose,
      /* recorded */ true,
      /* failedCorrection */ true,
    );

    expect(out).toContain(prose);
    expect(out).toContain(UNSAVED_CLAIM_NOTICE);
  });

  it("keeps a true ordinary save claim when a failed correction was not claimed", () => {
    const prose = "今日の食事は記録しました。プロテインの量は対象を確認してから直します。";
    expect(
      reconcileLogClaimWithFailedCorrection(
        prose,
        /* recorded */ true,
        /* failedCorrection */ true,
      ),
    ).toBe(prose);
  });
});
