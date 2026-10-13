// What the outbox's live region says (pending-message-row): one text per event, never the same text twice in a row, so a
// screen reader announces every transition - a message queued, a retry that failed again, a refusal, a delivery.
import type { OutboxItem } from "./use-outbox";

export interface AnnouncementState {
  readonly channelId: string;
  readonly count: number;
  readonly delivered: number;
  /** Per item: how many answered failures were already announced. */
  readonly failures: Readonly<Record<string, number>>;
  readonly text: string;
}

const failuresOf = (items: readonly OutboxItem[], previous?: AnnouncementState["failures"]) =>
  Object.fromEntries(
    items.map((item) => [
      item.localId,
      previous ? (previous[item.localId] ?? 0) : (item.failCount ?? 0),
    ]),
  );

/** Opening another channel is not an event: start quiet from what it already holds. */
export function initialAnnouncement(
  channelId: string,
  items: readonly OutboxItem[],
  delivered: number,
): AnnouncementState {
  return { channelId, count: items.length, delivered, failures: failuresOf(items), text: "" };
}

function nextState(
  previous: AnnouncementState,
  items: readonly OutboxItem[],
  delivered: number,
): AnnouncementState {
  const waiting = items.length;
  const failures = failuresOf(items, previous.failures);
  const base = { channelId: previous.channelId, count: waiting, delivered, failures };

  if (delivered > previous.delivered) {
    return { ...base, text: waiting > 0 ? `Message sent (${waiting} waiting)` : "Message sent" };
  }
  if (waiting > previous.count) {
    return { ...base, text: `Message not sent (${waiting} waiting)` };
  }
  for (const item of items) {
    const count = item.failCount ?? 0;
    if (!item.error || count <= (previous.failures[item.localId] ?? count)) continue;
    return {
      ...base,
      failures: { ...failures, [item.localId]: count },
      text: item.permanent
        ? `Message not sent: ${item.error}`
        : `Retry failed, attempt ${count}: ${item.error}`,
    };
  }
  if (waiting < previous.count) return { ...base, text: "" };
  return { ...base, text: previous.text };
}

const sameFailures = (a: AnnouncementState["failures"], b: AnnouncementState["failures"]) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

/** The same object when nothing changed, so the caller can set state during render without looping. */
export function nextAnnouncement(
  previous: AnnouncementState,
  items: readonly OutboxItem[],
  delivered: number,
): AnnouncementState {
  const next = nextState(previous, items, delivered);
  return next.text === previous.text &&
    next.count === previous.count &&
    next.delivered === previous.delivered &&
    sameFailures(next.failures, previous.failures)
    ? previous
    : next;
}
