"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { ProfileForm } from "@/components/profile/ProfileForm";
import { ProfileView } from "@/components/profile/ProfileView";
import { useProfile } from "@/components/profile/useProfile";
import { CoachSettingsForm } from "@/components/coach/CoachSettingsForm";
import { useCoachSettings } from "@/components/coach/useCoachSettings";
import { PushSettingsCard } from "@/components/push/PushSettingsCard";
import { initialProfileMode, type ProfileScreenMode } from "@/lib/profileView";

export default function ProfilePage() {
  const { profile, targets, ready, save } = useProfile();
  const { settings: coachSettings, ready: coachReady, save: saveCoach } = useCoachSettings();
  const router = useRouter();
  const [mode, setMode] = useState<ProfileScreenMode>("edit");

  // Once storage is read, pick the initial mode: existing profile → view,
  // first run → straight to the form. Only set it from the loaded value.
  useEffect(() => {
    if (ready) setMode(initialProfileMode(profile));
    // Intentionally keyed on `ready` only: we don't want a later save (which
    // updates `profile`) to yank the user out of the form mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  return (
    <AppShell>
      <div className="space-y-4">
        <header>
          <h1 className="text-xl font-bold tracking-tight">プロフィール</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-navy-300">
            身体情報から1日の目標カロリーと PFC を計算します。
          </p>
        </header>

        {ready &&
          (mode === "view" && profile && targets ? (
            <ProfileView
              profile={profile}
              targets={targets}
              onEdit={() => setMode("edit")}
            />
          ) : (
            <ProfileForm
              existing={profile}
              onSave={save}
              onSaved={() => {
                if (!profile) {
                  // First-time setup → show the freshly computed 成果 targets.
                  // (Chat is the home; the dashboard lives at /dashboard now.)
                  router.push("/dashboard");
                } else {
                  // Editing an existing profile → return to the read-only view.
                  setMode("view");
                }
              }}
              onCancel={profile ? () => setMode("view") : undefined}
            />
          ))}

        {/* AIコーチの設定（名前・写真・性格）— 専門知識/安全ルールは不変 */}
        {coachReady && <CoachSettingsForm existing={coachSettings} onSave={saveCoach} />}

        {/* 通知（LINE風 Web Push）— csrfToken は auth context から */}
        <PushSettingsCard />
      </div>
    </AppShell>
  );
}
