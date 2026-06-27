"use client";

import { useCallback, useState } from "react";
import { formatTime } from "@/lib/date";
import { formatNumber } from "@/lib/workout";
import { computeShoppingList } from "@/lib/shoppingList";
import { resolveMealCardImage } from "@/lib/mealCardImage";
import { compressGeneratedMealImageToDataUrl } from "@/lib/image";
import type { Meal } from "@/lib/types";
import { PhotoImage } from "../PhotoImage";
import { MicroNutrientsPanel } from "../nutrition/MicroNutrientsPanel";
import { PencilIcon, TrashIcon } from "../icons";

interface Props {
  meal: Meal;
  onEdit: () => void;
  onDelete: () => void;
  /**
   * Mark a PLANNED meal eaten (AIプランナー 第3陣D — the 「食べた」 button, the twin of
   * the workout 完了). Only supplied/used for a planned meal; absent for an
   * already-eaten one (an eaten meal shows no 「食べた」 button). Calling it flips the
   * meal's status to "eaten" so it starts counting toward 摂取/PFC/達成.
   */
  onEat?: () => void;
  onGenerateImage?: () => void;
  generatingImage?: boolean;
  imageError?: boolean;
  onGeneratedImageDataUrlBackfill?: (dataUrl: string, promptText: string) => void;
}

const CONFIDENCE_JP: Record<string, string> = { low: "低", medium: "中", high: "高" };

/** Per-source badge: label + colour. Makes 確定(公式DB) vs 推定 unmistakable. */
const SOURCE_BADGE: Record<
  NonNullable<Meal["nutrition"]>["sourceKind"] & string,
  { label: string; className: string }
> = {
  db: {
    label: "公式DB",
    className:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
  },
  label: {
    label: "ラベル値",
    className: "bg-sky-100 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300",
  },
  estimate: {
    label: "推定値・参考",
    className:
      "bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
  },
};

const TYPE_STYLES: Record<string, string> = {
  朝: "bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
  昼: "bg-sky-100 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300",
  夕: "bg-indigo-100 text-indigo-700 dark:bg-indigo-400/15 dark:text-indigo-300",
  間食: "bg-rose-100 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300",
};

