// M25 milestone 7a-1 - the one-case-view TIMELINE. PURE: normalised items from the ADR, reopening, appeal chain,
// submission attempts, recorded deadlines and audit requests merge into one stable order, and the next open
// deadline is picked across kinds. A deadline from an unconfirmed window is flagged (`windowConfirmed: false`),
// never hidden.
export const TIMELINE_KINDS = [
  "appeal",
  "adr",
  "reopening",
  "recorded_deadline",
  "audit_request",
  "submission",
  "payer_appeal",
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export interface TimelineItem {
  readonly id: string;
  readonly kind: TimelineKind;
  /** ISO instant the item belongs at on the timeline. */
  readonly at: string;
  readonly label: string;
  readonly state: string;
  readonly tier: string | null;
  /** The record this one hangs off (the prior tier's appeal, the case a deadline or attempt belongs to). */
  readonly relatedId?: string | null;
  /** ISO instant of this item's OPEN deadline, or null (none, already satisfied, or the item is finished). */
  readonly deadlineAt: string | null;
  /** `computed` = derived by M25 from a notice date; `recorded` = typed by a person from a notice. */
  readonly deadlineSource: "computed" | "recorded" | null;
  /** False when the deadline comes from a window that is not SME-confirmed. */
  readonly windowConfirmed: boolean;
}

const KIND_ORDER = new Map<TimelineKind, number>(TIMELINE_KINDS.map((k, i) => [k, i]));

function compare(a: TimelineItem, b: TimelineItem, key: (i: TimelineItem) => string): number {
  const byTime = key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
  if (byTime !== 0) return byTime;
  const byKind = (KIND_ORDER.get(a.kind) ?? 99) - (KIND_ORDER.get(b.kind) ?? 99);
  if (byKind !== 0) return byKind;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortTimeline(items: readonly TimelineItem[]): TimelineItem[] {
  return [...items].sort((a, b) => compare(a, b, (i) => i.at));
}

/** The earliest deadline that has not passed, across kinds; ties go to the earlier kind. */
export function nextDeadline(items: readonly TimelineItem[], now: Date): TimelineItem | null {
  const open = items.filter(
    (i) => i.deadlineAt !== null && new Date(i.deadlineAt).getTime() >= now.getTime(),
  );
  const sorted = [...open].sort((a, b) => compare(a, b, (i) => i.deadlineAt as string));
  return sorted[0] ?? null;
}
