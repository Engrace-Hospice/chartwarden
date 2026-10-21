// ADR-0081: the role-based send decisions, over a FAKE router (and the REAL deny-stub for the unconnected path), with the real
// escalation-router guard in front so a test source is refused as it is in production.
import type { EscalationRank, EscalationRouteAnswer, EscalationRouter } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { escalationRouterDenyStub } from "../../../bootstrap/seams/providers";
import { guardEscalationRouter } from "../ack-escalation/escalation-router-guard";
import type { UrgentService } from "../urgent/urgent-service";
import { createRoleSendService } from "./role-send-service";

const ORG = "00000000-0000-4000-8000-00000000000a";
const PATIENT = "00000000-0000-4000-8000-0000000000f1";
const OTHER_PATIENT = "00000000-0000-4000-8000-0000000000f2";
const CHANNEL = "00000000-0000-4000-8000-0000000000c1";
const SENDER = "00000000-0000-4000-8000-0000000000b1";
const U1 = "00000000-0000-4000-8000-0000000000a1";
const U2 = "00000000-0000-4000-8000-0000000000a2";
const NOW = new Date("2026-06-01T21:07:00.000Z");
const actor = { orgId: ORG, userId: SENDER };
const target = { channelId: CHANNEL, patientId: PATIENT, role: "rn" as const };
const validate = async () => [];

type Over = {
  enabled?: boolean;
  router?: EscalationRouter;
  channelPatient?: string | null;
  replay?: string | null;
  /** The role stored on the replayed message: "rn" by default, null for a person-send. */
  replayRole?: string | null;
  tier1?: () => EscalationRouteAnswer;
};

function build(over: Over = {}) {
  const calls: { tier: number; role: string }[] = [];
  const sends: Record<string, unknown>[] = [];
  const logs: Record<string, string>[] = [];
  const raw: EscalationRouter = over.router ?? {
    async resolveTier(_org, request) {
      calls.push({ tier: request.tier, role: request.requiredRole });
      const answer = over.tier1?.();
      if (!answer) throw new Error("no answer wired");
      return { ...answer, tier: request.tier, asOf: request.asOf };
    },
  };
  const urgent: Pick<UrgentService, "send"> = {
    async send(_actor, input) {
      sends.push(input as unknown as Record<string, unknown>);
      return {
        message_id: "m1",
        channel_id: input.channelId,
        patient_id: PATIENT,
        recipient_user_id: input.recipientUserId,
        created: true,
      };
    },
  };
  const service = createRoleSendService({
    isEnabled: async () => over.enabled ?? true,
    router: guardEscalationRouter(raw),
    displayName: async (_o, id) => (id === U1 ? "Dana K." : null),
    channelPatient: async () => (over.channelPatient === undefined ? PATIENT : over.channelPatient),
    findReplay: async () =>
      over.replay
        ? { recipient: over.replay, role: over.replayRole === undefined ? "rn" : over.replayRole }
        : null,
    urgent,
    log: (_m, ctx) => logs.push(ctx),
    now: () => NOW,
  });
  return { service, calls, sends, logs };
}
/** Test convenience: the first id holds the primary seat, the rest the backup seat. */
const covered = (...ids: string[]) =>
  coveredRanked(
    ids,
    ids.map((_, i) => (i === 0 ? "primary" : "backup")),
  );
const coveredRanked =
  (ids: string[], ranks: EscalationRank[]): (() => EscalationRouteAnswer) =>
  () => ({
    kind: "resolved",
    userIds: ids as [string, ...string[]],
    ranks,
    nextTier: 2,
    timeZone: "America/Los_Angeles",
    shiftEndsAt: "2026-06-02T02:00:00Z",
    tier: 1,
    asOf: "x",
    source: "m19",
  });
const send = (s: ReturnType<typeof build>["service"], to: string) =>
  s.send(actor, { ...target, recipientUserId: to, bodyDoc: {}, clientMessageId: "cm-1" }, validate);