export function MealCard({
  meal,
  onEdit,
  onDelete,
  onEat,
  onGenerateImage,
  generatingImage,
  imageError,
  onGeneratedImageDataUrlBackfill,
}: Props) {
  // Plan vs eaten (AIプランナー 第3陣D). ABSENT status → eaten (every pre-feature /
  // chat-logged / manual meal). A planned entry shows a 予定 chip + a 「食べた」 button
  // and a muted surface, so the user sees it's a plan and can tick it off.
  const planned = meal.status === "planned";

  // Card image contract: every meal's representative image is generated from
  // the menu text. User photos remain available for AI analysis, but the card
  // does not use static templates or uploaded photos as the representative icon.
  const imagePlan = resolveMealCardImage(meal);
  const [backfilledImageId, setBackfilledImageId] = useState<string | null>(null);
  const handleLegacyGeneratedBlobLoaded = useCallback(
    (blob: Blob) => {
      if (
        imagePlan.syncedImageSrc ||
        !imagePlan.legacyGeneratedImageId ||
        backfilledImageId === imagePlan.legacyGeneratedImageId ||
        !onGeneratedImageDataUrlBackfill
      ) {
        return;
      }
      setBackfilledImageId(imagePlan.legacyGeneratedImageId);
      void compressGeneratedMealImageToDataUrl(blob).then((dataUrl) => {
        if (dataUrl) onGeneratedImageDataUrlBackfill(dataUrl, imagePlan.promptText);
      });
    },
    [
      backfilledImageId,
      imagePlan.legacyGeneratedImageId,
      imagePlan.promptText,
      imagePlan.syncedImageSrc,
      onGeneratedImageDataUrlBackfill,
    ],
  );
  const canGenerateImage =
    !!onGenerateImage &&
    imagePlan.needsGeneratedImage;
  return (
    <div
      className={`surface group overflow-hidden transition duration-300 ease-spring hover:-translate-y-0.5 hover:shadow-card-hover dark:hover:shadow-card-hover-dark ${
        planned ? "border-dashed border-accent/30 bg-accent/[0.03] dark:bg-accent-light/[0.04]" : ""
      }`}
    >
      <div className="p-4">
        <div className="mb-1.5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${TYPE_STYLES[meal.type]}`}
            >
              {meal.type}
            </span>
            {planned && (
              <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent dark:bg-accent/20 dark:text-accent-light">
                予定
              </span>
            )}
            <span className="text-xs font-medium text-slate-400 dark:text-navy-300">
              {formatTime(meal.timestamp)}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {canGenerateImage && (
              <button
                type="button"
                onClick={onGenerateImage}
                disabled={generatingImage}
                className="btn-ghost px-2 py-1.5 text-xs font-semibold disabled:opacity-60"
              >
                {generatingImage ? "生成中" : "画像生成"}
              </button>
            )}
            <button
              type="button"
              onClick={onEdit}
              aria-label="編集"
              className="btn-ghost px-2 py-1.5"
            >
              <PencilIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onDelete}
              aria-label="削除"
              className="btn-ghost px-2 py-1.5 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10"
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
        {(imagePlan.syncedImageSrc || imagePlan.legacyGeneratedImageId || imagePlan.needsGeneratedImage || meal.text) && (
          <div className="flex items-start gap-3">
            {imagePlan.syncedImageSrc && (
              <img
                src={imagePlan.syncedImageSrc}
                alt={meal.text || "生成された食事イメージ"}
                loading="lazy"
                className="h-16 w-16 shrink-0 rounded-xl object-cover sm:h-20 sm:w-20"
              />
            )}
            {!imagePlan.syncedImageSrc && imagePlan.legacyGeneratedImageId && (
              <PhotoImage
                photoId={imagePlan.legacyGeneratedImageId}
                alt={meal.text || "生成された食事イメージ"}
                fallback={<GeneratedMealImagePlaceholder generating={generatingImage} />}
                onBlobLoaded={handleLegacyGeneratedBlobLoaded}
                className="h-16 w-16 shrink-0 rounded-xl object-cover sm:h-20 sm:w-20"
              />
            )}
            {!imagePlan.syncedImageSrc && !imagePlan.legacyGeneratedImageId && imagePlan.needsGeneratedImage && (
              <GeneratedMealImagePlaceholder generating={generatingImage} />
            )}
            {meal.text && (
              <p className="min-w-0 flex-1 whitespace-pre-wrap text-[15px] leading-relaxed text-slate-700 dark:text-navy-100">
                {meal.text}
              </p>
            )}
          </div>
        )}

        {imageError && (
          <p className="mt-2 rounded-xl bg-rose-50 px-3 py-2 text-xs font-medium text-rose-600 dark:bg-rose-500/10 dark:text-rose-300">
            画像生成に失敗しました。少し時間をおいて再試行できます。
          </p>
        )}

        {meal.nutrition && hasNutrition(meal.nutrition) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {meal.nutrition.sourceKind && SOURCE_BADGE[meal.nutrition.sourceKind] && (
              <span
                className={`rounded-md px-2 py-0.5 text-xs font-semibold ${SOURCE_BADGE[meal.nutrition.sourceKind].className}`}
              >
                {SOURCE_BADGE[meal.nutrition.sourceKind].label}
              </span>
            )}
            {meal.nutrition.items && meal.nutrition.items.length > 0 && (
              <span className="rounded-md bg-slate-50 px-2 py-0.5 text-xs text-slate-400 dark:bg-navy-800/60 dark:text-navy-400">
                {meal.nutrition.items.length}品目
              </span>
            )}
            {meal.nutrition.calories != null && (
              <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-slate-700 dark:bg-navy-800 dark:text-navy-100">
                {formatNumber(meal.nutrition.calories)} kcal
              </span>
            )}
            {meal.nutrition.proteinG != null && (
              <MacroTag label="P" value={meal.nutrition.proteinG} className="text-rose-500" />
            )}
            {meal.nutrition.fatG != null && (
              <MacroTag label="F" value={meal.nutrition.fatG} className="text-amber-500" />
            )}
            {meal.nutrition.carbG != null && (
              <MacroTag label="C" value={meal.nutrition.carbG} className="text-sky-500" />
            )}
            {/* Extra nutrients (「全栄養素を出す」) — only shown when a real figure
                exists (null/absent → omitted, never a fabricated 0 / "—"). */}
            {meal.nutrition.fiberG != null && (
              <NutTag label="食物繊維" value={meal.nutrition.fiberG} unit="g" />
            )}
            {meal.nutrition.sugarG != null && (
              <NutTag label="糖質" value={meal.nutrition.sugarG} unit="g" />
            )}
            {meal.nutrition.sodiumMg != null && (
              <NutTag label="塩分(Na)" value={meal.nutrition.sodiumMg} unit="mg" />
            )}
            {meal.nutrition.saturatedFatG != null && (
              <NutTag label="飽和脂肪" value={meal.nutrition.saturatedFatG} unit="g" />
            )}
          </div>
        )}

        {/* Vitamins/minerals (拡張①) — collapsed by default (many), grouped into
            ビタミン群/ミネラル群. Hidden entirely when no real figure exists. */}
        {meal.nutrition?.micros && (
          <MicroNutrientsPanel micros={meal.nutrition.micros} className="mt-2.5" />
        )}

        {/* When the total includes a 推定/ラベル value, say so unmistakably. */}
        {meal.nutrition?.estimated && (
          <p className="mt-1.5 text-[10px] leading-relaxed text-amber-600 dark:text-amber-400">
            ※AIの推定です。正確ではありません。
          </p>
        )}

        {meal.nutrition?.source && (
          <p className="mt-1 text-[10px] leading-relaxed text-slate-400 dark:text-navy-400">
            {meal.nutrition.estimated ? "推定を含む" : "出典"}（{meal.nutrition.source}）
            {meal.nutrition.confidence && ` ・ 確信度 ${CONFIDENCE_JP[meal.nutrition.confidence]}`}
          </p>
        )}

        {/* Recipe card (AIプランナー 第3陣D — レシピカード②): 材料 + 手順 the coach
            wrote for a planned 献立. Presentation only; numbers come from the
            grounded nutrition above, never from this card. */}
        {meal.recipe && hasRecipe(meal.recipe) && (
          <RecipeCard recipe={meal.recipe} />
        )}
      </div>

      {/* Actions row for a PLANNED meal — a primary 「食べた」 button (AIプランナー
          第3陣D, the twin of the workout 完了): pressing it flips the meal to eaten
          so it starts counting toward 摂取/PFC/達成. An eaten meal shows no footer. */}
      {planned && onEat && (
        <div className="flex items-center border-t border-slate-100 px-2 py-1.5 dark:border-navy-800">
          <button
            type="button"
            onClick={onEat}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-accent/90 active:scale-[0.98] dark:bg-accent dark:hover:bg-accent/90"
          >
            食べた
          </button>
          <span className="ml-2 text-[11px] text-slate-400 dark:text-navy-400">
            食べたら押すと摂取に反映されます
          </span>
        </div>
      )}
    </div>
  );
}

