export const DELETE_RECORD_OPEN = "«HEALTH_DELETE_RECORD»";
export const DELETE_RECORD_CLOSE = "«/HEALTH_DELETE_RECORD»";

export type DeleteRecordKind = "meal" | "workout";
export type DeleteRecordScope = "latest" | "day";

export interface DeleteRecordPayload {
  kind: DeleteRecordKind;
  date: string;
  scope: DeleteRecordScope;
  names?: string[];
}

export interface ParsedDeleteRecordReply {
  display: string;
  payload: DeleteRecordPayload | null;
  hadBlock: boolean;
}

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, 80) : null;
}

function parsePayload(raw: string): DeleteRecordPayload | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const kind = parsed.kind === "meal" || parsed.kind === "workout" ? parsed.kind : null;
    const scope = parsed.scope === "latest" || parsed.scope === "day" ? parsed.scope : null;
    const date = typeof parsed.date === "string" ? parsed.date.trim() : "";
    if (!kind || !scope || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const names = Array.isArray(parsed.names)
      ? parsed.names.map(cleanName).filter((v): v is string => Boolean(v))
      : undefined;
    return { kind, scope, date, ...(names?.length ? { names } : {}) };
  } catch {
    return null;
  }
}

function stripTrailingDeleteJson(value: string): string {
  const end = value.trimEnd().length;
  const head = value.slice(0, end);
  const start = head.lastIndexOf("{");
  if (start < 0) return value;
  const candidate = head.slice(start);
  if (!/"kind"\s*:\s*"(meal|workout)"/.test(candidate)) return value;
  return value.slice(0, start);
}

function cleanDisplaySegment(value: string): { display: string; hadCloseMarker: boolean } {
  let cursor = 0;
  let hadCloseMarker = false;
  const display: string[] = [];

  while (cursor < value.length) {
    const close = value.indexOf(DELETE_RECORD_CLOSE, cursor);
    if (close < 0) {
      display.push(value.slice(cursor));
      break;
    }

    hadCloseMarker = true;
    display.push(stripTrailingDeleteJson(value.slice(cursor, close)));
    cursor = close + DELETE_RECORD_CLOSE.length;
  }

  return { display: display.join(""), hadCloseMarker };
}

export function parseDeleteRecordReply(raw: string): ParsedDeleteRecordReply {
  let cursor = 0;
  let hadBlock = false;
  let payload: DeleteRecordPayload | null = null;
  const display: string[] = [];

  while (cursor < raw.length) {
    const start = raw.indexOf(DELETE_RECORD_OPEN, cursor);
    if (start < 0) {
      const cleaned = cleanDisplaySegment(raw.slice(cursor));
      if (cleaned.hadCloseMarker) hadBlock = true;
      display.push(cleaned.display);
      break;
    }

    hadBlock = true;
    const cleaned = cleanDisplaySegment(raw.slice(cursor, start));
    display.push(cleaned.display);
    const afterOpen = start + DELETE_RECORD_OPEN.length;
    const end = raw.indexOf(DELETE_RECORD_CLOSE, afterOpen);
    if (end < 0) break;

    const json = raw.slice(afterOpen, end).trim();
    payload = payload ?? parsePayload(json);
    cursor = end + DELETE_RECORD_CLOSE.length;
  }

  return { display: display.join("").trim(), payload, hadBlock };
}
