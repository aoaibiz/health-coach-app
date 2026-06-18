"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CoachAvatar } from "@/components/chat/CoachAvatar";
import { MessageText } from "@/components/chat/MessageText";
import { UserAvatar } from "@/components/chat/UserAvatar";
import { useChat } from "@/components/chat/ChatProvider";
import { coachDisplayName, type CoachSettings } from "@/lib/coachSettings";
import {
  CameraIcon,
  CloseIcon,
  DumbbellIcon,
  InfoIcon,
  MealIcon,
  SendIcon,
  TrashIcon,
} from "@/components/icons";
import { getPhoto } from "@/lib/photoStore";
import type { ChatMessage } from "@/lib/chatStore";
import type { Profile } from "@/lib/types";

/** Max photos per send (one meal). Mirrors the backend MAX_IMAGES_PER_MEAL. */
const MAX_PHOTOS = 6;

/** Renders a stored photo (by IndexedDB id) inside a chat bubble. `compact` is
 *  used for the multi-photo grid (no own margin, fixed-height tile). */
function BubblePhoto({ photoId, compact = false }: { photoId: string; compact?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    getPhoto(photoId).then((blob) => {
      if (cancelled || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [photoId]);
  if (!url) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt="送った食事の写真"
      className={
        compact
          ? "h-24 w-full rounded-lg object-cover"
          : "mb-1.5 max-h-44 w-full rounded-xl object-cover"
      }
    />
  );
}

/** Chip shown under the assistant bubble when this turn auto-logged a meal. */
function LoggedMealChip() {
  return (
    <Link
      href="/meal"
      className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 transition active:scale-95 hover:bg-emerald-200 dark:bg-emerald-400/15 dark:text-emerald-300"
    >
      <MealIcon className="h-3.5 w-3.5" />
      食事に記録しました（タップで確認・編集）
    </Link>
  );
}

/** Chip shown under the assistant bubble when this turn auto-logged a workout. */
function LoggedWorkoutChip() {
  return (
    <Link
      href="/workout"
      className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-sky-100 px-2.5 py-1 text-[11px] font-semibold text-sky-700 transition active:scale-95 hover:bg-sky-200 dark:bg-sky-400/15 dark:text-sky-300"
    >
      <DumbbellIcon className="h-3.5 w-3.5" />
      筋トレを記録しました（タップで確認・編集）
    </Link>
  );
}

function Bubble({
  message,
  profile,
  coachSettings,
}: {
  message: ChatMessage;
  profile: Profile | null;
  coachSettings: CoachSettings;
}) {
  const isUser = message.role === "user";
  if (isUser) {
    // A multi-photo turn carries every shot in photoIds; older/single turns use
    // photoId. Render whichever set is present (one meal can have several photos).
    const photoIds =
      message.photoIds && message.photoIds.length > 0
        ? message.photoIds
        : message.photoId
          ? [message.photoId]
          : [];
    return (
      <div className="flex items-end justify-end gap-2">
        <div className="max-w-[78%] rounded-2xl rounded-br-sm bg-accent px-3.5 py-2.5 text-sm leading-relaxed text-white shadow-sm dark:bg-accent-dark">
          {photoIds.length === 1 ? (
            <BubblePhoto photoId={photoIds[0]} />
          ) : photoIds.length > 1 ? (
            <div className="mb-1.5 grid grid-cols-2 gap-1">
              {photoIds.map((id) => (
                <BubblePhoto key={id} photoId={id} compact />
              ))}
            </div>
          ) : null}
          {message.content && <MessageText content={message.content} />}
        </div>
        <UserAvatar profile={profile} />
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex items-end justify-start gap-2">
        <CoachAvatar settings={coachSettings} />
        <div className="max-w-[78%] rounded-2xl rounded-bl-sm border border-slate-200/70 bg-white px-3.5 py-2.5 text-sm leading-relaxed text-slate-800 shadow-sm dark:border-navy-700 dark:bg-navy-800 dark:text-navy-50">
          {/* MessageText uses whitespace-pre-wrap → RENDERS the coach's \n as real
              line breaks (Feature 1 — the bubble no longer collapses newlines). */}
          <MessageText content={message.content} />
        </div>
      </div>
      {message.loggedMeal && <div className="pl-10">{<LoggedMealChip />}</div>}
      {message.loggedWorkout && <div className="pl-10">{<LoggedWorkoutChip />}</div>}
    </div>
  );
}

/**
 * Loading indicator while a turn is in flight. Photo analysis (codex vision) can
 * take ~10-30s, so we show "写真を解析中…" during that phase and "考え中…" while
 * the coach composes its reply — honest about the longer wait.
 */
function ThinkingBubble({
  label,
  coachSettings,
}: {
  label: string;
  coachSettings: CoachSettings;
}) {
  return (
    <div className="flex items-end justify-start gap-2">
      <CoachAvatar settings={coachSettings} />
      <div className="rounded-2xl rounded-bl-sm border border-slate-200/70 bg-white px-3.5 py-2.5 text-sm text-slate-400 shadow-sm dark:border-navy-700 dark:bg-navy-800 dark:text-navy-300">
        <span className="inline-flex items-center gap-1.5">
          {label}
          <span className="inline-flex gap-0.5">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-300 [animation-delay:-0.2s] dark:bg-navy-500" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-300 [animation-delay:-0.1s] dark:bg-navy-500" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-300 dark:bg-navy-500" />
          </span>
        </span>
      </div>
    </div>
  );
}

/**
 * Shown at the top of the chat when no access key is set. The key UNLOCKS
 * 健康マン — without it sends just 401. Friendly heads-up + link to /profile,
 * instead of only erroring after the user types and sends.
 */
function KeyRequiredBanner({ coachName }: { coachName: string }) {
  return (
    <div className="mb-2 rounded-xl border border-accent/30 bg-accent/5 p-3 dark:border-accent-light/30 dark:bg-accent-light/10">
      <div className="flex items-start gap-2.5">
        <InfoIcon className="mt-0.5 h-5 w-5 shrink-0 text-accent dark:text-accent-light" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-700 dark:text-navy-100">
            {coachName}と話すには「アクセスキー」が必要です
          </p>
          <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-navy-300">
            プロフィールでアクセスキーを設定すると、AIチャットと写真・テキストのカロリー解析が使えるようになります。
          </p>
          <Link
            href="/profile"
            className="btn-primary mt-2.5 px-4 py-2 text-sm"
          >
            アクセスキーを設定する
          </Link>
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  coachSettings,
  coachName,
}: {
  coachSettings: CoachSettings;
  coachName: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <CoachAvatar settings={coachSettings} className="mb-3 h-16 w-16" />
      <p className="text-sm font-semibold text-slate-600 dark:text-navy-100">
        {coachName}に相談しよう
      </p>
      <p className="mt-1 max-w-[18rem] text-xs leading-relaxed text-slate-400 dark:text-navy-400">
        今日の食事や筋トレ、次に何を食べるとよいかなど、気軽に聞いてみてください。
      </p>
    </div>
  );
}

/**
 * The chat conversation surface. This is the app's HOME/landing (mounted at `/`)
 * and is also reachable at `/chat`. It owns no chrome — the caller wraps it in
 * the AppShell so the header + nav are shared with the other pages.
 */
export function ChatView() {
  const {
    messages,
    profile,
    coachSettings,
    ready,
    sending,
    phase,
    photoCount,
    error,
    hasKey,
    send,
    clear,
  } = useChat();
  const coachName = coachDisplayName(coachSettings);
  const [draft, setDraft] = useState("");
  // Staged photos (preview + send) — one OR several shots of the SAME meal.
  // Kept as Files until send; preview URLs are derived in the effect below.
  const [photos, setPhotos] = useState<File[]>([]);
  const [photoUrls, setPhotoUrls] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  // Only surface the "set your key" state once storage has been read, to avoid
  // a flash of the banner on first paint before hasKey is known.
  const needsKey = ready && !hasKey;
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Keep the latest message in view as the conversation grows / while thinking.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  // Revoke the staged preview URLs when the set changes / on unmount (no leak).
  useEffect(() => {
    if (photos.length === 0) {
      setPhotoUrls([]);
      return;
    }
    const urls = photos.map((p) => URL.createObjectURL(p));
    setPhotoUrls(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [photos]);

  function handlePickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    // `multiple` lets the user pick several shots of one meal at once; we also
    // append across picks so they can add photos one at a time, capped at 6.
    const picked = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-selecting the same file(s)
    if (picked.length > 0) {
      setPhotos((prev) => [...prev, ...picked].slice(0, MAX_PHOTOS));
    }
  }

  function removePhotoAt(index: number) {
    setPhotos((prev) => prev.filter((_, i) => i !== index));
  }

  function handleSend() {
    const text = draft.trim();
    // Send when there's text OR staged photo(s). Photo(s) alone is a valid turn.
    // No `sending` lock: the user may fire another message while a reply is still
    // coming (concurrent sends are supported by the provider).
    if (!text && photos.length === 0) return;
    const staged = photos;
    setDraft("");
    setPhotos([]);
    void send(text, staged);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts a newline (mobile keyboards send too).
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // No `!sending` requirement: the input stays usable while a reply is in flight,
  // so the user can send consecutively without waiting for the coach.
  const canSend = !needsKey && (draft.trim() !== "" || photos.length > 0);

  return (
    <div className="flex h-full flex-col">
      {/* Header row: title + clear */}
      <div className="mb-2 flex items-center justify-between">
        <h1 className="flex items-center gap-1.5 text-base font-bold tracking-tight">
          <CoachAvatar settings={coachSettings} className="h-7 w-7" />
          {coachName}
        </h1>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={clear}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-400 transition active:scale-95 hover:text-slate-600 dark:text-navy-400 dark:hover:text-navy-200"
          >
            <TrashIcon className="h-3.5 w-3.5" />
            履歴を消去
          </button>
        )}
      </div>

      {/* No access key yet → friendly heads-up before the user even types. */}
      {needsKey && <KeyRequiredBanner coachName={coachName} />}

      {/* Message list */}
      <div
        ref={scrollerRef}
        className="no-scrollbar flex-1 min-h-0 space-y-3 overflow-y-auto pb-2"
      >
        {ready && messages.length === 0 && !sending ? (
          <EmptyState coachSettings={coachSettings} coachName={coachName} />
        ) : (
          messages.map((m) => (
            <Bubble key={m.id} message={m} profile={profile} coachSettings={coachSettings} />
          ))
        )}
        {sending && (
          <ThinkingBubble
            coachSettings={coachSettings}
            label={
              phase === "analyzing"
                ? photoCount > 1
                  ? `${photoCount}枚を解析中`
                  : "写真を解析中"
                : "考え中"
            }
          />
        )}
      </div>

      {error && (
        <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      {/* Staged photo previews (before send) — one OR several shots of one meal */}
      {photoUrls.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {photoUrls.map((url, i) => (
            <div key={url} className="relative w-fit">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt={`送る写真 ${i + 1}`}
                className="h-20 w-20 rounded-xl object-cover ring-1 ring-slate-200 dark:ring-navy-700"
              />
              <button
                type="button"
                onClick={() => removePhotoAt(i)}
                aria-label={`写真${i + 1}を取り消す`}
                className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-slate-800/80 text-white active:scale-95"
              >
                <CloseIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input row, pinned at the bottom of the chat area */}
      <div className="flex items-end gap-2 border-t border-slate-200/70 pt-3 dark:border-navy-800">
        {/* Photo attach — send one OR several shots of one meal (analyze → log). */}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handlePickPhoto}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={needsKey || photos.length >= MAX_PHOTOS}
          aria-label="食事の写真を追加"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-500 transition active:scale-95 hover:bg-slate-50 disabled:opacity-40 disabled:active:scale-100 dark:border-navy-700 dark:text-navy-300 dark:hover:bg-navy-800"
        >
          <CameraIcon className="h-5 w-5" />
        </button>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={
            needsKey
              ? "アクセスキーが必要です…"
              : photos.length > 0
                ? "写真について一言（任意）…"
                : "メッセージを入力…"
          }
          aria-label="メッセージ"
          className="field max-h-28 min-h-[2.75rem] flex-1 resize-none py-2.5"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend}
          aria-label="送信"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent text-white shadow-sm transition active:scale-95 hover:bg-accent-dark disabled:opacity-40 disabled:active:scale-100"
        >
          <SendIcon className="h-5 w-5" />
        </button>
      </div>

      <p className="mt-2 text-center text-[11px] leading-relaxed text-slate-400 dark:text-navy-400">
        {coachName}はAIです。
      </p>
    </div>
  );
}