describe("RoleSendService.resolve", () => {
  it("is the uniform 404 when the flag is off and never asks the router", async () => {
    const { service, calls } = build({ enabled: false, tier1: covered(U1) });
    await expect(service.resolve(actor, target)).rejects.toMatchObject({ statusCode: 404 });
    expect(calls).toEqual([]);
  });

  it("is the 404 for a channel that is not a patient conversation or belongs to another patient", async () => {
    for (const channelPatient of [null, OTHER_PATIENT]) {
      const { service, calls } = build({ channelPatient, tier1: covered(U1) });
      await expect(service.resolve(actor, target)).rejects.toMatchObject({ statusCode: 404 });
      expect(calls).toEqual([]);
    }
  });

  it("asks tier 1 only, for the role, and names who covers with the roster zone", async () => {
    const { service, calls } = build({ tier1: covered(U2, U1) });
    const out = await service.resolve(actor, target);
    expect(calls).toEqual([{ tier: 1, role: "rn" }]);
    expect(out).toMatchObject({
      status: "covered",
      time_zone: "America/Los_Angeles",
      shift_ends_at: "2026-06-02T02:00:00.000Z",
      people: [
        { user_id: U2, display_name: null, rank: "primary" },
        { user_id: U1, display_name: "Dana K.", rank: "backup" },
      ],
    });
  });

  it("uses the explicit ranks and lists primaries first, whatever the router's list order", async () => {
    const { service } = build({ tier1: coveredRanked([U2, U1], ["backup", "primary"]) });
    const out = await service.resolve(actor, target);
    expect(out.people.map((p) => [p.user_id, p.rank])).toEqual([
      [U1, "primary"],
      [U2, "backup"],
    ]);
  });

  it("labels nobody primary when the router supplies no ranks (position is never a rank)", async () => {
    const { service } = build({
      tier1: () => {
        const { ranks: _ranks, ...bare } = covered(U2, U1)() as Extract<
          EscalationRouteAnswer,
          { kind: "resolved" }
        >;
        return bare;
      },
    });
    const out = await service.resolve(actor, target);
    expect(out.people.map((p) => p.rank)).toEqual(["backup", "backup"]);
  });

  it("drops a rank list that does not pair with the recipients (the guard): the people stay, nobody is primary", async () => {
    const { service } = build({ tier1: coveredRanked([U2, U1], ["primary"]) });
    const out = await service.resolve(actor, target);
    expect(out.people.map((p) => [p.user_id, p.rank])).toEqual([
      [U2, "backup"],
      [U1, "backup"],
    ]);
  });

  it("de-duplicates, lower-casing ids: a user who is backup then primary is the primary", async () => {
    const { service } = build({
      tier1: coveredRanked([U2, U1, U2.toUpperCase()], ["backup", "backup", "primary"]),
    });
    const out = await service.resolve(actor, target);
    expect(out.people.map((p) => [p.user_id, p.rank])).toEqual([
      [U2, "primary"],
      [U1, "backup"],
    ]);
  });

  it("still sends to a backup (the sender confirms one person) and to the same person if only their rank changed", async () => {
    const asBackup = build({ tier1: covered(U2, U1) });
    await expect(send(asBackup.service, U1)).resolves.toMatchObject({ recipient_user_id: U1 });
    const nowPrimary = build({ tier1: covered(U1, U2) });
    await expect(send(nowPrimary.service, U1)).resolves.toMatchObject({ recipient_user_id: U1 });
  });

  it("reports a coverage gap as a state with nobody to confirm (never a backup tier)", async () => {
    const { service, calls } = build({
      tier1: () => ({
        kind: "coverage_gap",
        nextTier: 2,
        timeZone: "America/Los_Angeles",
        tier: 1,
        asOf: "x",
        source: "m19",
      }),
    });
    const out = await service.resolve(actor, target);
    expect(out).toMatchObject({ status: "coverage_gap", people: [] });
    expect(calls).toHaveLength(1);
  });

  it("reports roster_not_connected over the REAL deny-stub (unknown, not a guess)", async () => {
    const { service } = build({ router: escalationRouterDenyStub });
    expect(await service.resolve(actor, target)).toMatchObject({
      status: "roster_not_connected",
      people: [],
    });
  });

  it("propagates a router failure instead of turning it into a gap", async () => {
    const { service } = build({
      router: {
        resolveTier: async () => {
          throw new Error("store down");
        },
      },
    });
    await expect(service.resolve(actor, target)).rejects.toThrow("store down");
  });

  it("refuses a test-source answer (the guard), as in production", async () => {
    const { service } = build({ tier1: () => ({ ...covered(U1)(), source: "in_memory_fake" }) });
    await expect(service.resolve(actor, target)).rejects.toThrow(/test source/);
  });
});

