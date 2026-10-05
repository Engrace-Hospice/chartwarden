// GAP-043 — M14 decision integrity: an emitted/superseded decision is immutable (§2.8), and supersede writes
// its successor into a LATER, LIVE meeting with the quorum computed from that meeting's STORED attendance
// (never a hard-coded wasQuorate:true, never copied from the prior row).
import { describe, expect, it } from "vitest";
import { createInMemoryIdgBackend } from "../src/modules/14-idg/index";

const ORG = "org_a";
const LOC = "44444444-4444-4444-8444-444444444444";
const MTG_1 = "11111111-1111-4111-8111-111111111111";
const MTG_2 = "11111111-1111-4111-8111-222222222222";
const MTG_OLD = "11111111-1111-4111-8111-333333333333";
const MTG_SAME_START = "11111111-1111-4111-8111-444444444444";
const LOC_OTHER = "55555555-5555-4555-8555-555555555555";
const PATIENT = "22222222-2222-4222-8222-222222222222";
const COORD = "coord_1";
const NOW = "2026-06-22T15:00:00.000Z";

const QUORUM: Readonly<Record<string, string>> = {
  mem_md: "hospice_physician",
  mem_rn: "rn_case_manager",
  mem_msw: "msw",
  mem_chap: "chaplain",
};
const PAYLOAD = { kind: "care_plan_update", mutations: [] } as const;
const EDITED = { kind: "order_request", requestedOrders: [] } as const;

const seedMeeting = (id: string, status: string, scheduledStart: string) => ({
  id,
  organizationId: ORG,
  locationId: LOC,
  status: status as never,
  scheduledStart,
  scheduledEnd: scheduledStart,
  includedPatientIds: [PATIENT],
});

type Svc = ReturnType<typeof createInMemoryIdgBackend>;

async function seat(svc: Svc, meetingId: string, only?: string[]) {
  for (const [membershipId, discipline] of Object.entries(QUORUM)) {
    if (only && !only.includes(membershipId)) continue;
    await svc.recordAttendance(ORG, COORD, meetingId, {
      membershipId,
      discipline,
      status: "present",
    });
  }
}

/** Meeting 1 holds one open decision; meeting 2 (later) and an older meeting are live. */
async function world() {
  const svc = createInMemoryIdgBackend({
    now: () => NOW,
    disciplinesByMembership: QUORUM,
    meetings: [
      seedMeeting(MTG_1, "live", "2026-06-22T14:00:00.000Z"),
      seedMeeting(MTG_2, "live", "2026-06-29T14:00:00.000Z"),
      seedMeeting(MTG_OLD, "live", "2026-06-15T14:00:00.000Z"),
      seedMeeting(MTG_SAME_START, "live", "2026-06-22T14:00:00.000Z"),
    ],
  });
  await seat(svc, MTG_1);
  const open = await svc.recordDecision(ORG, COORD, MTG_1, {
    patientId: PATIENT,
    decisionKind: "care_plan_update",
    payload: PAYLOAD,
  });
  return { svc, openId: open.id };
}
async function emitted() {
  const w = await world();
  await w.svc.adjournMeeting(ORG, COORD, MTG_1, true);
  return w;
}

describe("GAP-043 updateDecision — only an open decision is editable", () => {
  it("edits an open decision", async () => {
    const { svc, openId } = await world();
    const v = await svc.updateDecision(ORG, COORD, openId, EDITED, 0);
    expect(v.decisionKind).toBe("order_request");
  });

  it("bumps the version on each edit and returns it", async () => {
    const { svc, openId } = await world();
    const first = await svc.updateDecision(ORG, COORD, openId, EDITED, 0);
    expect(first.version).toBe(1);
    const second = await svc.updateDecision(ORG, COORD, openId, EDITED, 1);
    expect(second.version).toBe(2);
  });

  it("refuses a stale If-Match version with 412 STALE_VERSION and leaves the row untouched", async () => {
    const { svc, openId } = await world();
    await svc.updateDecision(ORG, COORD, openId, EDITED, 0); // a concurrent editor wins first
    await expect(
      svc.updateDecision(ORG, COORD, openId, { kind: "team_note", noteText: "lost update" }, 0),
    ).rejects.toMatchObject({ statusCode: 412, code: "STALE_VERSION" });
    const row = (await svc.listDecisions(ORG, MTG_1)).find((d) => d.id === openId);
    expect(row!.decisionKind).toBe("order_request");
  });

  it("refuses an emitted decision with 409 and leaves the row untouched", async () => {
    const { svc, openId } = await emitted();
    await expect(svc.updateDecision(ORG, COORD, openId, EDITED, 0)).rejects.toMatchObject({
      statusCode: 409,
      code: "DECISION_NOT_OPEN",
    });
    const row = (await svc.listDecisions(ORG, MTG_1)).find((d) => d.id === openId);
    expect(row!.decisionKind).toBe("care_plan_update");
  });

  it("refuses a superseded decision with 409 DECISION_SUPERSEDED", async () => {
    const { svc, openId } = await emitted();
    await seat(svc, MTG_2);
    await svc.supersedeDecision(ORG, COORD, openId, { meetingId: MTG_2 });
    await expect(svc.updateDecision(ORG, COORD, openId, EDITED, 0)).rejects.toMatchObject({
      statusCode: 409,
      code: "DECISION_SUPERSEDED",
    });
  });
});

