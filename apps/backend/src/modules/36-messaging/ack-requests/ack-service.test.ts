// WP 4.2 - the acknowledgment-request service over the in-memory store: who may do what, idempotent repeats, the window on a
// reassign, and the rule that nothing but an explicit transition by the assignee writes an acknowledgment.
import { ACK_DEADLINE_POLICY } from "@wardenx/types";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type AckService,
  type AckServiceDeps,
  ackGuardName,
  createAckService,
} from "./ack-service";
import { type MemoryAckStore, createMemoryAckStore } from "./ack-store-memory";

const ORG = "11111111-1111-4111-8111-111111111111";
const CHANNEL = "22222222-2222-4222-8222-222222222222";
const OTHER_CHANNEL = "22222222-2222-4222-8222-222222222299";
const PATIENT = "33333333-3333-4333-8333-333333333333";
const MSG = "44444444-4444-4444-8444-444444444444";
const AUTHOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NURSE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NURSE2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AIDE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OUTSIDER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const T0 = new Date("2026-10-15T12:00:00.000Z");

interface Kit {
  service: AckService;
  store: MemoryAckStore;
  published: Array<{ eventName: string; payload: Record<string, unknown> }>;
  setNow: (d: Date) => void;
  logged: Array<{ message: string; context: Record<string, string> }>;
  knobs: {
    enabled: boolean;
    qualified: Set<string>;
    stillQualifiedError: boolean;
    flagError: boolean;
    canRaise: Set<string>;
    canRaiseError: boolean;
    viewers: Set<string>;
    team: string[];
  };
}

function kit(): Kit {
  const store = createMemoryAckStore();
  store.messages.set(MSG, {
    channelId: CHANNEL,
    authorUserId: AUTHOR,
    status: "sent",
    urgency: "routine",
    urgentRecipientUserId: null,
  });
  const published: Kit["published"] = [];
  const logged: Kit["logged"] = [];
  let now = T0;
  const knobs: Kit["knobs"] = {
    enabled: true,
    qualified: new Set([NURSE, NURSE2]),
    stillQualifiedError: false,
    flagError: false,
    canRaise: new Set([AUTHOR]),
    canRaiseError: false,
    viewers: new Set([AUTHOR, NURSE, NURSE2, AIDE]),
    team: [AUTHOR, NURSE, NURSE2, AIDE],
  };
  const deps: AckServiceDeps = {
    isEnabled: async () => {
      if (knobs.flagError) throw new Error("flag store down");
      return knobs.enabled;
    },
    store,
    outbox: {
      publish: async (_tx, e) => {
        published.push({ eventName: e.eventName, payload: e.payload });
      },
    },
    canViewChannel: async (_o, userId) => knobs.viewers.has(userId),
    channelFacts: async (_o, channelId) =>
      channelId === CHANNEL
        ? { kind: "care_team", subjectId: PATIENT }
        : { kind: "direct", subjectId: null },
    careTeamMembers: async () => knobs.team,
    isQualified: async (_o, userId) => knobs.qualified.has(userId),
    stillQualified: async (_o, userId) => {
      if (knobs.stillQualifiedError) throw new Error("db down");
      return knobs.qualified.has(userId);
    },
    canRaise: async (_o, userId) => {
      if (knobs.canRaiseError) throw new Error("permission store down");
      return knobs.canRaise.has(userId);
    },
    log: (message, context) => logged.push({ message, context }),
    now: () => now,
  };
  return {
    logged,
    service: createAckService(deps),
    store,
    published,
    knobs,
    setNow: (d) => {
      now = d;
    },
  };
}

const actor = (userId: string) => ({ orgId: ORG, userId });

