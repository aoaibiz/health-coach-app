"use client";

import { useEffect, useState } from "react";
import type { NutritionTargets, Profile } from "@/lib/types";
import {
  activityLabel,
  bodyTypeLabel,
  displayName,
  goalLabel,
  sexLabel,
} from "@/lib/profileView";
import { resolveAvatarUrl } from "@/lib/avatarStore";
import { formatNumber } from "@/lib/workout";
import { Disclaimer } from "@/components/Disclaimer";
import { PencilIcon, UserIcon } from "@/components/icons";

interface Props {
  profile: Profile;
  targets: NutritionTargets;
  onEdit: () => void;
}

/** Read-only avatar. Prefers the SYNCED data URL on the profile, falling back to
 *  the legacy device-local IndexedDB blob, then to an icon. */
function Avatar({ profile, name }: { profile: Profile; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const avatarDataUrl = profile.avatarDataUrl;
  const avatarPhotoId = profile.avatarPhotoId;

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    resolveAvatarUrl({ avatarDataUrl, avatarPhotoId })
      .then((res) => {
        if (!res) {
          if (!cancelled) setUrl(null);
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
        setUrl(res.url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [avatarDataUrl, avatarPhotoId]);

  return (
    <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-slate-100 text-slate-400 dark:border-navy-700 dark:bg-navy-800 dark:text-navy-300">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={`${name}のプロフィール写真`} className="h-full w-full object-cover" />
      ) : (
        <UserIcon className="h-7 w-7" />
      )}
    </div>
  );
}

/**
 * Read-only summary of an existing profile (gap #2). Shows avatar + name + key
 * stats + computed targets, with a prominent 編集 button to switch to the form.
 */
export function ProfileView({ profile, targets, onEdit }: Props) {
  const stats: { label: string; value: string }[] = [
    { label: "身長", value: `${formatNumber(profile.heightCm)} cm` },
    { label: "体重", value: `${formatNumber(profile.weightKg)} kg` },
    ...(profile.targetWeightKg != null
      ? [{ label: "目標体重", value: `${formatNumber(profile.targetWeightKg)} kg` }]
      : []),
    { label: "年齢", value: `${formatNumber(profile.age)} 歳` },
    { label: "性別", value: sexLabel(profile.sex) },
    { label: "体型", value: bodyTypeLabel(profile.bodyType) },
    { label: "活動量", value: activityLabel(profile.activityLevel) },
    { label: "目標", value: goalLabel(profile.goal) },
    ...(profile.bodyFatPct != null
      ? [{ label: "体脂肪率", value: `${formatNumber(profile.bodyFatPct)} %` }]
      : []),
  ];

  return (
    <div className="space-y-5">
      {/* Identity + edit — a clear "登録済み" confirmation at a glance */}
      <div className="surface flex items-center gap-4 p-5">
        <Avatar profile={profile} name={displayName(profile)} />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-accent dark:text-accent-light">
            プロフィール登録済み
          </p>
          <p className="mt-0.5 truncate text-lg font-bold text-slate-900 dark:text-navy-50">
            {displayName(profile)}
          </p>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-navy-300">
            {goalLabel(profile.goal)}・{activityLabel(profile.activityLevel)}
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

      {/* Key stats */}
      <div className="surface p-5">
        <h2 className="mb-3 text-sm font-bold text-slate-700 dark:text-navy-100">
          身体情報
        </h2>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          {stats.map((s) => (
            <div key={s.label} className="flex items-baseline justify-between border-b border-slate-100 pb-2 dark:border-navy-800">
              <dt className="text-xs text-slate-400 dark:text-navy-400">{s.label}</dt>
              <dd className="text-sm font-semibold tabular-nums text-slate-800 dark:text-navy-50">
                {s.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {/* Computed targets */}
      <div className="surface p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-700 dark:text-navy-100">
            あなたの1日の目標
          </h2>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-navy-800 dark:text-navy-300">
            {targets.bmrMethod}
          </span>
        </div>
        <div className="flex items-end gap-2">
          <span className="text-4xl font-bold tabular-nums text-accent dark:text-accent-light">
            {formatNumber(targets.calories)}
          </span>
          <span className="mb-1 text-sm font-medium text-slate-400 dark:text-navy-300">
            kcal / 日
          </span>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          {[
            { label: "P", value: targets.proteinG, color: "text-rose-500" },
            { label: "F", value: targets.fatG, color: "text-amber-500" },
            { label: "C", value: targets.carbG, color: "text-sky-500" },
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
          BMR {formatNumber(targets.bmr)} · TDEE {formatNumber(targets.tdee)} kcal
        </p>
        <Disclaimer className="mt-3" />
      </div>
    </div>
  );
}
