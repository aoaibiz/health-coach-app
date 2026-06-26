"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  MEAL_TYPES,
  type Meal,
  type MealItem,
  type MealNutrition,
  type MealType,
} from "@/lib/types";
import { makeId, toDateKey } from "@/lib/date";
import { compressImage } from "@/lib/image";
import { analyzeMeal, blobToBase64, hasApiKey } from "@/lib/analyzeMeal";
import { itemsToNutrition } from "@/lib/mealItems";
import { deletePhoto, getPhoto, putPhoto } from "@/lib/photoStore";
import { MealItemsEditor } from "./MealItemsEditor";
import { CameraIcon, CloseIcon, TrashIcon } from "../icons";

/** Metadata from an AI estimate, attached to the saved nutrition for transparency. */
interface EstimateMeta {
  source?: string;
  confidence?: MealNutrition["confidence"];
  generatedBy?: string;
  /** True when the total includes a 推定値/ラベル値 (not all 公式DB). */
  estimated?: boolean;
  /** Dominant source backing the total (db | label | estimate). */
  sourceKind?: MealNutrition["sourceKind"];
}

/** Parse the four optional nutrition inputs into a MealNutrition (or undefined). */
function buildNutrition(
  cal: string,
  protein: string,
  fat: string,
  carb: string,
  meta?: EstimateMeta,
): MealNutrition | undefined {
  const num = (s: string): number | undefined => {
    if (s.trim() === "") return undefined;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const n: MealNutrition = {
    calories: num(cal),
    proteinG: num(protein),
    fatG: num(fat),
    carbG: num(carb),
  };
  const hasAny = Object.values(n).some((v) => v != null);
  if (!hasAny) return undefined;
  // Only carry estimate provenance when an AI estimate produced these numbers.
  if (meta) {
    if (meta.source) n.source = meta.source;
    if (meta.confidence) n.confidence = meta.confidence;
    if (meta.generatedBy) n.generatedBy = meta.generatedBy;
    if (meta.estimated != null) n.estimated = meta.estimated;
    if (meta.sourceKind) n.sourceKind = meta.sourceKind;
  }
  return n;
}

/** Per-source badge label shown next to the AI estimate. */
const SOURCE_BADGE: Record<NonNullable<MealNutrition["sourceKind"]>, string> = {
  db: "公式DB",
  label: "ラベル値",
  estimate: "推定値・参考",
};

const CONFIDENCE_LABEL: Record<NonNullable<MealNutrition["confidence"]>, string> = {
  low: "確信度: 低",
  medium: "確信度: 中",
  high: "確信度: 高",
};

interface Props {
  /** Selected calendar day this meal belongs to. */
  date: string;
  /** When editing, the existing meal; when adding, null. */
  existing: Meal | null;
  /** Default meal type for a brand-new entry. */
  defaultType?: MealType;
  onClose: () => void;
  onSave: (meal: Meal) => void;
}

export function MealEditor({
  date,
  existing,
  defaultType = "朝",
  onClose,
  onSave,
}: Props) {
  const [type, setType] = useState<MealType>(existing?.type ?? defaultType);
  const [text, setText] = useState(existing?.text ?? "");
  const [photoIds, setPhotoIds] = useState<string[]>(() =>
    existing?.photoIds && existing.photoIds.length > 0
      ? existing.photoIds
      : existing?.photoId
        ? [existing.photoId]
        : [],
  );
  const photoId = photoIds[0];
  const [previewUrls, setPreviewUrls] = useState<Array<{ id: string; url: string }>>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Optional manual nutrition (kept as input strings; parsed on save).
  const toStr = (n?: number | null) => (n != null ? String(n) : "");
  const [cal, setCal] = useState(toStr(existing?.nutrition?.calories));
  const [protein, setProtein] = useState(toStr(existing?.nutrition?.proteinG));
  const [fat, setFat] = useState(toStr(existing?.nutrition?.fatG));
  const [carb, setCarb] = useState(toStr(existing?.nutrition?.carbG));
  const [showNutrition, setShowNutrition] = useState(
    existing?.nutrition != null &&
      Object.values(existing.nutrition).some((v) => v != null),
  );

  // Phase 4 — per-item breakdown. Populated by AI解析 or from an edited meal that
  // already carries items; the user fine-tunes grams/qty and the total recomputes.
  const [items, setItems] = useState<MealItem[]>(existing?.nutrition?.items ?? []);

  // AI 解析の状態。estimateMeta は保存時に nutrition へ添付（透明性）。
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  // アクセスキーの有無。AI解析を解錠する鍵が未設定なら、タップで失敗させずヒントを出す。
  // 手入力は鍵なしでも使える。プロフィールで設定後に戻ってきたら focus/storage で更新。
  const [hasKey, setHasKey] = useState(true);
  useEffect(() => {
    setHasKey(hasApiKey());
    const refresh = () => setHasKey(hasApiKey());
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  const [estimateMeta, setEstimateMeta] = useState<EstimateMeta | undefined>(() => {
    const n = existing?.nutrition;
    if (n && (n.source || n.confidence || n.generatedBy)) {
      return {
        source: n.source,
        confidence: n.confidence,
        generatedBy: n.generatedBy,
        estimated: n.estimated,
        sourceKind: n.sourceKind,
      };
    }
    return undefined;
  });

  async function handleAnalyze() {
    setAnalyzeError(null);
    setAnalyzing(true);
    try {
      // 写真があれば縮小済み Blob を base64 化して送る（送信前に縮小・既存 image.ts 流用）。
      const imageBase64List = (
        await Promise.all(
          photoIds.map(async (id) => {
            const blob = await getPhoto(id);
            return blob ? blobToBase64(blob) : null;
          }),
        )
      ).filter((v): v is string => v != null);
      const nutrition = await analyzeMeal({
        imageBase64List: imageBase64List.length > 0 ? imageBase64List : undefined,
        text: text.trim() || undefined,
      });
      // 成功: 4 項目を埋め、ユーザーは編集・上書き可能。
      setShowNutrition(true);
      setCal(nutrition.calories != null ? String(nutrition.calories) : "");
      setProtein(nutrition.proteinG != null ? String(nutrition.proteinG) : "");
      setFat(nutrition.fatG != null ? String(nutrition.fatG) : "");
      setCarb(nutrition.carbG != null ? String(nutrition.carbG) : "");
      // Per-item breakdown (Phase 4) — drives the editable rows + the live total.
      setItems(nutrition.items ?? []);
      setEstimateMeta({
        source: nutrition.source,
        confidence: nutrition.confidence,
        generatedBy: nutrition.generatedBy,
        estimated: nutrition.estimated,
        sourceKind: nutrition.sourceKind,
      });
    } catch (err) {
      // 失敗/オフライン: 記録は保持され、あとで再解析できる（正直なエラー表示）。
      setAnalyzeError(
        err instanceof Error && err.message
          ? err.message
          : "解析できませんでした。あとで再試行できます。",
      );
    } finally {
      setAnalyzing(false);
    }
  }

  // Photos newly added in this session but not yet committed — track so
  // we can clean them up if the user cancels.
  const stagedPhotoIdsRef = useRef<string[]>([]);

  // Load previews for existing/new photos.
  useEffect(() => {
    let cancelled = false;
    const urls: Array<{ id: string; url: string }> = [];
    Promise.all(
      photoIds.map(async (id) => {
        const blob = await getPhoto(id);
        if (!blob) return null;
        return { id, url: URL.createObjectURL(blob) };
      }),
    ).then((next) => {
      if (cancelled) {
        next.forEach((entry) => {
          if (entry) URL.revokeObjectURL(entry.url);
        });
        return;
      }
      urls.push(...next.filter((entry): entry is { id: string; url: string } => entry != null));
      setPreviewUrls(urls);
    });
    return () => {
      cancelled = true;
      urls.forEach((entry) => URL.revokeObjectURL(entry.url));
    };
  }, [photoIds]);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-selecting same file(s)
    if (files.length === 0) return;
    setBusy(true);
    try {
      const nextIds: string[] = [];
      for (const file of files) {
        const blob = await compressImage(file);
        const id = makeId();
        await putPhoto(id, blob);
        nextIds.push(id);
      }
      stagedPhotoIdsRef.current = [...stagedPhotoIdsRef.current, ...nextIds];
      setPhotoIds((prev) => [...prev, ...nextIds]);
    } finally {
      setBusy(false);
    }
  }

  async function removePhoto(id: string) {
    const existingPhotoIds = new Set([
      ...(existing?.photoIds ?? []),
      ...(existing?.photoId ? [existing.photoId] : []),
    ]);
    if (!existingPhotoIds.has(id)) {
      await deletePhoto(id).catch(() => undefined);
    }
    stagedPhotoIdsRef.current = stagedPhotoIdsRef.current.filter((photoId) => photoId !== id);
    setPhotoIds((prev) => prev.filter((photoId) => photoId !== id));
  }

  function handleClose() {
    // Discard staged photos that were never saved.
    stagedPhotoIdsRef.current.forEach((id) => {
      deletePhoto(id).catch(() => undefined);
    });
    stagedPhotoIdsRef.current = [];
    onClose();
  }

  function handleSave() {
    const trimmed = text.trim();
    if (!trimmed && !photoId) return; // need at least text or a photo

    // When per-item rows exist, the saved nutrition is the SUM of those edited
    // items (the dashboard intake uses this final total). Otherwise fall back to
    // the flat manual fields. The DB-source string + generatedBy are preserved.
    const nutrition =
      items.length > 0
        ? itemsToNutrition(items, {
            source: estimateMeta?.source,
            generatedBy: estimateMeta?.generatedBy,
          })
        : buildNutrition(cal, protein, fat, carb, estimateMeta);
    const now = new Date();
    const nextPhotoIds = photoIds.length > 0 ? photoIds : undefined;
    const nextPhotoId = nextPhotoIds?.[0];
    const previousPhotoIds = new Set([
      ...(existing?.photoIds ?? []),
      ...(existing?.photoId ? [existing.photoId] : []),
    ]);
    previousPhotoIds.forEach((id) => {
      if (!photoIds.includes(id)) deletePhoto(id).catch(() => undefined);
    });
    const meal: Meal = existing
      ? { ...existing, type, text: trimmed, photoId: nextPhotoId, photoIds: nextPhotoIds, nutrition }
      : {
          id: makeId(),
          date,
          timestamp:
            date === toDateKey() ? now.toISOString() : `${date}T12:00:00.000Z`,
          type,
          text: trimmed,
          photoId: nextPhotoId,
          photoIds: nextPhotoIds,
          nutrition,
        };
    stagedPhotoIdsRef.current = []; // committed
    onSave(meal);
  }

  const canSave = text.trim() !== "" || !!photoId;

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="閉じる"
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm dark:bg-black/60"
        onClick={handleClose}
      />

      {/* Sheet — capped to the viewport and internally scrollable so a tall meal
          (many items / long text) can always be scrolled instead of overflowing
          off-screen. dvh tracks the mobile browser chrome (address bar) correctly. */}
      <div className="relative max-h-[90dvh] w-full max-w-md overflow-y-auto overscroll-contain rounded-t-3xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl dark:bg-navy-900 animate-[slideup_0.22s_ease-out]">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold">
            {existing ? "記録を編集" : "食事を記録"}
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="btn-ghost px-2 py-2"
            aria-label="閉じる"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Meal type chips */}
        <div className="mb-4 grid grid-cols-4 gap-2">
          {MEAL_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={`chip ${
                type === t
                  ? "bg-accent text-white"
                  : "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-navy-200"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Text */}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="食べたもの・飲んだもの（例: 鶏むね肉とサラダ、プロテイン）"
          className="field mb-4 resize-none"
        />

        {/* Photo */}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleFile}
        />
        {previewUrls.length > 0 && (
          <div className="mb-3 grid grid-cols-2 gap-2">
            {previewUrls.map(({ id, url }) => (
              <div key={id} className="relative overflow-hidden rounded-xl">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt="食事の写真"
                  className="h-32 w-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => void removePhoto(id)}
                  className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm active:scale-95"
                  aria-label="写真を削除"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="mb-4 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 py-4 text-sm font-medium text-slate-500 transition hover:bg-slate-50 disabled:opacity-50 dark:border-navy-700 dark:text-navy-300 dark:hover:bg-navy-800"
        >
          <CameraIcon className="h-5 w-5" />
          {busy ? "処理中…" : previewUrls.length > 0 ? "写真をさらに追加" : "写真を追加"}
        </button>

        {/* AI 解析 — 写真/テキストから栄養を推定（MEXT DB 接地）。手入力は併存。 */}
        <div className="mb-3">
          <button
            type="button"
            onClick={() => void handleAnalyze()}
            disabled={analyzing || busy || !hasKey || (text.trim() === "" && !photoId)}
            className="btn-ghost w-full justify-center gap-2 border border-accent/30 py-2.5 text-accent disabled:opacity-50 dark:border-accent-light/30 dark:text-accent-light"
          >
            {analyzing ? "解析中…" : "✨ AI解析（カロリー・PFCを推定）"}
          </button>
          {!hasKey && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500 dark:text-navy-300">
              AI解析を使うには「アクセスキー」が必要です。
              <Link
                href="/profile"
                className="ml-1 font-medium text-accent underline dark:text-accent-light"
              >
                プロフィールで設定
              </Link>
              （カロリーは下の欄に手入力でも記録できます）
            </p>
          )}
          {analyzeError && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-rose-500 dark:text-rose-400">
              {analyzeError}（記録は保存できます・あとで再解析できます）
            </p>
          )}
          {estimateMeta && (estimateMeta.source || estimateMeta.sourceKind) && !analyzeError && (
            <div className="mt-2 space-y-1.5">
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                {estimateMeta.sourceKind && (
                  <span
                    className={`rounded-md px-2 py-0.5 font-semibold ${
                      estimateMeta.sourceKind === "db"
                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300"
                        : estimateMeta.sourceKind === "label"
                          ? "bg-sky-100 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300"
                          : "bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300"
                    }`}
                  >
                    {SOURCE_BADGE[estimateMeta.sourceKind]}
                  </span>
                )}
                {estimateMeta.confidence && (
                  <span className="text-slate-400 dark:text-navy-400">
                    {CONFIDENCE_LABEL[estimateMeta.confidence]}
                  </span>
                )}
                {estimateMeta.source && (
                  <span className="text-slate-400 dark:text-navy-400">（{estimateMeta.source}）</span>
                )}
              </div>
              {estimateMeta.estimated && (
                <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                  ※AIの推定です。正確ではありません。編集できます。
                </p>
              )}
              <p className="text-[11px] leading-relaxed text-slate-400 dark:text-navy-400">
                医療アドバイスではありません。
              </p>
            </div>
          )}
        </div>

        {/* Per-item breakdown (Phase 4) — editable grams/qty + live total. Shown
            after AI解析 or when editing an item-backed meal; the meal's saved
            total is the sum of these items. */}
        {items.length > 0 && (
          <MealItemsEditor items={items} onChange={setItems} />
        )}

        {/* Optional flat nutrition — manual entry (no per-item breakdown). When
            items exist the breakdown above is the source of truth, so the flat
            fields are hidden to avoid a conflicting second total. */}
        {items.length === 0 &&
          (showNutrition ? (
            <div className="mb-4 rounded-xl border border-slate-200 p-3 dark:border-navy-700">
              <div className="mb-2.5 flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-700 dark:text-navy-100">
                  栄養（任意）
                </span>
                <span className="text-[11px] text-slate-400 dark:text-navy-400">
                  自己申告・推定
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <NutriField label="カロリー" unit="kcal" value={cal} onChange={setCal} />
                <NutriField label="タンパク質" unit="g" value={protein} onChange={setProtein} />
                <NutriField label="脂質" unit="g" value={fat} onChange={setFat} />
                <NutriField label="炭水化物" unit="g" value={carb} onChange={setCarb} />
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowNutrition(true)}
              className="btn-ghost mb-4 w-full justify-start py-2.5 text-slate-500 dark:text-navy-300"
            >
              ＋ カロリー・PFC を入力（任意）
            </button>
          ))}

        <button
          type="button"
          onClick={handleSave}
          disabled={!canSave || busy}
          className="btn-primary w-full py-3"
        >
          {existing ? "保存" : "記録する"}
        </button>
      </div>

      <style>{`@keyframes slideup{from{transform:translateY(100%)}to{transform:translateY(0)}}`}</style>
    </div>
  );
}

function NutriField({
  label,
  unit,
  value,
  onChange,
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-slate-400 dark:text-navy-300">
        {label}
      </span>
      <div className="relative">
        <input
          type="number"
          inputMode="decimal"
          min={0}
          value={value}
          placeholder="0"
          onChange={(e) => onChange(e.target.value)}
          className="field py-2 pr-10 text-sm"
        />
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400 dark:text-navy-400">
          {unit}
        </span>
      </div>
    </label>
  );
}