describe("create (important)", () => {
  let k: Kit;
  beforeEach(() => {
    k = kit();
  });

  it("stores a pending request with the 60 minute default, one requested event and one outbox row", async () => {
    const res = await k.service.create(actor(AUTHOR), { messageId: MSG, assigneeUserId: NURSE });

    expect(res.created).toBe(true);
    expect(res.request).toMatchObject({
      ack_class: "important",
      status: "pending",
      assigned_user_id: NURSE,
      requester_user_id: AUTHOR,
      patient_id: PATIENT,
      deadline_at: new Date(T0.getTime() + 60 * 60_000).toISOString(),
      requested_at: T0.toISOString(),
    });
    expect(k.store.events.map((e) => e.eventType)).toEqual(["requested"]);
    expect(k.published.map((p) => p.eventName)).toEqual(["m36.ack.requested"]);
  });

  it("publishes ids only (no patient id, no text)", async () => {
    await k.service.create(actor(AUTHOR), { messageId: MSG, assigneeUserId: NURSE });

    const payload = k.published[0]?.payload ?? {};
    expect(Object.keys(payload).sort()).toEqual(
      [
        "ackClass",
        "actorUserId",
        "assignedUserId",
        "at",
        "channelId",
        "messageId",
        "organizationId",
        "requestId",
        "requestVersion",
      ].sort(),
    );
    expect(JSON.stringify(payload)).not.toContain(PATIENT);
  });

  it("is the uniform 404 while the flag is off, and writes nothing", async () => {
    k.knobs.enabled = false;

    await expect(
      k.service.create(actor(AUTHOR), { messageId: MSG, assigneeUserId: NURSE }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(k.store.requests.size).toBe(0);
    expect(k.published).toEqual([]);
  });

  it("is 503 (never a fake 404) when the flag cannot be read, and writes nothing", async () => {
    k.knobs.flagError = true;

    await expect(
      k.service.create(actor(AUTHOR), { messageId: MSG, assigneeUserId: NURSE }),
    ).rejects.toMatchObject({ statusCode: 503, code: "ACK_UNAVAILABLE" });
    expect(k.store.requests.size).toBe(0);
    expect(k.published).toEqual([]);
  });

  it.each([
    ["a non-author", NURSE2, 403, "ACK_NOT_REQUESTER"],
    ["someone who cannot see the channel", OUTSIDER, 404, "NOT_FOUND"],
  ])("refuses %s", async (_label, caller, status, code) => {
    await expect(
      k.service.create(actor(caller), { messageId: MSG, assigneeUserId: NURSE }),
    ).rejects.toMatchObject({ statusCode: status, code });
    expect(k.store.requests.size).toBe(0);
  });

  it.each([
    ["the author", AUTHOR],
    ["an aide (not qualified)", AIDE],
    ["someone off the care team", OUTSIDER],
  ])("refuses to name %s with the same 422", async (_label, assignee) => {
    await expect(
      k.service.create(actor(AUTHOR), { messageId: MSG, assigneeUserId: assignee }),
    ).rejects.toMatchObject({ statusCode: 422, code: "ACK_ASSIGNEE_INVALID" });
    expect(k.store.requests.size).toBe(0);
  });

  it("refuses an assignee who cannot see the channel", async () => {
    k.knobs.viewers.delete(NURSE);

    await expect(
      k.service.create(actor(AUTHOR), { messageId: MSG, assigneeUserId: NURSE }),
    ).rejects.toMatchObject({ code: "ACK_ASSIGNEE_INVALID" });
  });

  it("refuses a message outside a patient care-team channel", async () => {
    k.store.messages.set(MSG, {
      channelId: OTHER_CHANNEL,
      authorUserId: AUTHOR,
      status: "sent",
      urgency: "routine",
      urgentRecipientUserId: null,
    });

    await expect(
      k.service.create(actor(AUTHOR), { messageId: MSG, assigneeUserId: NURSE }),
    ).rejects.toMatchObject({ statusCode: 422, code: "ACK_NOT_PATIENT_CHANNEL" });
  });

  it("treats a deleted message as not found", async () => {
    k.store.messages.set(MSG, {
      channelId: CHANNEL,
      authorUserId: AUTHOR,
      status: "deleted",
      urgency: "routine",
      urgentRecipientUserId: null,
    });

    await expect(
      k.service.create(actor(AUTHOR), { messageId: MSG, assigneeUserId: NURSE }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("replays an identical request (200, nothing new) even after the assignee lost qualification", async () => {
    await k.service.create(actor(AUTHOR), { messageId: MSG, assigneeUserId: NURSE });
    k.knobs.qualified.delete(NURSE);

    const again = await k.service.create(actor(AUTHOR), { messageId: MSG, assigneeUserId: NURSE });

    expect(again.created).toBe(false);
    expect(again.changed).toBe(false);
    expect(k.store.events).toHaveLength(1);
    expect(k.published).toHaveLength(1);
  });

  it("answers 409 when the message already has a request for someone else", async () => {
    await k.service.create(actor(AUTHOR), { messageId: MSG, assigneeUserId: NURSE });

    await expect(
      k.service.create(actor(AUTHOR), { messageId: MSG, assigneeUserId: NURSE2 }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ACK_ALREADY_REQUESTED" });
  });

  it("requires an urgent message's request to name its recipient", async () => {
    k.store.messages.set(MSG, {
      channelId: CHANNEL,
      authorUserId: AUTHOR,
      status: "sent",
      urgency: "urgent",
      urgentRecipientUserId: NURSE,
    });

    await expect(
      k.service.create(actor(AUTHOR), { messageId: MSG, assigneeUserId: NURSE2 }),
    ).rejects.toMatchObject({ code: "ACK_ASSIGNEE_INVALID" });
    const ok = await k.service.create(actor(AUTHOR), { messageId: MSG, assigneeUserId: NURSE });
    expect(ok.request.ack_class).toBe("urgent");
    expect(ok.request.deadline_at).toBe(new Date(T0.getTime() + 15 * 60_000).toISOString());
  });
});

describe("createForUrgentSend (the send transaction's hook)", () => {
  it("creates an urgent request with the 15 minute default and publishes the requested event", async () => {
    const k = kit();

    await k.service.createForUrgentSend(
      {},
      {
        orgId: ORG,
        messageId: MSG,
        channelId: CHANNEL,
        patientId: PATIENT,
        requesterUserId: AUTHOR,
        assigneeUserId: NURSE,
      },
    );

    const [row] = [...k.store.requests.values()];
    expect(row).toMatchObject({ ackClass: "urgent", status: "pending", assignedUserId: NURSE });
    expect(row?.deadlineAt.getTime()).toBe(
      T0.getTime() + ACK_DEADLINE_POLICY.urgent.defaultMinutes * 60_000,
    );
    expect(k.published.map((p) => p.eventName)).toEqual(["m36.ack.requested"]);
  });
});

async function pending(k: Kit): Promise<string> {
  const res = await k.service.create(actor(AUTHOR), { messageId: MSG, assigneeUserId: NURSE });
  return res.request.id;
}

describe("acknowledge", () => {
  let k: Kit;
  let id: string;
  beforeEach(async () => {
    k = kit();
    id = await pending(k);
    k.store.events.length = 0;
    k.published.length = 0;
  });

  it("is an explicit action by the assignee: status, actor, one event, one outbox row", async () => {
    k.setNow(new Date(T0.getTime() + 60_000));

    const res = await k.service.acknowledge(actor(NURSE), id);

    expect(res.changed).toBe(true);
    expect(res.request).toMatchObject({
      status: "acknowledged",
      acknowledged_by_user_id: NURSE,
      acknowledged_at: new Date(T0.getTime() + 60_000).toISOString(),
    });
    expect(k.store.events).toMatchObject([
      {
        eventType: "acknowledged",
        actorUserId: NURSE,
        fromStatus: "pending",
        toStatus: "acknowledged",
      },
    ]);
    expect(k.published.map((p) => p.eventName)).toEqual(["m36.ack.acknowledged"]);
  });

  it.each([
    ["the author", AUTHOR],
    ["another recipient", NURSE2],
    ["an aide", AIDE],
  ])("refuses %s (not the assignee) and writes nothing", async (_label, caller) => {
    await expect(k.service.acknowledge(actor(caller), id)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(k.store.events).toEqual([]);
    expect(k.published).toEqual([]);
    expect([...k.store.requests.values()][0]?.status).toBe("pending");
  });

  it("is the uniform 404 for someone who cannot see the channel", async () => {
    await expect(k.service.acknowledge(actor(OUTSIDER), id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("refuses an assignee who is no longer qualified, with a clean 403", async () => {
    k.knobs.qualified.delete(NURSE);

    await expect(k.service.acknowledge(actor(NURSE), id)).rejects.toMatchObject({
      statusCode: 403,
      code: "ACK_NOT_QUALIFIED",
    });
    expect(k.store.events).toEqual([]);
  });

  it("propagates a qualification lookup error instead of calling it a refusal", async () => {
    k.knobs.stillQualifiedError = true;

    await expect(k.service.acknowledge(actor(NURSE), id)).rejects.toThrow("db down");
    expect(k.store.events).toEqual([]);
  });

  it("is idempotent: a second acknowledge by the same person changes nothing", async () => {
    await k.service.acknowledge(actor(NURSE), id);

    const again = await k.service.acknowledge(actor(NURSE), id);

    expect(again.changed).toBe(false);
    expect(k.store.events).toHaveLength(1);
    expect(k.published).toHaveLength(1);
  });

  it("cannot acknowledge a resolved or cancelled request", async () => {
    await k.service.acknowledge(actor(NURSE), id);
    await k.service.resolve(actor(NURSE), id);

    await expect(k.service.acknowledge(actor(NURSE), id)).rejects.toMatchObject({
      statusCode: 409,
      code: "ACK_STATE_INVALID",
    });
  });

  it("never acknowledges on a read: get and list write nothing", async () => {
    await k.service.get(actor(NURSE), id);
    await k.service.listForChannel(actor(NURSE), CHANNEL);
    await k.service.get(actor(AUTHOR), id);

    expect(k.store.events).toEqual([]);
    expect(k.published).toEqual([]);
    expect([...k.store.requests.values()][0]?.status).toBe("pending");
  });
});

describe("resolve", () => {
  let k: Kit;
  let id: string;
  beforeEach(async () => {
    k = kit();
    id = await pending(k);
  });

  it("is refused before the request is acknowledged", async () => {
    await expect(k.service.resolve(actor(NURSE), id)).rejects.toMatchObject({
      statusCode: 409,
      code: "ACK_NOT_ACKNOWLEDGED",
    });
  });

  it("closes an acknowledged request once, with the actor, and repeats idempotently", async () => {
    await k.service.acknowledge(actor(NURSE), id);
    k.store.events.length = 0;
    k.published.length = 0;

    const done = await k.service.resolve(actor(NURSE), id);
    const again = await k.service.resolve(actor(NURSE), id);

    expect(done.request.status).toBe("resolved");
    expect(again.changed).toBe(false);
    expect(k.store.events).toMatchObject([{ eventType: "resolved", actorUserId: NURSE }]);
    expect(k.published.map((p) => p.eventName)).toEqual(["m36.ack.resolved"]);
  });

  it("is for the assignee only", async () => {
    await k.service.acknowledge(actor(NURSE), id);

    await expect(k.service.resolve(actor(AUTHOR), id)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("reassign", () => {
  let k: Kit;
  let id: string;
  beforeEach(async () => {
    k = kit();
    id = await pending(k);
    k.store.events.length = 0;
    k.published.length = 0;
  });

  it("restarts the window for the new assignee and keeps the original requested_at", async () => {
    const later = new Date(T0.getTime() + 20 * 60_000);
    k.setNow(later);

    const res = await k.service.reassign(actor(AUTHOR), id, NURSE2);

    expect(res.request).toMatchObject({
      status: "pending",
      assigned_user_id: NURSE2,
      requested_at: T0.toISOString(),
      window_started_at: later.toISOString(),
      deadline_at: new Date(later.getTime() + 60 * 60_000).toISOString(),
      acknowledged_at: null,
    });
    expect(k.store.events).toMatchObject([
      {
        eventType: "reassigned",
        actorUserId: AUTHOR,
        assignedUserId: NURSE2,
        previousAssignedUserId: NURSE,
      },
    ]);
    expect(k.published.map((p) => p.eventName)).toEqual(["m36.ack.reassigned"]);
    expect(k.published[0]?.payload.previousAssignedUserId).toBe(NURSE);
  });

  it("lets the assignee hand an acknowledged request on (back to pending)", async () => {
    await k.service.acknowledge(actor(NURSE), id);

    const res = await k.service.reassign(actor(NURSE), id, NURSE2);

    expect(res.request).toMatchObject({
      status: "pending",
      assigned_user_id: NURSE2,
      acknowledged_at: null,
      acknowledged_by_user_id: null,
    });
  });

  it("is for the two parties only", async () => {
    await expect(k.service.reassign(actor(AIDE), id, NURSE2)).rejects.toMatchObject({
      statusCode: 403,
      code: "ACK_NOT_PARTY",
    });
    expect(k.store.events).toEqual([]);
  });

  it.each([
    ["an unqualified colleague", AIDE],
    ["the requester", AUTHOR],
    ["the current assignee", NURSE],
    ["someone off the care team", OUTSIDER],
  ])("refuses %s as the new assignee", async (_label, target) => {
    await expect(k.service.reassign(actor(AUTHOR), id, target)).rejects.toMatchObject({
      statusCode: 422,
      code: "ACK_ASSIGNEE_INVALID",
    });
    expect(k.store.events).toEqual([]);
  });

  it("answers a repeat by the same actor as a success without a second event", async () => {
    await k.service.reassign(actor(AUTHOR), id, NURSE2);

    const again = await k.service.reassign(actor(AUTHOR), id, NURSE2);

    expect(again.changed).toBe(false);
    expect(k.store.events).toHaveLength(1);
  });

  it("is refused on a closed request", async () => {
    await k.service.acknowledge(actor(NURSE), id);
    await k.service.resolve(actor(NURSE), id);

    await expect(k.service.reassign(actor(AUTHOR), id, NURSE2)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe("reassign - who may hand an acknowledged request on", () => {
  let k: Kit;
  let id: string;
  beforeEach(async () => {
    k = kit();
    id = await pending(k);
    await k.service.acknowledge(actor(NURSE), id);
    k.store.events.length = 0;
    k.published.length = 0;
  });

  it("refuses the requester once the request is taken: nothing changes and no event is written", async () => {
    await expect(k.service.reassign(actor(AUTHOR), id, NURSE2)).rejects.toMatchObject({
      statusCode: 403,
      code: "ACK_NOT_ASSIGNEE",
    });
    expect(k.store.requests.get(id)?.status).toBe("acknowledged");
    expect(k.store.events).toEqual([]);
    expect(k.published).toEqual([]);
  });

  it("lets the assignee hand it on even when her own role lapsed and she cannot raise requests (it must not strand)", async () => {
    k.knobs.qualified.delete(NURSE);
    k.knobs.canRaise.clear();

    const res = await k.service.reassign(actor(NURSE), id, NURSE2);

    expect(res.request).toMatchObject({ status: "pending", assigned_user_id: NURSE2 });
  });

  it("keeps the earlier acknowledgment in the history when the assignee hands it on", async () => {
    await k.service.reassign(actor(NURSE), id, NURSE2);

    const types = k.store.events.map((e) => e.eventType);
    expect(types).toEqual(["reassigned"]);
    expect(k.store.events[0]).toMatchObject({
      fromStatus: "acknowledged",
      toStatus: "pending",
      previousAssignedUserId: NURSE,
    });
  });

  it("makes the requester pass a LIVE urgent.send check while the request is still waiting", async () => {
    const waiting = kit();
    const waitingId = await pending(waiting);
    waiting.knobs.canRaise.clear();

    await expect(waiting.service.reassign(actor(AUTHOR), waitingId, NURSE2)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(waiting.store.requests.get(waitingId)?.assignedUserId).toBe(NURSE);
  });

  it("propagates a failed permission lookup for the requester (a failure is not a 'no')", async () => {
    const waiting = kit();
    const waitingId = await pending(waiting);
    waiting.knobs.canRaiseError = true;

    await expect(waiting.service.reassign(actor(AUTHOR), waitingId, NURSE2)).rejects.toThrow(
      "permission store down",
    );
  });
});

describe("database guards on a race", () => {
  const pgError = (code: string, extra: Record<string, string> = {}) =>
    Object.assign(new Error("Failed query"), {
      cause: Object.assign(new Error("x"), { code, ...extra }),
    });

  it.each([
    [
      "a CHECK constraint",
      { constraint: "message_ack_request_window" },
      "message_ack_request_window",
    ],
    [
      "a transition trigger",
      { message: "message_ack_request_transition: a -> b" },
      "message_ack_request_transition",
    ],
    [
      "the insert guard",
      { message: "message_ack_request: the message is missing" },
      "message_ack_request",
    ],
    ["the history guard", { message: "message_ack_event_status: x" }, "message_ack_event_status"],
  ])("names %s", (_label, extra, expected) => {
    expect(ackGuardName(pgError("23514", extra))).toBe(expected);
  });

  it("does not treat any other 23514, or another SQLSTATE, as an ack guard", () => {
    expect(ackGuardName(pgError("23514", { constraint: "outbox_event_payload_check" }))).toBeNull();
    expect(
      ackGuardName(pgError("23505", { constraint: "message_ack_request_one_per_message" })),
    ).toBeNull();
    expect(ackGuardName(new Error("plain"))).toBeNull();
  });

  /** The first store call (the visibility read) is real; the write that follows fails with `error`. */
  const failWrite = (k: Kit, error: unknown): void => {
    const real = k.store.run.bind(k.store);
    let calls = 0;
    k.store.run = ((actorRef: never, fn: never) => {
      calls += 1;
      if (calls === 1) return real(actorRef, fn);
      return Promise.reject(error);
    }) as typeof k.store.run;
  };

  it("a known guard that fires on a race is a 409 and is logged by name with ids only", async () => {
    const k = kit();
    const id = await pending(k);
    failWrite(
      k,
      pgError("23514", { message: "message_ack_request_actor: only the assigned user" }),
    );

    await expect(k.service.acknowledge(actor(NURSE), id)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(k.logged).toContainEqual({
      message: "database guard refused a transition",
      context: { organizationId: ORG, requestId: id, guard: "message_ack_request_actor" },
    });
  });

  it("an unknown 23514 stays a server fault (rethrown, logged by constraint name only)", async () => {
    const k = kit();
    const id = await pending(k);
    failWrite(k, pgError("23514", { constraint: "some_other_check" }));

    await expect(k.service.acknowledge(actor(NURSE), id)).rejects.toMatchObject({
      message: "Failed query",
    });
    expect(k.logged).toContainEqual({
      message: "unmapped check violation",
      context: { organizationId: ORG, requestId: id, constraint: "some_other_check" },
    });
  });
});
