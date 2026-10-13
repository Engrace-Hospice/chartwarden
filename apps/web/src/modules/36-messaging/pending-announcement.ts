// What the outbox's live region says (pending-message-row): one text per event, never the same text twice in a row, so a
// screen reader announces every transition - a message queued, a retry that failed again or got no answer, a refusal,
// a delivery. Events that land in the same render are joined, never dropped.
import type { OutboxItem } from "./use-outbox";

export interface AnnouncementState {
  readonly channelId: string;
  readonly count: number;
  readonly delivered: number;
  /** Per item: how many answered failures / no-response retries were already announced. */
  readonly failures: Readonly<Record<string, number>>;
  readonly offline: Readonly<Record<string, number>>;
  readonly text: string;
}

const countsOf = (
  items: readonly OutboxItem[],
  read: (item: OutboxItem) => number,
  previous?: Readonly<Record<string, number>>,
) =>
  Object.fromEntries(
    items.map((item) => [item.localId, previous ? (previous[item.localId] ?? 0) : read(item)]),
  );
const failCountOf = (item: OutboxItem) => item.failCount ?? 0;
const offlineCountOf = (item: OutboxItem) => item.offlineCount ?? 0;

/** Opening another channel is not an event: start quiet from what it already holds. */
export function initialAnnouncement(
  channelId: string,
  items: readonly OutboxItem[],
  delivered: number,
): AnnouncementState {
  return {
    channelId,
    count: items.length,
    delivered,
    failures: countsOf(items, failCountOf),
    offline: countsOf(items, offlineCountOf),
    text: "",
  };
}

function itemEvents(
  previous: AnnouncementState,
  items: readonly OutboxItem[],
): { texts: string[]; failures: Record<string, number>; offline: Record<string, number> } {
  const texts: string[] = [];
  const failures = { ...countsOf(items, failCountOf, previous.failures) };
  const offline = { ...countsOf(items, offlineCountOf, previous.offline) };
  for (const [index, item] of items.entries()) {
    const place = `message ${index + 1} of ${items.length}`;
    const failed = failCountOf(item);
    if (item.error && failed > (previous.failures[item.localId] ?? failed)) {
      failures[item.localId] = failed;
      texts.push(
        item.permanent
          ? `Not sent, ${place}: ${item.error}`
          : `Retry failed for ${place}, attempt ${failed}: ${item.error}`,
      );
    }
    const silent = offlineCountOf(item);
    if (silent > (previous.offline[item.localId] ?? silent)) {
      offline[item.localId] = silent;
      texts.push(`Still offline, ${place} not sent (attempt ${silent})`);
    }
  }
  return { texts, failures, offline };
}

function nextState(
  previous: AnnouncementState,
  items: readonly OutboxItem[],
  delivered: number,
): AnnouncementState {
  const waiting = items.length;
  const { texts, failures, offline } = itemEvents(previous, items);
  const events: string[] = [];
  if (delivered > previous.delivered) {
    events.push(waiting > 0 ? `Message sent (${waiting} waiting)` : "Message sent");
  }
  if (waiting > previous.count) events.push(`Message not sent (${waiting} waiting)`);
  events.push(...texts);
  const text =
    events.length > 0 ? events.join(". ") : waiting < previous.count ? "" : previous.text;
  return { channelId: previous.channelId, count: waiting, delivered, failures, offline, text };
}

const sameCounts = (a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>) => {
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
    sameCounts(next.failures, previous.failures) &&
    sameCounts(next.offline, previous.offline)
    ? previous
    : next;
}
