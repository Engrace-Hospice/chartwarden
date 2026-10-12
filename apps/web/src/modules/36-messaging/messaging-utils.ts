import type { ChannelSummary, Message } from "./messaging-types";

export function channelLabel(channel: ChannelSummary): string {
  return channel.title?.trim() || channel.kind.replace(/_/g, " ");
}

export function channelKindLabel(kind: ChannelSummary["kind"]): string {
  const labels: Record<ChannelSummary["kind"], string> = {
    care_team: "Care Team",
    discipline: "Discipline",
    location: "Location",
    on_call: "On Call",
    dm: "Direct message",
    announcement: "Announcement",
    bereavement: "Bereavement",
  };
  return labels[kind];
}

export function initialsOf(value: string): string {
  const words = value.split(/[\s,_]+/).filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? "")
      .join("") || "M"
  ).slice(0, 2);
}

export function relativeTime(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "Now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 7
    ? `${days}d`
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(then);
}

export function absoluteTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

export function dayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDifference = Math.round((today.getTime() - target.getTime()) / 86_400_000);
  if (dayDifference === 0) return "Today";
  if (dayDifference === 1) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
}

export function compareMessages(a: Message, b: Message): number {
  return a.createdAt.localeCompare(b.createdAt) || a.messageId.localeCompare(b.messageId);
}

export function mergeMessages(
  current: readonly Message[],
  incoming: readonly Message[],
): Message[] {
  const merged = new Map(current.map((message) => [message.messageId, message]));
  for (const message of incoming) merged.set(message.messageId, message);
  return [...merged.values()].sort(compareMessages);
}

export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const candidate = error as { message?: unknown; error?: { message?: unknown } };
    if (typeof candidate.message === "string" && candidate.message) return candidate.message;
    if (typeof candidate.error?.message === "string" && candidate.error.message) {
      return candidate.error.message;
    }
  }
  return fallback;
}

/**
 * WP 1.2 — the identity of one composed message across send attempts. `clientMessageId` (the DB backstop) and
 * `idempotencyKey` (the HTTP middleware) are minted once per composed message and reused on every retry, so a
 * lost response followed by a retry is a replay of the original send, never a second message.
 */
export interface SendAttempt {
  readonly fingerprint: string;
  readonly clientMessageId: string;
  readonly idempotencyKey: string;
}

/** Reuse `previous` while the composed message (channel + body + references) is unchanged; else mint fresh ids. */
export function sendAttemptFor(previous: SendAttempt | null, fingerprint: string): SendAttempt {
  if (previous?.fingerprint === fingerprint) return previous;
  return { fingerprint, clientMessageId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
}

/**
 * A 409 means the server still holds the first attempt's key as in-flight/unfinished, so the same key can never
 * succeed. Rotate only the header key; `clientMessageId` stays, so the server answers with the original message.
 */
export function rotateIdempotencyKey(attempt: SendAttempt): SendAttempt {
  return { ...attempt, idempotencyKey: crypto.randomUUID() };
}
