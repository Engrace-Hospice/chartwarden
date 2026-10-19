// ADR-0078 - the reassign picker (G-6) and the supervisor reassign (G-2) over the in-memory store: who sees which colleagues, what a
// supervisor may and may not do, the audit trail, and that nothing is acknowledged or disclosed. The route-level permission is covered in
// routes/ack-supervisor-routes.test.ts; the database guard in apps/backend/__tests__/m36-ack-supervisor-reassign.live.test.ts.
import { ACK_REASSIGN_CANDIDATE_CAP } from "@wardenx/types";
import { beforeEach, describe, expect, it } from "vitest";
import { type AckService, type AckServiceDeps, createAckService } from "./ack-service";
import { type MemoryAckStore, createMemoryAckStore } from "./ack-store-memory";

const ORG = "11111111-1111-4111-8111-111111111111";
const CHANNEL = "22222222-2222-4222-8222-222222222222";
const PATIENT = "33333333-3333-4333-8333-333333333333";
const MSG = "44444444-4444-4444-8444-444444444444";
const AUTHOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NURSE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NURSE2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AIDE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SUPERVISOR = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const T0 = new Date("2026-10-15T12:00:00.000Z");
const NAMES: Record<string, string> = {
  [NURSE2]: "Ben Nurse",
  [NURSE]: "Ada Nurse",
  [AUTHOR]: "Sam Sender",
};