function GeneratedMealImagePlaceholder({ generating }: { generating?: boolean }) {
  return (
    <div
      className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-[10px] font-semibold text-slate-400 sm:h-20 sm:w-20 dark:bg-navy-800 dark:text-navy-400"
      aria-label={generating ? "画像生成中" : "画像未生成"}
    >
      {generating ? "生成中" : "画像"}
    </div>
  );
}

/** True when a recipe card has at least one ingredient or step line to show. */
function hasRecipe(r: NonNullable<Meal["recipe"]>): boolean {
  return (r.ingredients?.length ?? 0) > 0 || (r.steps?.length ?? 0) > 0;
}

/** The レシピカード② body: 材料 list + 手順 (numbered) + 買い物リスト⑤. Each section
 *  is optional (only rendered when present). The 買い物リスト is computed CLIENT-SIDE
 *  (材料 − 手元の食材), so nothing is fabricated. Plain, mobile-friendly. */
function RecipeCard({ recipe }: { recipe: NonNullable<Meal["recipe"]> }) {
  // 買い物リスト⑤ = recipe材料 − 冷蔵庫にある食材 (deterministic; never the model).
  // When there's no on-hand context the diff returns the whole list, so we only
  // surface the section when fridge context (onHand) actually narrowed it down.
  const shopping = computeShoppingList(recipe.ingredients, recipe.onHand);
  const showShopping =
    (recipe.onHand?.length ?? 0) > 0 && shopping.length > 0;
  return (
    <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50/70 p-3 dark:border-navy-800 dark:bg-navy-800/40">
      {recipe.ingredients && recipe.ingredients.length > 0 && (
        <div>
          <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-navy-300">
            材料
          </p>
          <div className="flex flex-wrap gap-1.5">
            {recipe.ingredients.map((ing, i) => (
              <span
                key={i}
                className="rounded-md bg-white px-2 py-0.5 text-xs text-slate-600 dark:bg-navy-900/60 dark:text-navy-200"
              >
                {ing}
              </span>
            ))}
          </div>
        </div>
      )}
      {recipe.steps && recipe.steps.length > 0 && (
        <div className={recipe.ingredients && recipe.ingredients.length > 0 ? "mt-3" : ""}>
          <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-navy-300">
            作り方
          </p>
          <ol className="space-y-1">
            {recipe.steps.map((step, i) => (
              <li key={i} className="flex gap-2 text-xs leading-relaxed text-slate-600 dark:text-navy-200">
                <span className="shrink-0 font-bold text-accent dark:text-accent-light">
                  {i + 1}.
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {showShopping && (
        <div className="mt-3 border-t border-slate-200/70 pt-2.5 dark:border-navy-700">
          <p className="mb-1 flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400">
            買い物リスト（足りない材料）
          </p>
          <div className="flex flex-wrap gap-1.5">
            {shopping.map((item, i) => (
              <span
                key={i}
                className="rounded-md bg-amber-50 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-400/15 dark:text-amber-300"
              >
                {item}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function hasNutrition(n: NonNullable<Meal["nutrition"]>): boolean {
  return Object.values(n).some((v) => v != null);
}

function MacroTag({
  label,
  value,
  className,
}: {
  label: string;
  value: number;
  className: string;
}) {
  return (
    <span className="rounded-md bg-slate-50 px-2 py-0.5 text-xs tabular-nums text-slate-500 dark:bg-navy-800/60 dark:text-navy-300">
      <span className={`font-bold ${className}`}>{label}</span> {formatNumber(value)}g
    </span>
  );
}

/** A compact tag for an extra nutrient (食物繊維/糖質/塩分/飽和脂肪). Only rendered
 *  by the caller when a real value exists — never for null/unknown. */
function NutTag({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <span className="rounded-md bg-slate-50 px-2 py-0.5 text-xs tabular-nums text-slate-400 dark:bg-navy-800/60 dark:text-navy-400">
      {label} {formatNumber(value)}
      {unit}
    </span>
  );
}
