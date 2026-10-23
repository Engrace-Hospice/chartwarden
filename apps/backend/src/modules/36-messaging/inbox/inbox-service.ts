// apps/backend/src/modules/36-messaging/inbox/inbox-service.ts - WP 6.1 (ADR-0100): the smart work inbox.
//
// A read-only aggregator over the sources M36 already owns (the acknowledgment queue of ADR-0076 narrowed to the caller, tasks, handoffs
// awaiting the caller, conversation unread/mention counts). It reads, ranks and explains; it writes nothing and acknowledges nothing.
//
// Ranking is a fixed rule table, no weights and no model: (1) the band, always in SMART_INBOX_BANDS order, so an urgent request can not be
// out-voted by volume; (2) a sub-rank inside the band; (3) a time (soonest clock first); (4) the stable key. Every row carries the reason
// it ranks where it does. The page limit cuts ONLY below the urgent band; urgent rows are never dropped. A source that fails to read is
// named in `unavailable_sources` (and an unreadable urgent source also clears `urgent_complete`) so the screen never shows a quiet queue
// that is really a broken one.
import {
  type AckQueueItemDto,
  type HandoffDto,
  SMART_INBOX_BANDS,
  SMART_INBOX_HANDOFF_SOON_MINUTES,
  SMART_INBOX_LIMIT_DEFAULT,
  SMART_INBOX_LIMIT_MAX,
  type SmartInboxBand,
  type SmartInboxItemDto,
  type SmartInboxReason,
  type SmartInboxResponse,
  type TaskDto,
} from "@chartwarden/types";

export interface InboxActor {
  readonly orgId: string;
  readonly userId: string;
}

/** The slice of a conversation the inbox needs (a subset of the route service's ChannelSummary). */
export interface InboxChannel {
  readonly channelId: string;
  readonly kind: string;
  readonly unreadCount: number;
  readonly mentionCount: number;
  readonly lastActivityAt: string;
}

export interface InboxPorts {
  /** The ops flag `messaging.smart_inbox`. A throw reads as off. */
  readonly isEnabled: (orgId: string) => Promise<boolean>;
  /** The caller's own waiting acknowledgment requests (ADR-0076 reader, narrowed to the assignee). */
  readonly urgentAcks: (
    actor: InboxActor,
  ) => Promise<{ readonly items: readonly AckQueueItemDto[]; readonly complete: boolean }>;
  /** Incoming active handoffs. [] when the handoffs flag is off. */
  readonly handoffs: (actor: InboxActor) => Promise<readonly HandoffDto[]>;
  /** Active tasks assigned to the caller. [] when the tasks flag is off. */
  readonly tasks: (actor: InboxActor) => Promise<readonly TaskDto[]>;
  readonly channels: (actor: InboxActor) => Promise<readonly InboxChannel[]>;
  readonly now?: () => Date;
}

export interface SmartInboxService {
  list(actor: InboxActor, q: { readonly limit?: number | undefined }): Promise<SmartInboxResponse>;
}

/** A row before it is numbered: `sub` and `t` are its sort keys inside the band (smaller sorts first). */
interface Candidate {
  readonly item: Omit<SmartInboxItemDto, "rank">;
  readonly sub: number;
  readonly t: number;
}

const MS_PER_MINUTE = 60_000;
const TIME_LAST = Number.MAX_SAFE_INTEGER;
/** Conversation kinds that can enter the inbox as unread work. A DM or an announcement is not clinical work waiting on a role. */
const UNREAD_KINDS: ReadonlySet<string> = new Set(["care_team"]);

const reason = (code: SmartInboxReason["code"], text: string): SmartInboxReason => ({ code, text });
const epoch = (iso: string): number => new Date(iso).getTime();
const clampLimit = (limit: number | undefined): number =>
  Math.min(Math.max(Math.trunc(limit ?? SMART_INBOX_LIMIT_DEFAULT), 1), SMART_INBOX_LIMIT_MAX);

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / MS_PER_MINUTE));
  return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
}

function ackCandidate(a: AckQueueItemDto): Candidate {
  const key = `ack:${a.id ?? a.request_ref}`;
  const deadline = epoch(a.deadline_at);
  const unreachable = a.status === "failed_unreachable";
  const why = unreachable
    ? reason("ack_failed_unreachable", "No route reached anyone for this request; it needs a person now.")
    : a.overdue
      ? reason("ack_overdue", `Past its deadline by ${minutes(a.overdue_seconds * 1000)}.`)
      : reason("ack_waiting", "Waiting for you to acknowledge before its deadline.");
  return {
    item: {
      key,
      band: "urgent_ack",
      title: a.restricted ? "Acknowledgment request (restricted conversation)" : "Acknowledgment request",
      reasons: [why],
      since: a.requested_at,
      due_at: a.deadline_at,
      channel_id: a.channel_id,
      target: "acknowledgment_request",
      target_id: a.id,
      restricted: a.restricted,
      count: null,
    },
    sub: unreachable ? 0 : a.overdue ? 1 : 2,
    t: deadline,
  };
}

