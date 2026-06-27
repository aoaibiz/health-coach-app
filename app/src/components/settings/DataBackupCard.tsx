"use client";

import { useRef, useState } from "react";
import { exportToJson, importFromJson } from "@/lib/syncData";

/**
 * データの書き出し / 取り込み — an interim, fully-offline safety net against
 * data loss. 「書き出す」 downloads ALL local data (食事・筋トレ・体重・プロフィール・
 * コーチ設定・チャット) as one JSON file; 「取り込む」 MERGES a previously-exported
 * file back in (union — it can only ADD records, never overwrite/delete what's
 * already on the device). Works with no network and no login, so even when the
 * server sync is unavailable the user can keep + restore their own copy.
 */
export function DataBackupCard() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const handleExport = () => {
    try {
      const json = exportToJson();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `health-app-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setNotice({ kind: "ok", text: "データを書き出しました。安全な場所に保管してください。" });
    } catch {
      setNotice({ kind: "err", text: "書き出しに失敗しました。" });
    }
  };

  const handleImportClick = () => {
    setNotice(null);
    fileRef.current?.click();
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so re-selecting the same file fires onChange again.
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const result = importFromJson(text);
      if (result.ok) {
        setNotice({
          kind: "ok",
          text: `データを取り込みました（${result.merged.length}項目をマージ）。既存の記録は消えません。`,
        });
      } else {
        setNotice({ kind: "err", text: result.reason ?? "取り込みに失敗しました。" });
      }
    } catch {
      setNotice({ kind: "err", text: "ファイルを読み込めませんでした。" });
    }
  };

  return (
    <div className="surface p-5">
      <h2 className="text-sm font-bold text-slate-700 dark:text-navy-100">データの書き出し / 取り込み</h2>
      <p className="mt-1 text-xs text-slate-500 dark:text-navy-300">
        食事・筋トレ・体重・プロフィール・コーチ設定・チャットを1つのファイルに保存できます。
        機種変更やブラウザのデータ消去に備えて、ときどき書き出しておくと安心です。
        取り込みは既存の記録に<strong>追加</strong>するだけで、消えることはありません。
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={handleExport} className="btn-primary px-4 py-2">
          データを書き出す
        </button>
        <button
          type="button"
          onClick={handleImportClick}
          className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-navy-700 dark:text-navy-100 dark:hover:bg-navy-800"
        >
          データを取り込む
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          onChange={handleFile}
          className="hidden"
        />
      </div>

      {notice && (
        <p
          className={`mt-3 text-xs ${
            notice.kind === "ok"
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-rose-600 dark:text-rose-400"
          }`}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}