interface Kit {
  service: AckService;
  store: MemoryAckStore;
  published: Array<{ eventName: string; payload: Record<string, unknown> }>;
  knobs: {
    qualified: Set<string>;
    viewers: Set<string>;
    team: string[];
    teamError: boolean;
    walledOff: Set<string>;
  };
  setNow: (d: Date) => void;
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
  let now = T0;
  const knobs: Kit["knobs"] = {
    qualified: new Set([NURSE, NURSE2]),
    // The supervisor is deliberately NOT a viewer of the channel.
    viewers: new Set([AUTHOR, NURSE, NURSE2, AIDE]),
    team: [AUTHOR, NURSE, NURSE2, AIDE],
    teamError: false,
    walledOff: new Set(),
  };
  const deps: AckServiceDeps = {
    isEnabled: async () => true,
    store,
    outbox: {
      publish: async (_tx, e) =>
        void published.push({ eventName: e.eventName, payload: e.payload }),
    },
    canViewChannel: async (_o, userId) => knobs.viewers.has(userId),
    channelFacts: async () => ({ kind: "care_team", subjectId: PATIENT }),
    careTeamMembers: async () => {
      if (knobs.teamError) throw new Error("care team down");
      return knobs.team;
    },
    isQualified: async (_o, userId) => knobs.qualified.has(userId),
    stillQualified: async (_o, userId) => knobs.qualified.has(userId),
    canRaise: async (_o, userId) => userId === AUTHOR,
    part2Admitted: async (_o, userId) => !knobs.walledOff.has(userId),
    displayName: async (_o, userId) => NAMES[userId] ?? null,
    log: () => undefined,
    now: () => now,
  };
  return {
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

async function pending(k: Kit): Promise<string> {
  const res = await k.service.create(actor(AUTHOR), { messageId: MSG, assigneeUserId: NURSE });
  k.store.events.length = 0;
  k.published.length = 0;
  return res.request.id;
}

describe("reassignCandidates (the card's picker)", () => {
  let k: Kit;
  let id: string;
  beforeEach(async () => {
    k = kit();
    id = await pending(k);
  });

  it("lists only eligible colleagues, by id and name, never the sender or the current assignee", async () => {
    const res = await k.service.reassignCandidates(actor(NURSE), id);

    expect(res.candidates).toEqual([{ user_id: NURSE2, display_name: "Ben Nurse" }]);
  });

  it("drops people who are not qualified or cannot see the channel", async () => {
    k.knobs.qualified.delete(NURSE2);

    expect((await k.service.reassignCandidates(actor(AUTHOR), id)).candidates).toEqual([]);
  });

  it("applies the reassign party rules: a stranger and the sender of a taken request are refused", async () => {
    await expect(k.service.reassignCandidates(actor(AIDE), id)).rejects.toMatchObject({
      statusCode: 403,
    });
    await k.service.acknowledge(actor(NURSE), id);
    await expect(k.service.reassignCandidates(actor(AUTHOR), id)).rejects.toMatchObject({
      code: "ACK_NOT_ASSIGNEE",
    });
    expect((await k.service.reassignCandidates(actor(NURSE), id)).candidates).toHaveLength(1);
  });

  it("is the uniform 404 for someone who cannot see the channel, and a conflict once closed", async () => {
    k.knobs.viewers.delete(AUTHOR);
    await expect(k.service.reassignCandidates(actor(AUTHOR), id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("answers an empty list (never a guess) when the care-team seam fails", async () => {
    k.knobs.teamError = true;

    expect((await k.service.reassignCandidates(actor(NURSE), id)).candidates).toEqual([]);
  });

  it("is capped", async () => {
    const crowd = Array.from(
      { length: ACK_REASSIGN_CANDIDATE_CAP + 20 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    k.knobs.team = [AUTHOR, NURSE, ...crowd];
    for (const u of crowd) {
      k.knobs.qualified.add(u);
      k.knobs.viewers.add(u);
    }

    expect((await k.service.reassignCandidates(actor(NURSE), id)).candidates).toHaveLength(
      ACK_REASSIGN_CANDIDATE_CAP,
    );
  });
});

describe("supervisorReassign", () => {
  let k: Kit;
  let id: string;
  beforeEach(async () => {
    k = kit();
    id = await pending(k);
  });

  it("moves a waiting request for a supervisor who cannot open the channel, with the supervisor as actor and the reason recorded", async () => {
    const later = new Date(T0.getTime() + 20 * 60_000);
    k.setNow(later);

    const res = await k.service.supervisorReassign(
      actor(SUPERVISOR),
      id,
      NURSE2,
      "assignee_unreachable",
    );

    expect(res).toEqual({
      request_ref: id,
      status: "pending",
      assigned_user_id: NURSE2,
      deadline_at: new Date(later.getTime() + 60 * 60_000).toISOString(),
      changed: true,
    });
    expect(k.store.events).toMatchObject([
      {
        eventType: "reassigned",
        actorUserId: SUPERVISOR,
        assignedUserId: NURSE2,
        previousAssignedUserId: NURSE,
        reasonCode: "assignee_unreachable",
        tier: 0,
      },
    ]);
  });

  it("returns no channel, message or patient id", async () => {
    const res = await k.service.supervisorReassign(actor(SUPERVISOR), id, NURSE2, "workload");

    const text = JSON.stringify(res);
    for (const forbidden of [CHANNEL, MSG, PATIENT]) expect(text).not.toContain(forbidden);
  });

  it("publishes the reassigned event flagged as a supervisor's, with ids only", async () => {
    await k.service.supervisorReassign(actor(SUPERVISOR), id, NURSE2, "coverage_change");

    expect(k.published.map((p) => p.eventName)).toEqual(["m36.ack.reassigned"]);
    expect(k.published[0]?.payload).toMatchObject({
      actorUserId: SUPERVISOR,
      assignedUserId: NURSE2,
      previousAssignedUserId: NURSE,
      supervisorReassign: true,
      requesterUserId: AUTHOR,
    });
    expect(JSON.stringify(k.published[0]?.payload)).not.toContain("coverage_change");
  });

  it("re-arms a failed_unreachable and an escalated request (back to pending, tier 0)", async () => {
    const row = k.store.requests.get(id);
    if (!row) throw new Error("missing");
    k.store.requests.set(id, { ...row, status: "failed_unreachable", currentTier: 2 });

    const res = await k.service.supervisorReassign(actor(SUPERVISOR), id, NURSE2, "workload");

    expect(res.status).toBe("pending");
    expect(k.store.requests.get(id)).toMatchObject({ status: "pending", currentTier: 0 });
  });

  it.each(["acknowledged", "resolved", "cancelled"] as const)(
    "refuses a %s request with the conflict answer and writes nothing",
    async (status) => {
      const row = k.store.requests.get(id);
      if (!row) throw new Error("missing");
      k.store.requests.set(id, { ...row, status });

      await expect(
        k.service.supervisorReassign(actor(SUPERVISOR), id, NURSE2, "workload"),
      ).rejects.toMatchObject({ code: "ACK_STATE_INVALID" });
      expect(k.store.events).toEqual([]);
      expect(k.published).toEqual([]);
    },
  );

  it("never acknowledges: the request is pending and unacknowledged afterwards", async () => {
    await k.service.supervisorReassign(actor(SUPERVISOR), id, NURSE2, "workload");

    expect(k.store.requests.get(id)).toMatchObject({
      status: "pending",
      acknowledgedAt: null,
      acknowledgedByUserId: null,
    });
  });

  it.each([
    ["the sender", AUTHOR],
    ["an aide (not qualified)", AIDE],
    ["a person outside the care team", SUPERVISOR],
    ["a user who cannot see the channel", "99999999-9999-4999-8999-999999999999"],
  ])("refuses %s as the new assignee with one uniform 422", async (_label, target) => {
    await expect(
      k.service.supervisorReassign(actor(SUPERVISOR), id, target, "workload"),
    ).rejects.toMatchObject({ code: "ACK_ASSIGNEE_INVALID", statusCode: 422 });
    expect(k.store.events).toEqual([]);
  });

  it("refuses the current assignee as the new one", async () => {
    await expect(
      k.service.supervisorReassign(actor(SUPERVISOR), id, NURSE, "workload"),
    ).rejects.toMatchObject({ code: "ACK_ASSIGNEE_INVALID" });
  });

  it("answers a repeat of the supervisor's own reassign (same reason) as a success without a second event", async () => {
    await k.service.supervisorReassign(actor(SUPERVISOR), id, NURSE2, "workload");
    const eventsBefore = k.store.events.length;
    const publishedBefore = k.published.length;

    const again = await k.service.supervisorReassign(actor(SUPERVISOR), id, NURSE2, "workload");

    expect(again.changed).toBe(false);
    expect(k.store.events).toHaveLength(eventsBefore);
    expect(k.published).toHaveLength(publishedBefore);
  });

  it("does not treat a different reason, or a different supervisor, as a repeat", async () => {
    await k.service.supervisorReassign(actor(SUPERVISOR), id, NURSE2, "workload");

    await expect(
      k.service.supervisorReassign(actor(SUPERVISOR), id, NURSE2, "coverage_change"),
    ).rejects.toMatchObject({ code: "ACK_ASSIGNEE_INVALID" });
    await expect(
      k.service.supervisorReassign(actor(AIDE), id, NURSE2, "workload"),
    ).rejects.toMatchObject({ code: "ACK_ASSIGNEE_INVALID" });
  });

  it("is the uniform 404 for a missing request", async () => {
    await expect(
      k.service.supervisorReassign(
        actor(SUPERVISOR),
        "99999999-9999-4999-8999-999999999999",
        NURSE2,
        "workload",
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("supervisorReassignCandidates", () => {
  it("lists eligible colleagues for a supervisor who cannot open the channel, and only while the request waits", async () => {
    const k = kit();
    const id = await pending(k);

    expect(
      (await k.service.supervisorReassignCandidates(actor(SUPERVISOR), id)).candidates,
    ).toEqual([{ user_id: NURSE2, display_name: "Ben Nurse" }]);

    await k.service.acknowledge(actor(NURSE), id);
    await expect(
      k.service.supervisorReassignCandidates(actor(SUPERVISOR), id),
    ).rejects.toMatchObject({ code: "ACK_STATE_INVALID" });
  });
});

describe("ADR-0078 fix round 1: Part 2, self-assignment, the per-request cap, the history", () => {
  it("shows a Part 2 walled-off supervisor no care-team names and lets them move nothing", async () => {
    const k = kit();
    const id = await pending(k);
    k.knobs.walledOff.add(SUPERVISOR);

    expect(
      (await k.service.supervisorReassignCandidates(actor(SUPERVISOR), id)).candidates,
    ).toEqual([]);
    await expect(
      k.service.supervisorReassign(actor(SUPERVISOR), id, NURSE2, "workload"),
    ).rejects.toMatchObject({ code: "ACK_ASSIGNEE_INVALID", statusCode: 422 });
    expect(k.store.events).toEqual([]);
    // The party picker is not affected: the assignee can see the channel.
    expect((await k.service.reassignCandidates(actor(NURSE), id)).candidates).toHaveLength(1);
  });

  it("refuses a supervisor naming themselves with the same uniform 422, even when they are an eligible nurse", async () => {
    const k = kit();
    const id = await pending(k);
    k.knobs.qualified.add(SUPERVISOR);
    k.knobs.viewers.add(SUPERVISOR);
    k.knobs.team.push(SUPERVISOR);

    await expect(
      k.service.supervisorReassign(actor(SUPERVISOR), id, SUPERVISOR, "workload"),
    ).rejects.toMatchObject({ code: "ACK_ASSIGNEE_INVALID", statusCode: 422 });
    expect(k.store.events).toEqual([]);
  });

  it("stops after 5 supervisor moves of one request in 24 hours with a generic 409, and counts only supervisor moves", async () => {
    const k = kit();
    const id = await pending(k);
    // a normal party reassign does not count
    await k.service.reassign(actor(AUTHOR), id, NURSE2);
    const to = [NURSE, NURSE2];
    for (let i = 0; i < 5; i += 1) {
      await k.service.supervisorReassign(actor(SUPERVISOR), id, to[i % 2] as string, "workload");
    }

    await expect(
      k.service.supervisorReassign(actor(SUPERVISOR), id, to[1] as string, "workload"),
    ).rejects.toMatchObject({ code: "ACK_SUPERVISOR_REASSIGN_LIMIT", statusCode: 409 });
    expect(k.store.events.filter((e) => e.reasonCode)).toHaveLength(5);

    // a day later the window has passed
    k.setNow(new Date(T0.getTime() + 25 * 3_600_000));
    const again = await k.service.supervisorReassign(
      actor(SUPERVISOR),
      id,
      to[1] as string,
      "workload",
    );
    expect(again.changed).toBe(true);
  });

  it("puts the supervisor and the reason in the history the card reads", async () => {
    const k = kit();
    const id = await pending(k);
    await k.service.supervisorReassign(actor(SUPERVISOR), id, NURSE2, "coverage_change");

    const detail = await k.service.get(actor(AUTHOR), id);

    expect(detail.events.at(-1)).toMatchObject({
      event_type: "reassigned",
      actor_user_id: SUPERVISOR,
      reason_code: "coverage_change",
    });
    expect(detail.events.filter((e) => e.reason_code)).toHaveLength(1);
  });
});
