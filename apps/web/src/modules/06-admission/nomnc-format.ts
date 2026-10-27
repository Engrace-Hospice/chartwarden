// apps/web/src/modules/06-admission/nomnc-format.ts — pure labels / tones / countdown for the NOMNC and QIO review
// panel (milestone 10a). No React, unit-testable. Times are shown in the ORGANIZATION's zone (the zone the server
// converted the typed minute in), never the viewer's. Nothing here states a CMS rule: the countdown reads a time a
// person typed from the notice or the QIO's call.
import type { StatusTone } from "@chartwarden/ui";
import type {
  AcknowledgementKind,
  DeadlineKind,
  DeadlineStatus,
  DecisionOutcome,
  Prompt,
  RecipientKind,
  RequestedByKind,
} from "./nomnc-api";

export const DEADLINE_KIND_LABEL: Record<DeadlineKind, string> = {
  appeal_request: "Appeal request",
  denc_delivery: "DENC delivery",
  records_to_qio: "Records to the QIO",
  qio_decision: "QIO decision",
  other: "Other",
};

/** The kinds a notice / a review can carry (a grouping the server also enforces, not a rule). */
export const NOTICE_DEADLINE_KINDS: readonly DeadlineKind[] = ["appeal_request", "other"];
export const REVIEW_DEADLINE_KINDS: readonly DeadlineKind[] = [
  "denc_delivery",
  "records_to_qio",
  "qio_decision",
  "other",
];

export const RECIPIENT_LABEL: Record<RecipientKind, string> = {
  beneficiary: "Beneficiary",
  representative: "Representative",
};
export const ACK_LABEL: Record<AcknowledgementKind, string> = {
  signed: "Signed",
  refused: "Refused",
  other: "Other",
};
export const REQUESTED_BY_LABEL: Record<RequestedByKind, string> = {
  beneficiary: "Beneficiary",
  representative: "Representative",
  unknown: "Not stated",
};
export const OUTCOME_LABEL: Record<DecisionOutcome, string> = {
  discharge_upheld: "Discharge upheld",
  discharge_reversed: "Discharge reversed",
  other: "Other",
};

export const OPTIONS = <T extends string>(labels: Record<T, string>) =>
  (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }));

export const STATUS_LABEL: Record<DeadlineStatus, string> = {
  open: "Open",
  due_soon: "Due soon",
  past: "Past due",
  satisfied: "Met",
  closed: "Closed",
};
export const STATUS_TONE: Record<DeadlineStatus, StatusTone> = {
  open: "progress",
  due_soon: "warning",
  past: "error",
  satisfied: "success",
  closed: "neutral",
};

export const PROMPT_TONE: Record<Prompt["severity"], "warning" | "info"> = {
  warn: "warning",
  info: "info",
};

/** `2026-01-12T17:00:00.000Z` -> "Jan 12, 2026, 12:00 PM EST" in `timeZone`. */
export function formatInZone(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  })
    .format(d)
    .concat(` ${zoneName(d, timeZone)}`);
}

function zoneName(d: Date, timeZone: string): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? timeZone;
}

/** The typed `YYYY-MM-DDTHH:MM` echo as "2026-01-12 12:00 (America/New_York)": exactly what was typed. */
export function typedEcho(dueLocal: string, zone: string): string {
  return `${dueLocal.replace("T", " ")} (${zone})`;
}

/** "3 h 20 min left" / "45 min left" / "Past due by 2 h 5 min". Minute-accurate; no rounding up. */
export function countdownLabel(dueAtIso: string, now: Date = new Date()): string {
  const diffMin = Math.floor((new Date(dueAtIso).getTime() - now.getTime()) / 60_000);
  const abs = Math.abs(diffMin);
  const days = Math.floor(abs / 1440);
  const hours = Math.floor((abs % 1440) / 60);
  const mins = abs % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} d`);
  if (hours > 0) parts.push(`${hours} h`);
  if (mins > 0 || parts.length === 0) parts.push(`${mins} min`);
  const text = parts.join(" ");
  return diffMin >= 0 ? `${text} left` : `Past due by ${text}`;
}

/** The soonest unsatisfied deadline (by instant), if any. */
export function nextOpenDeadline<T extends { dueAt: string; satisfiedAt: string | null }>(
  deadlines: readonly T[],
): T | null {
  const open = deadlines.filter((d) => !d.satisfiedAt);
  return [...open].sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0] ?? null;
}

/** Form values -> the wire shape. A blank field stays blank (the server refuses it): nothing is defaulted. */
export function moment(date: string, time: string): { date: string | null; time: string | null } {
  return { date: date.trim() || null, time: time.trim() || null };
}