describe("RoleSendService.send", () => {
  it("sends the ordinary urgent message to the confirmed person with the role attached", async () => {
    const { service, sends } = build({ tier1: covered(U1) });
    const out = await send(service, U1);
    expect(out).toMatchObject({ recipient_user_id: U1, role: "rn", created: true });
    expect(sends).toEqual([expect.objectContaining({ recipientUserId: U1, roleAddressed: "rn" })]);
  });

  it("sends to a covering person other than the first when the sender confirmed that one", async () => {
    const { service, sends } = build({ tier1: covered(U1, U2) });
    await send(service, U2);
    expect(sends[0]).toMatchObject({ recipientUserId: U2 });
  });

  it("refuses with 409 and sends NOTHING when the confirmed person no longer covers (changed resolution)", async () => {
    const { service, sends } = build({ tier1: covered(U2) });
    await expect(send(service, U1)).rejects.toMatchObject({
      statusCode: 409,
      code: "ROLE_SEND_RESOLUTION_CHANGED",
    });
    expect(sends).toEqual([]);
  });

  it("refuses a gap, an unconnected roster and a missing ladder with the telephone procedure and sends NOTHING", async () => {
    const gap = build({
      tier1: () => ({
        kind: "coverage_gap",
        nextTier: 2,
        timeZone: "UTC",
        tier: 1,
        asOf: "x",
        source: "m19",
      }),
    });
    const stub = build({ router: escalationRouterDenyStub });
    const unconfigured = build({
      tier1: () => ({
        kind: "unavailable",
        reason: "no_route_configured",
        tier: 1,
        asOf: "x",
        source: "m19",
      }),
    });
    for (const { service, sends } of [gap, stub, unconfigured]) {
      await expect(send(service, U1)).rejects.toMatchObject({
        statusCode: 422,
        code: "ROLE_SEND_NO_COVERAGE",
        message: expect.stringContaining("telephone procedure"),
      });
      expect(sends).toEqual([]);
    }
  });

  it("is the uniform 404 when the flag is off (no router call, nothing sent)", async () => {
    const { service, calls, sends } = build({ enabled: false, tier1: covered(U1) });
    await expect(send(service, U1)).rejects.toMatchObject({ statusCode: 404 });
    expect([calls, sends]).toEqual([[], []]);
  });

  it("replays a committed send to the same person without re-resolving (a shift change cannot break a retry)", async () => {
    const { service, calls, sends } = build({ replay: U1, tier1: covered(U2) });
    await send(service, U1);
    expect(calls).toEqual([]);
    expect(sends).toHaveLength(1);
  });

  it("does not let a replay of another person skip the resolution check", async () => {
    const { service, sends } = build({ replay: U2, tier1: covered(U2) });
    await expect(send(service, U1)).rejects.toMatchObject({ statusCode: 409 });
    expect(sends).toEqual([]);
  });

  it("refuses with a typed 409 a client id already used for a person-send or another role, and never echoes the new role", async () => {
    for (const replayRole of [null, "physician"]) {
      const { service, sends, calls } = build({ replay: U1, replayRole, tier1: covered(U1) });
      await expect(send(service, U1)).rejects.toMatchObject({
        statusCode: 409,
        code: "ROLE_SEND_CLIENT_ID_REUSED",
      });
      expect([sends, calls]).toEqual([[], []]);
    }
  });

  it("propagates a replay lookup failure instead of sending afresh", async () => {
    const { service, sends } = build({ tier1: covered(U1) });
    const failing = createRoleSendService({
      isEnabled: async () => true,
      router: { resolveTier: async () => Promise.reject(new Error("unused")) },
      displayName: async () => null,
      channelPatient: async () => PATIENT,
      findReplay: async () => Promise.reject(new Error("lookup down")),
      urgent: { send: async () => Promise.reject(new Error("must not send")) },
      log: () => undefined,
    });
    await expect(send(failing, U1)).rejects.toThrow("lookup down");
    expect(sends).toEqual([]);
    expect(service).toBeTruthy();
  });

  it("logs the role and a status word only: no patient id, no name, no recipient", async () => {
    const { service, logs } = build({ tier1: covered(U2) });
    await send(service, U1).catch(() => undefined);
    const text = JSON.stringify(logs);
    expect(text).toContain("resolution_changed");
    for (const secret of [PATIENT, U1, U2, "Dana"]) expect(text).not.toContain(secret);
  });
});
