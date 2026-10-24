import type { AckQueueItemDto, HandoffDto, TaskDto } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { type InboxChannel, type InboxPorts, createSmartInboxService } from "./inbox-service";

const NOW = new Date("2026-10-23T12:00:00.000Z");
const ago = (min: number): string => new Date(NOW.getTime() - min * 60_000).toISOString();
const ahead = (min: number): string => new Date(NOW.getTime() + min * 60_000).toISOString();
const actor = { orgId: "org-1", userId: "u-1" };

const ack = (id: string, over: Partial<AckQueueItemDto> = {}): AckQueueItemDto =>
  ({
    restricted: false,
    id,
    channel_id: `ch-${id}`,
    message_id: `m-${id}`,
    patient_id: null,
    ack_class: "urgent",
    addressed_role: null,
    status: "pending",
    assigned_user_id: "u-1",
    assigned_display_name: "Me",
    requested_at: ago(30),
    deadline_at: ahead(10),
    overdue: false,
    overdue_seconds: 0,
    current_tier: 0,
    escalation_note: null,
    delivery_failed: false,
    requester_display_name: "Sender",
    request_ref: id,
    ...over,
  }) as unknown as AckQueueItemDto;

const task = (id: string, over: Partial<TaskDto> = {}): TaskDto =>
  ({
    id,
    message_id: "m",
    channel_id: `ch-${id}`,
    status: "open",
    clinical_concern: false,
    overdue: false,
    due_at: null,
    created_at: ago(120),
    ...over,
  }) as unknown as TaskDto;

const handoff = (id: string, expiresInMin: number): HandoffDto =>
  ({
    id,
    state: "offered",
    offered_at: ago(20),
    expires_at: ahead(expiresInMin),
    allowed_actions: ["accept", "decline"],
  }) as unknown as HandoffDto;

const channel = (id: string, over: Partial<InboxChannel> = {}): InboxChannel => ({
  channelId: id,
  kind: "care_team",
  unreadCount: 0,
  mentionCount: 0,
  lastActivityAt: ago(5),
  ...over,
});

function build(over: Partial<InboxPorts> = {}) {
  const ports: InboxPorts = {
    isEnabled: async () => true,
    urgentAcks: async () => ({ items: [], complete: true }),
    handoffs: async () => [],
    tasks: async () => [],
    channels: async () => [],
    now: () => NOW,
    ...over,
  };
  return createSmartInboxService(ports);
}