function handoffCandidate(h: HandoffDto, now: number): Candidate {
  const expires = epoch(h.expires_at);
  const left = expires - now;
  const soon = left <= SMART_INBOX_HANDOFF_SOON_MINUTES * MS_PER_MINUTE;
  return {
    item: {
      key: `handoff:${h.id}`,
      band: "handoff_awaiting",
      title: "Handoff awaiting your answer",
      reasons: [
        soon
          ? reason("handoff_expires_soon", `Offer expires in ${minutes(Math.max(left, 0))}.`)
          : reason("handoff_waiting", "A colleague has offered you their work and is waiting."),
      ],
      since: h.offered_at,
      due_at: h.expires_at,
      channel_id: null,
      target: "handoff",
      target_id: h.id,
      restricted: false,
      count: null,
    },
    sub: soon ? 0 : 1,
    t: expires,
  };
}

function taskCandidate(t: TaskDto): Candidate {
  const overdue = t.overdue;
  const why = overdue
    ? reason("task_overdue", "Past its due time.")
    : t.clinical_concern
      ? reason("task_clinical_concern", "Flagged as a clinical concern.")
      : t.due_at
        ? reason("task_due", "Has a due time.")
        : reason("task_open", "Assigned to you and still open.");
  return {
    item: {
      key: `task:${t.id}`,
      band: "task_assigned",
      title: "Task assigned to you",
      reasons: [why],
      since: t.created_at,
      due_at: t.due_at,
      channel_id: t.channel_id,
      target: "task",
      target_id: t.id,
      restricted: false,
      count: null,
    },
    sub: overdue ? 0 : t.clinical_concern ? 1 : t.due_at ? 2 : 3,
    t: t.due_at ? epoch(t.due_at) : TIME_LAST,
  };
}

/** One row per conversation: a mention wins over plain unread, so a channel is never listed twice. */
function channelCandidate(c: InboxChannel): Candidate | null {
  if (c.unreadCount <= 0 || !UNREAD_KINDS.has(c.kind)) return null;
  const mentioned = c.mentionCount > 0;
  return {
    item: {
      key: `channel:${c.channelId}`,
      band: mentioned ? "mention" : "care_team_unread",
      title: mentioned ? "You were mentioned" : "Unread care-team messages",
      reasons: [
        mentioned
          ? reason("mention_unread", `Mentioned by name in ${c.mentionCount} unread message(s).`)
          : reason("care_team_unread", `${c.unreadCount} unread message(s) from your care team.`),
      ],
      since: c.lastActivityAt,
      due_at: null,
      channel_id: c.channelId,
      target: "conversation",
      target_id: c.channelId,
      restricted: false,
      count: c.unreadCount,
    },
    sub: 0,
    t: -epoch(c.lastActivityAt),
  };
}

const bandIndex = (b: SmartInboxBand): number => SMART_INBOX_BANDS.indexOf(b);

function compare(a: Candidate, b: Candidate): number {
  return (
    bandIndex(a.item.band) - bandIndex(b.item.band) ||
    a.sub - b.sub ||
    a.t - b.t ||
    (a.item.key < b.item.key ? -1 : a.item.key > b.item.key ? 1 : 0)
  );
}

export function createSmartInboxService(ports: InboxPorts): SmartInboxService {
  const clock = ports.now ?? (() => new Date());
  const emptyCounts = (): Record<SmartInboxBand, number> => ({
    urgent_ack: 0,
    handoff_awaiting: 0,
    task_assigned: 0,
    mention: 0,
    care_team_unread: 0,
  });

  return {
    async list(actor, q) {
      const enabled = await ports.isEnabled(actor.orgId).catch(() => false);
      if (!enabled) {
        return {
          enabled: false,
          items: [],
          band_counts: emptyCounts(),
          complete: true,
          urgent_complete: true,
          unavailable_sources: [],
        };
      }
      const now = clock().getTime();
      const unavailable: SmartInboxBand[] = [];
      const guarded = async <T>(band: SmartInboxBand, read: () => Promise<T>, fallback: T) =>
        read().catch(() => {
          unavailable.push(band);
          return fallback;
        });

      const [acks, handoffs, tasks, channels] = await Promise.all([
        guarded("urgent_ack", () => ports.urgentAcks(actor), {
          items: [] as readonly AckQueueItemDto[],
          complete: false,
        }),
        guarded("handoff_awaiting", () => ports.handoffs(actor), [] as readonly HandoffDto[]),
        guarded("task_assigned", () => ports.tasks(actor), [] as readonly TaskDto[]),
        guarded("care_team_unread", () => ports.channels(actor), [] as readonly InboxChannel[]),
      ]);

      const candidates: Candidate[] = [
        ...acks.items.map(ackCandidate),
        ...handoffs.filter((h) => h.allowed_actions.includes("accept")).map((h) => handoffCandidate(h, now)),
        ...tasks.map(taskCandidate),
        ...channels.flatMap((c) => {
          const cand = channelCandidate(c);
          return cand ? [cand] : [];
        }),
      ].sort(compare);

      const ranked = candidates.map(
        (c, i): SmartInboxItemDto => ({ ...c.item, rank: i + 1 }),
      );
      const counts = emptyCounts();
      for (const r of ranked) counts[r.band] += 1;

      // The cut: urgent rows always stay; the limit applies to what is below them.
      const limit = clampLimit(q.limit);
      const urgentCount = counts.urgent_ack;
      const keep = Math.max(urgentCount, limit);
      const items = ranked.slice(0, keep);

      return {
        enabled: true,
        items,
        band_counts: counts,
        complete: items.length === ranked.length,
        urgent_complete: acks.complete,
        unavailable_sources: unavailable,
      };
    },
  };
}
