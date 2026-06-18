// The chat message body text. Extracted as a tiny, dependency-free presentational
// component so the line-break rendering (Feature 1) is unit-testable in isolation
// (renderToStaticMarkup) without pulling in the whole chat page / AppShell.
//
// `whitespace-pre-wrap` is the fix: it RENDERS the coach's "\n" as real line
// breaks (and wraps long lines), so a multi-line reply no longer collapses into
// one emotionless wall of text. `break-words` keeps long tokens from overflowing.

// Import React so the classic JSX transform (React.createElement) has React in
// scope when this component is server-rendered under vitest's esbuild (the rest
// of the app uses Next's automatic runtime; this keeps the unit test working
// without touching shared config). Harmless in the Next build.
import React from "react";

/** Tailwind classes that make `\n` render as visible line breaks. */
export const MESSAGE_TEXT_CLASS = "whitespace-pre-wrap break-words";

export function MessageText({ content }: { content: string }) {
  return <p className={MESSAGE_TEXT_CLASS}>{content}</p>;
}