describe("GAP-043 supersedeDecision — successor in a later live quorate meeting", () => {
  it("writes the successor into the target meeting with the real, server-computed quorum", async () => {
    const { svc, openId } = await emitted();
    await seat(svc, MTG_2);
    const prior = await svc.supersedeDecision(ORG, COORD, openId, { meetingId: MTG_2 });
    expect(prior.status).toBe("superseded");
    const successor = (await svc.listDecisions(ORG, MTG_2)).find(
      (d) => d.id === prior.supersededByDecisionId,
    );
    expect(successor).toMatchObject({ status: "open", wasQuorate: true, meetingId: MTG_2 });
  });

  it("refuses (422 QUORUM_NOT_MET) when the target meeting is not quorate, and writes nothing", async () => {
    const { svc, openId } = await emitted();
    await seat(svc, MTG_2, ["mem_msw"]); // 1 of 4 required disciplines
    await expect(
      svc.supersedeDecision(ORG, COORD, openId, { meetingId: MTG_2 }),
    ).rejects.toMatchObject({ statusCode: 422, code: "QUORUM_NOT_MET" });
    expect(await svc.listDecisions(ORG, MTG_2)).toHaveLength(0);
    const row = (await svc.listDecisions(ORG, MTG_1)).find((d) => d.id === openId);
    expect(row!.status).toBe("emitted");
  });

  it("refuses a target meeting that is not later than the prior decision's meeting", async () => {
    const { svc, openId } = await emitted();
    await seat(svc, MTG_OLD);
    await expect(
      svc.supersedeDecision(ORG, COORD, openId, { meetingId: MTG_OLD }),
    ).rejects.toMatchObject({ code: "SUPERSEDE_MEETING_NOT_SUBSEQUENT" });
  });

  it("refuses the prior decision's own meeting as the target (it is adjourned, so not live)", async () => {
    const { svc, openId } = await emitted();
    await expect(
      svc.supersedeDecision(ORG, COORD, openId, { meetingId: MTG_1 }),
    ).rejects.toMatchObject({ statusCode: 422, code: "MEETING_NOT_LIVE" });
  });

  it("refuses a live, quorate target that starts at the same instant as the prior meeting", async () => {
    const { svc, openId } = await emitted();
    await seat(svc, MTG_SAME_START);
    await expect(
      svc.supersedeDecision(ORG, COORD, openId, { meetingId: MTG_SAME_START }),
    ).rejects.toMatchObject({ statusCode: 422, code: "SUPERSEDE_MEETING_NOT_SUBSEQUENT" });
    expect(await svc.listDecisions(ORG, MTG_SAME_START)).toHaveLength(0);
  });

  it("refuses with 404 when the caller does not cover the PRIOR decision's meeting location, even naming a covered target", async () => {
    const { svc, openId } = await emitted();
    await seat(svc, MTG_2);
    await expect(
      svc.supersedeDecision(ORG, COORD, openId, {
        meetingId: MTG_2,
        callerLocationIds: [LOC_OTHER],
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(await svc.listDecisions(ORG, MTG_2)).toHaveLength(0);
    const row = (await svc.listDecisions(ORG, MTG_1)).find((d) => d.id === openId);
    expect(row!.status).toBe("emitted");
  });

  it("allows the supersede when the caller covers the prior meeting's location", async () => {
    const { svc, openId } = await emitted();
    await seat(svc, MTG_2);
    const prior = await svc.supersedeDecision(ORG, COORD, openId, {
      meetingId: MTG_2,
      callerLocationIds: [LOC],
    });
    expect(prior.status).toBe("superseded");
  });

  it("refuses an unknown target meeting with 404", async () => {
    const { svc, openId } = await emitted();
    await expect(
      svc.supersedeDecision(ORG, COORD, openId, {
        meetingId: "11111111-1111-4111-8111-999999999999",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses an open decision (409) and an already-superseded one (409)", async () => {
    const { svc, openId } = await world();
    await seat(svc, MTG_2);
    await expect(
      svc.supersedeDecision(ORG, COORD, openId, { meetingId: MTG_2 }),
    ).rejects.toMatchObject({ statusCode: 409, code: "DECISION_NOT_OPEN" });
    await svc.adjournMeeting(ORG, COORD, MTG_1, true);
    await svc.supersedeDecision(ORG, COORD, openId, { meetingId: MTG_2 });
    await expect(
      svc.supersedeDecision(ORG, COORD, openId, { meetingId: MTG_2 }),
    ).rejects.toMatchObject({ statusCode: 409, code: "DECISION_SUPERSEDED" });
  });
});