describe("smart inbox service", () => {
  it("is a disabled empty answer when the tenant flag is off, and reads no source", async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      return [];
    };
    const svc = build({
      isEnabled: async () => false,
      tasks: read,
      handoffs: read,
      channels: read,
    });
    const out = await svc.list(actor, { limit: 50 });
    expect(out.enabled).toBe(false);
    expect(out.items).toEqual([]);
    expect(reads).toBe(0);
  });

  it("treats an unreadable flag as off (fail closed)", async () => {
    const svc = build({
      isEnabled: async () => {
        throw new Error("flag store down");
      },
    });
    expect((await svc.list(actor, { limit: 50 })).enabled).toBe(false);
  });

  it("ranks bands in the fixed order urgent, handoff, task, mention, care-team", async () => {
    const svc = build({
      urgentAcks: async () => ({ items: [ack("a1")], complete: true }),
      handoffs: async () => [handoff("h1", 300)],
      tasks: async () => [task("t1")],
      channels: async () => [
        channel("c-unread", { unreadCount: 3 }),
        channel("c-mention", { unreadCount: 1, mentionCount: 1 }),
      ],
    });
    const out = await svc.list(actor, { limit: 50 });
    expect(out.items.map((i) => i.band)).toEqual([
      "urgent_ack",
      "handoff_awaiting",
      "task_assigned",
      "mention",
      "care_team_unread",
    ]);
    expect(out.items.map((i) => i.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("puts the most overdue urgent request first, and an unreachable one ahead of a merely waiting one", async () => {
    const svc = build({
      urgentAcks: async () => ({
        items: [
          ack("waiting"),
          ack("late", { overdue: true, overdue_seconds: 600, deadline_at: ago(10) }),
          ack("later", { overdue: true, overdue_seconds: 1800, deadline_at: ago(30) }),
          ack("dead", { status: "failed_unreachable", delivery_failed: true }),
        ],
        complete: true,
      }),
    });
    const out = await svc.list(actor, { limit: 50 });
    expect(out.items.map((i) => i.key)).toEqual([
      "ack:dead",
      "ack:later",
      "ack:late",
      "ack:waiting",
    ]);
    expect(out.items[0]?.reasons[0]?.code).toBe("ack_failed_unreachable");
    expect(out.items[1]?.reasons[0]?.code).toBe("ack_overdue");
    expect(out.items[3]?.reasons[0]?.code).toBe("ack_waiting");
  });

  it("never cuts an urgent row, however small the limit and however many lower rows exist", async () => {
    const svc = build({
      urgentAcks: async () => ({ items: [ack("a1"), ack("a2"), ack("a3")], complete: true }),
      tasks: async () => Array.from({ length: 20 }, (_, i) => task(`t${i}`)),
    });
    const out = await svc.list(actor, { limit: 1 });
    expect(out.items.filter((i) => i.band === "urgent_ack")).toHaveLength(3);
    expect(out.complete).toBe(false);
    expect(out.band_counts.task_assigned).toBe(20);
  });

  it("flags an urgent list the source could not return whole", async () => {
    const svc = build({ urgentAcks: async () => ({ items: [ack("a1")], complete: false }) });
    expect((await svc.list(actor, { limit: 50 })).urgent_complete).toBe(false);
  });

  it("keeps a restricted request in the queue with no ids", async () => {
    const svc = build({
      urgentAcks: async () => ({
        items: [ack("r1", { restricted: true, id: null, channel_id: null, message_id: null })],
        complete: true,
      }),
    });
    const [row] = (await svc.list(actor, { limit: 50 })).items;
    expect(row?.restricted).toBe(true);
    expect(row?.channel_id).toBeNull();
    expect(row?.target_id).toBeNull();
    expect(row?.key).toBe("ack:r1");
  });

  it("ranks handoffs by soonest expiry and says so when it is within the hour", async () => {
    const svc = build({ handoffs: async () => [handoff("far", 500), handoff("soon", 20)] });
    const out = await svc.list(actor, { limit: 50 });
    expect(out.items.map((i) => i.target_id)).toEqual(["soon", "far"]);
    expect(out.items[0]?.reasons[0]?.code).toBe("handoff_expires_soon");
    expect(out.items[1]?.reasons[0]?.code).toBe("handoff_waiting");
  });

  it("ignores a handoff the caller cannot accept", async () => {
    const svc = build({
      handoffs: async () => [
        { ...handoff("x", 30), allowed_actions: ["cancel"] } as unknown as HandoffDto,
      ],
    });
    expect((await svc.list(actor, { limit: 50 })).items).toEqual([]);
  });

  it("ranks tasks overdue, then clinical concern, then due, then open, each with its reason", async () => {
    const svc = build({
      tasks: async () => [
        task("open"),
        task("due", { due_at: ahead(90) }),
        task("concern", { clinical_concern: true }),
        task("overdue", { overdue: true, due_at: ago(5) }),
      ],
    });
    const out = await svc.list(actor, { limit: 50 });
    expect(out.items.map((i) => i.target_id)).toEqual(["overdue", "concern", "due", "open"]);
    expect(out.items.map((i) => i.reasons[0]?.code)).toEqual([
      "task_overdue",
      "task_clinical_concern",
      "task_due",
      "task_open",
    ]);
  });

  it("lists a conversation once: a mention outranks plain unread in the same channel", async () => {
    const svc = build({
      channels: async () => [channel("c1", { unreadCount: 4, mentionCount: 1 })],
    });
    const out = await svc.list(actor, { limit: 50 });
    expect(out.items).toHaveLength(1);
    expect(out.items[0]?.band).toBe("mention");
    expect(out.items[0]?.count).toBe(4);
  });

  it("only surfaces unread care-team conversations, not unread DMs or announcements", async () => {
    const svc = build({
      channels: async () => [
        channel("dm", { kind: "dm", unreadCount: 2 }),
        channel("ann", { kind: "announcement", unreadCount: 2 }),
        channel("ct", { kind: "care_team", unreadCount: 2 }),
        channel("read", { kind: "care_team", unreadCount: 0 }),
      ],
    });
    const out = await svc.list(actor, { limit: 50 });
    expect(out.items.map((i) => i.channel_id)).toEqual(["ct"]);
  });

  it("is deterministic: the same inputs in any order give the same list", async () => {
    const tasks = [task("b", { due_at: ahead(5) }), task("a", { due_at: ahead(5) })];
    const one = await build({ tasks: async () => tasks }).list(actor, { limit: 50 });
    const two = await build({ tasks: async () => [...tasks].reverse() }).list(actor, { limit: 50 });
    expect(one.items).toEqual(two.items);
    expect(one.items.map((i) => i.target_id)).toEqual(["a", "b"]);
  });

  it("degrades per source: a failing source is named and the others still show", async () => {
    const svc = build({
      tasks: async () => {
        throw new Error("boom");
      },
      urgentAcks: async () => ({ items: [ack("a1")], complete: true }),
    });
    const out = await svc.list(actor, { limit: 50 });
    expect(out.unavailable_sources).toEqual(["task_assigned"]);
    expect(out.items).toHaveLength(1);
  });

  it("names an unreadable urgent source rather than showing a falsely empty queue", async () => {
    const svc = build({
      urgentAcks: async () => {
        throw new Error("db down");
      },
    });
    const out = await svc.list(actor, { limit: 50 });
    expect(out.unavailable_sources).toEqual(["urgent_ack"]);
    expect(out.urgent_complete).toBe(false);
  });
});
