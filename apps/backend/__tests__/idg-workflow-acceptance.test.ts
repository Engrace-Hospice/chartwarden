import {
  createInMemorySessionContextStore,
  createSessionContextResolver,
  resetAuthorizationContract,
  resetEffectivePermissionResolver,
  setEffectivePermissionResolver,
} from "@chartwarden/auth";
import {
  CARRY_FORWARD_COMPLIANCE_THRESHOLD,
  type PacketBuildInput,
  applySudRedaction,
  assertPacketWritable,
  buildPacketSnapshot,
  evaluateQuorum,
  planCarryForward,
  transitionActionItem,
} from "@chartwarden/idg";
// apps/backend/__tests__/idg-workflow-acceptance.test.ts — M14-T08 the §9 workflow-acceptance suite (the
// FINAL M14 task). One scenario per the §7 plan-named IDG workflows — W-SCH-01 (schedule materialisation),
// W-PKT-01 (pre-meeting packet build), W-DEC-01 (quorate decision recording), W-DEC-02 (non-quorate decision
// attempt — the `quorate_decision` ABAC gate), W-ADJ-01 (adjournment burst → `idg.decision_recorded` per
// actionable kind), W-ADJ-02 (step-up gate on adjournment), W-PKT-02 (packet rebuild post-adjournment
// refused), W-ACT-01 (carry-forward escalation), W-ACT-02 (auto-close of a care-plan-linked action item),
// W-MIN-01 (minutes amendment after final), W-SUD-01 (SUD redaction at packet read), W-RVW-01 (per-patient
// review-floor guard on reschedule) — exercised end-to-end over the in-memory `createInMemoryIdgBackend` (the
// same backend the §4.1 routes compose over, M14-T05) plus the pure `@chartwarden/idg` deciders the carry-forward
// / auto-close / packet-freeze / SUD-redaction paths drive, and the §4.7 ABAC predicates the decision /
// cancel-reschedule / meeting-scope routes bind. Deterministic: no infra, injected clock.
//
// The route-auth handshake (§4.6/§4.7) wire status codes live in idg-routes.test.ts; each pure machine has its
// own unit suite under packages/idg/__tests__. This asserts the WORKFLOW outcomes (state transitions, the §4.4
// outbox emissions, the quorum stamp, the adjournment decision burst, the carry-forward threshold, the
// auto-close handshake, the minutes-amendment gate, the SUD elision) and the §9.3/§4.12 security guarantees the
// service + ABAC layer own (per-decision quorum, inclusion-criteria URL-tamper defense, cross-location EoP,
// step-up repudiation, non-leaking cross-tenant 404). The RLS layer-independence (§9.3/§9.4) lives in
// rls-isolation.live (the M14 block).
import type { IdgDecisionRecordedPayload } from "@chartwarden/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import {
  REVIEW_FLOOR_OVERRIDE_ATTRIBUTE,
  buildIdgAbacPredicates,
  createInMemoryIdgBackend,
  planActionItemAutoClose,
} from "../src/modules/14-idg/index";

const ORG = "org_a";
const ORG_B = "org_b";
const LOC = "44444444-4444-4444-8444-444444444444";
const LOC_OTHER = "55555555-5555-4555-8555-555555555555";
const MTG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "22222222-2222-4222-8222-222222222222";
const PATIENT_2 = "33333333-3333-4333-8333-333333333333";
const COORD = "coord_1";
const NOW = "2026-06-22T15:00:00.000Z";

// The four membership ids that satisfy the platform IDG_REQUIRED_QUORUM (physician / RN / MSW / chaplain).
const MEM_MD = "mem_md";
const MEM_RN = "mem_rn";
const MEM_MSW = "mem_msw";
const MEM_CHAP = "mem_chap";

// The §2.6 D4 payload is REQUIRED on every decision — `RecordDecisionArgs.payload` is not optional, and
// `idg.decision_recorded` is what carries it to M7/M11/M12. Every `recordDecision` call in this suite used
// to omit it, so each decision was recorded with `payload: undefined` and the adjournment burst this file
// asserts carried nothing to its consumers. These are the minimal valid envelopes for the four kinds it
// records; the suite asserts the burst, the quorum stamp and the per-patient split, not payload content.
const PAYLOAD = {
  care_plan_update: { kind: "care_plan_update", mutations: [] },
  order_request: { kind: "order_request", requestedOrders: [] },
  medication_recommendation: { kind: "medication_recommendation", recommendations: [] },
  team_note: { kind: "team_note", noteText: "team note" },
} as const satisfies Record<string, IdgDecisionRecordedPayload>;
const QUORUM_DISCIPLINES: Readonly<Record<string, string>> = {
  [MEM_MD]: "hospice_physician",
  [MEM_RN]: "rn_case_manager",
  [MEM_MSW]: "msw",
  [MEM_CHAP]: "chaplain",
};

function eventNames(events: ReadonlyArray<{ eventName: string }>): string[] {
  return events.map((e) => e.eventName);
}

/** A meeting seeded `live` with all four quorum disciplines checked in (the decision-write base case). */
async function liveQuorateMeeting() {
  const svc = createInMemoryIdgBackend({
    now: () => NOW,
    disciplinesByMembership: QUORUM_DISCIPLINES,
    meetings: [
      {
        id: MTG,
        organizationId: ORG,
        locationId: LOC,
        status: "live",
        scheduledStart: "2026-06-22T14:00:00.000Z",
        scheduledEnd: "2026-06-22T16:00:00.000Z",
        includedPatientIds: [PATIENT, PATIENT_2],
      },
    ],
  });
  for (const [membershipId, discipline] of Object.entries(QUORUM_DISCIPLINES)) {
    await svc.recordAttendance(ORG, COORD, MTG, { membershipId, discipline, status: "present" });
  }
  svc.drainEvents();
  return svc;
}

// ── ABAC context helper (the server-assembled context a predicate evaluates against, §4.7) ───────────────
function ctx(overrides: Partial<{ locationIds: readonly string[]; organizationId: string }> = {}) {
  return {
    organizationId: overrides.organizationId ?? ORG,
    userId: COORD,
    roles: ["idg_coordinator"],
    providerEntityIds: [] as readonly string[],
    locationIds: overrides.locationIds ?? [LOC],
    attributes: {},
  };
}

describe("M14-T08 §7 workflow acceptance", () => {
  it("W-SCH-01 — a recurring policy materialises a schedule the location query reads back in order", async () => {
    const svc = createInMemoryIdgBackend({
      now: () => NOW,
      meetings: [
        {
          id: "mtg-b",
          organizationId: ORG,
          locationId: LOC,
          scheduledStart: "2026-07-08T14:00:00.000Z",
          scheduledEnd: "2026-07-08T16:00:00.000Z",
        },
        {
          id: "mtg-a",
          organizationId: ORG,
          locationId: LOC,
          scheduledStart: "2026-06-24T14:00:00.000Z",
          scheduledEnd: "2026-06-24T16:00:00.000Z",
        },
        {
          id: "mtg-other-loc",
          organizationId: ORG,
          locationId: LOC_OTHER,
          scheduledStart: "2026-06-25T14:00:00.000Z",
          scheduledEnd: "2026-06-25T16:00:00.000Z",
        },
      ],
    });
    const policy = await svc.createRecurringPolicy(ORG, COORD, {
      locationId: LOC,
      cadenceDays: 14,
    });
    expect(policy.cadenceDays).toBe(14);
    expect(eventNames(svc.drainEvents())).toContain("m14.schedule.materialised");

    // The location-scoped schedule query returns this location's meetings, ascending, the other location elided.
    const schedule = await svc.listSchedule(ORG, {
      location: LOC,
      from: "2026-06-23T00:00:00.000Z",
      to: "2026-07-31T00:00:00.000Z",
    });
    expect(schedule.map((m) => m.id)).toEqual(["mtg-a", "mtg-b"]);
  });

  it("getPatientIdgHistory returns the patient's reviewed meetings with their own decisions (no cross-patient leak)", async () => {
    const svc = await liveQuorateMeeting();
    await svc.recordDecision(ORG, COORD, MTG, {
      patientId: PATIENT,
      decisionKind: "care_plan_update",
      payload: PAYLOAD.care_plan_update,
    });
    await svc.recordDecision(ORG, COORD, MTG, {
      patientId: PATIENT_2,
      decisionKind: "order_request",
      payload: PAYLOAD.order_request,
    });

    const history = await svc.getPatientIdgHistory(ORG, PATIENT);
    expect(history.meetings.length).toBe(1);
    const mtg = history.meetings[0];
    expect(mtg.meetingId).toBe(MTG);
    // Only PATIENT's decision surfaces — PATIENT_2's does not leak into PATIENT's history.
    expect(mtg.decisions.map((d) => d.decisionKind)).toEqual(["care_plan_update"]);

    // A patient never on an agenda → a truthful empty history.
    const none = await svc.getPatientIdgHistory(ORG, "44444444-0000-0000-0000-000000000000");
    expect(none.meetings).toEqual([]);
  });

  it("W-PKT-01 / W-DEC-01 / W-ADJ-01 — build → start → record decisions → adjourn bursts one idg.decision_recorded per actionable kind", async () => {
    const svc = createInMemoryIdgBackend({
      now: () => NOW,
      disciplinesByMembership: QUORUM_DISCIPLINES,
      meetings: [
        {
          id: MTG,
          organizationId: ORG,
          locationId: LOC,
          status: "packets_ready",
          scheduledStart: "2026-06-22T14:00:00.000Z",
          scheduledEnd: "2026-06-22T16:00:00.000Z",
          includedPatientIds: [PATIENT, PATIENT_2],
        },
      ],
    });
    // Start the meeting and seat the full quorum.
    const started = await svc.startMeeting(ORG, COORD, MTG);
    expect(started.status).toBe("live");
    for (const [membershipId, discipline] of Object.entries(QUORUM_DISCIPLINES)) {
      await svc.recordAttendance(ORG, COORD, MTG, { membershipId, discipline, status: "present" });
    }
    expect(svc.currentQuorum(MTG).met).toBe(true);

    // Record three actionable decisions (1 each of the canonical D4 kinds) + one team_note (minutes-only).
    const carePlan = await svc.recordDecision(ORG, COORD, MTG, {
      patientId: PATIENT,
      decisionKind: "care_plan_update",
      payload: PAYLOAD.care_plan_update,
    });
    expect(carePlan.status).toBe("open");
    expect(carePlan.wasQuorate).toBe(true);
    await svc.recordDecision(ORG, COORD, MTG, {
      patientId: PATIENT,
      decisionKind: "order_request",
      payload: PAYLOAD.order_request,
    });
    await svc.recordDecision(ORG, COORD, MTG, {
      patientId: PATIENT_2,
      decisionKind: "medication_recommendation",
      payload: PAYLOAD.medication_recommendation,
    });
    await svc.recordDecision(ORG, COORD, MTG, {
      patientId: null,
      decisionKind: "team_note",
      payload: PAYLOAD.team_note,
    });
    svc.drainEvents();

    // Adjourn with a fresh step-up: the commit point bursts idg.decision_recorded for the THREE actionable
    // decisions (team_note excluded), finalizes the minutes, and emits the M22 minutes-render handshake.
    const adjourned = await svc.adjournMeeting(ORG, COORD, MTG, true);
    expect(adjourned.status).toBe("adjourned");
    expect(adjourned.adjournedAt).toBe(NOW);
    const names = eventNames(svc.drainEvents());
    expect(names.filter((n) => n === "idg.decision_recorded")).toHaveLength(3); // team_note did NOT emit
    expect(names).toContain("m14.meeting.adjourned");
    expect(names).toContain("m14.minutes.signed");

    // The minutes are now final (the survey artifact).
    expect((await svc.getMinutes(ORG, MTG)).status).toBe("final");
  });

  it("W-ADJ-02 — adjournment without a fresh step-up is refused with STEP_UP_REQUIRED (D13)", async () => {
    const svc = await liveQuorateMeeting();
    await expect(svc.adjournMeeting(ORG, COORD, MTG, false)).rejects.toThrowError(
      expect.objectContaining({ code: "STEP_UP_REQUIRED" }),
    );
    // No decisions emitted, no minutes finalized — the transaction never committed.
    expect(eventNames(svc.drainEvents())).toEqual([]);
    expect((await svc.getMeeting(ORG, MTG)).status).toBe("live");
  });

  it("W-PKT-02 — a frozen (adjourned) packet refuses every rebuild with PACKET_FROZEN", () => {
    expect(() => assertPacketWritable({ frozenAt: null })).not.toThrow(); // pre-meeting rebuild ok
    expect(() => assertPacketWritable({ frozenAt: NOW })).toThrowError(
      expect.objectContaining({ code: "PACKET_FROZEN", statusCode: 422 }),
    );
  });

  it("W-DEC-02 — the quorate_decision ABAC predicate denies a decision when a discipline is absent, allows when quorate", async () => {
    const svc = createInMemoryIdgBackend({
      now: () => NOW,
      disciplinesByMembership: QUORUM_DISCIPLINES,
      meetings: [
        {
          id: MTG,
          organizationId: ORG,
          locationId: LOC,
          status: "live",
          scheduledStart: "2026-06-22T14:00:00.000Z",
          scheduledEnd: "2026-06-22T16:00:00.000Z",
          includedPatientIds: [PATIENT],
        },
      ],
    });
    const predicates = buildIdgAbacPredicates({ resolver: svc });

    // Only 3 of the 4 required disciplines present → the meeting may be HELD but the decision write is denied.
    await svc.recordAttendance(ORG, COORD, MTG, {
      membershipId: MEM_MD,
      discipline: "hospice_physician",
      status: "present",
    });
    await svc.recordAttendance(ORG, COORD, MTG, {
      membershipId: MEM_RN,
      discipline: "rn_case_manager",
      status: "present",
    });
    await svc.recordAttendance(ORG, COORD, MTG, {
      membershipId: MEM_MSW,
      discipline: "msw",
      status: "present",
    });
    expect(await predicates.quorate_decision!(ctx(), { id: MTG })).toBe(false);

    // The chaplain joins → quorum satisfied → the predicate now allows the write.
    await svc.recordAttendance(ORG, COORD, MTG, {
      membershipId: MEM_CHAP,
      discipline: "chaplain",
      status: "present",
    });
    expect(await predicates.quorate_decision!(ctx(), { id: MTG })).toBe(true);

    // The decision is still RECORDED in the non-quorate gap (the meeting proceeds) with was_quorate stamped.
    const svc2 = createInMemoryIdgBackend({
      now: () => NOW,
      disciplinesByMembership: QUORUM_DISCIPLINES,
      meetings: [
        {
          id: MTG,
          organizationId: ORG,
          locationId: LOC,
          status: "live",
          scheduledStart: "2026-06-22T14:00:00.000Z",
          scheduledEnd: "2026-06-22T16:00:00.000Z",
          includedPatientIds: [PATIENT],
        },
      ],
    });
    await svc2.recordAttendance(ORG, COORD, MTG, {
      membershipId: MEM_RN,
      discipline: "rn_case_manager",
      status: "present",
    });
    const dec = await svc2.recordDecision(ORG, COORD, MTG, {
      patientId: PATIENT,
      decisionKind: "team_note",
      payload: PAYLOAD.team_note,
    });
    expect(dec.wasQuorate).toBe(false);
  });

  it("W-ACT-01 — carry-forward increments the count and fires the critical Compliance alert at the third consecutive carry", () => {
    const first = planCarryForward({ priorCarryForwardCount: 0, isOpenAndOverdue: true });
    expect(first.newCarryForwardCount).toBe(1);
    expect(first.isComplianceAlert).toBe(false);

    const third = planCarryForward({
      priorCarryForwardCount: CARRY_FORWARD_COMPLIANCE_THRESHOLD - 1,
      isOpenAndOverdue: true,
    });
    expect(third.newCarryForwardCount).toBe(CARRY_FORWARD_COMPLIANCE_THRESHOLD);
    expect(third.isComplianceAlert).toBe(true);
    expect(
      third.effects.some(
        (e) => e.kind === "alert" && e.alert === "m14.action_item.carry_forward.compliance",
      ),
    ).toBe(true);

    // A non-overdue (or closed) item does not carry forward.
    expect(() =>
      planCarryForward({ priorCarryForwardCount: 0, isOpenAndOverdue: false }),
    ).toThrowError(expect.objectContaining({ code: "ILLEGAL_ACTION_ITEM_TRANSITION" }));
  });

  it("W-ACT-02 — a care-plan version-signed event auto-closes the linked action item", async () => {
    // The §4.5 D8 consumer maps the source event → the linked-artifact kind + the autoClose engine event.
    const plan = planActionItemAutoClose("m7.care_plan.version_signed", "cpv-9");
    expect(plan).not.toBeNull();
    expect(plan!.linkedArtifactKind).toBe("care_plan_version");

    // The open action item flips to auto_closed and emits the auto-close confirmation.
    const t = transitionActionItem("open", plan!.event);
    expect(t.to).toBe("auto_closed");
    expect(
      t.effects.some((e) => e.kind === "outbox" && e.event === "m14.action_item.auto_closed"),
    ).toBe(true);

    // An event M14 does not auto-close on is a no-op for the engine.
    expect(planActionItemAutoClose("m9.assessment.recorded", "x")).toBeNull();

    // The service path: create → start → complete an action item, asserting the status-change outbox.
    const svc = await liveQuorateMeeting();
    const item = await svc.createActionItem(ORG, COORD, MTG, {
      patientId: PATIENT,
      assignedToMembershipId: MEM_MSW,
      dueDate: "2026-06-29T00:00:00.000Z",
      linkedArtifactKind: "care_plan_version",
    });
    expect(item.status).toBe("open");
    await svc.updateActionItem(ORG, COORD, item.id, "in_progress", true);
    const done = await svc.updateActionItem(ORG, COORD, item.id, "completed", true);
    expect(done.status).toBe("completed");
    expect(eventNames(svc.drainEvents())).toContain("m14.action_item.status_changed");
  });

  it("W-MIN-01 — minutes amendment is accepted on final minutes and refused while still in progress", async () => {
    const svc = await liveQuorateMeeting();
    // Before adjournment the minutes are `in_progress` → the amendment request is refused.
    const inProgress = await svc.getMinutes(ORG, MTG);
    expect(inProgress.status).toBe("in_progress");
    await expect(
      svc.submitAmendment(ORG, COORD, inProgress.id, "typo in the chaplain note"),
    ).rejects.toThrowError(expect.objectContaining({ code: "MINUTES_NOT_IN_PROGRESS" }));

    // Adjourn → minutes final → the §164.526-pattern amendment workflow now accepts the request.
    await svc.adjournMeeting(ORG, COORD, MTG, true);
    const final = await svc.getMinutes(ORG, MTG);
    expect(final.status).toBe("final");
    svc.drainEvents();
    const amendment = await svc.submitAmendment(
      ORG,
      COORD,
      final.id,
      "correct MSW name misattribution",
    );
    expect(amendment.minutesId).toBe(final.id);
    expect(eventNames(svc.drainEvents())).toContain("m14.minutes.amended");
  });

  it("W-SUD-01 — SUD-flagged packet content is elided at read for a caller without a Part 2 release, full with one", () => {
    const built = buildPacketSnapshot(packetInput());
    expect(built.snapshot.sinceLastIdg.encounters.map((e) => e.encounterId)).toEqual(["enc-sud"]);

    const withoutRelease = applySudRedaction(built, {
      hasPart2Release: false,
      sudFlaggedSourceIds: new Set(["enc-sud"]),
    });
    expect(withoutRelease.snapshot.sinceLastIdg.encounters).toEqual([]); // elided at the SQL-filter layer
    expect(withoutRelease.snapshot.meta.appliedSudRedaction).toBe(true); // surface renders the Part 2 banner

    const withRelease = applySudRedaction(built, {
      hasPart2Release: true,
      sudFlaggedSourceIds: new Set(["enc-sud"]),
    });
    expect(withRelease.snapshot.sinceLastIdg.encounters.map((e) => e.encounterId)).toEqual([
      "enc-sud",
    ]);
    expect(withRelease.snapshot.meta.appliedSudRedaction).toBe(false);
  });

  it("W-RVW-01 — the per_patient_review_floor_clear ABAC denies a reschedule that breaches a patient's 15-day floor, allows when clear", async () => {
    const svc = createInMemoryIdgBackend({
      now: () => NOW,
      meetings: [
        {
          id: MTG,
          organizationId: ORG,
          locationId: LOC,
          status: "scheduled",
          scheduledStart: "2026-06-22T14:00:00.000Z",
          scheduledEnd: "2026-06-22T16:00:00.000Z",
          includedPatientIds: [PATIENT],
        },
      ],
      reviewFloorBreaches: { [MTG]: [{ patientId: PATIENT, floorAt: "2026-06-25T00:00:00.000Z" }] },
    });
    const predicates = buildIdgAbacPredicates({ resolver: svc });

    // A breach surfaced for this meeting → the base guard denies the reschedule (the audited override is route-composed).
    expect(
      await predicates.per_patient_review_floor_clear!(ctx(), {
        id: MTG,
        proposedTransition: "reschedule",
        newScheduledStart: "2026-07-10T14:00:00.000Z",
      }),
    ).toBe(false);

    // A meeting with no breach → the floor is clear → the reschedule is permitted.
    const svcClear = createInMemoryIdgBackend({
      now: () => NOW,
      meetings: [
        {
          id: MTG,
          organizationId: ORG,
          locationId: LOC,
          status: "scheduled",
          scheduledStart: "2026-06-22T14:00:00.000Z",
          scheduledEnd: "2026-06-22T16:00:00.000Z",
          includedPatientIds: [PATIENT],
        },
      ],
    });
    const clearPredicates = buildIdgAbacPredicates({ resolver: svcClear });
    expect(
      await clearPredicates.per_patient_review_floor_clear!(ctx(), {
        id: MTG,
        proposedTransition: "reschedule",
        newScheduledStart: "2026-07-10T14:00:00.000Z",
      }),
    ).toBe(true);
  });
});

describe("GAP-091 — per_patient_review_floor_clear's audited idg.override_review_floor escape valve", () => {
  const SESSION = "sess-gap091";

  function breachingPredicates() {
    const svc = createInMemoryIdgBackend({
      now: () => NOW,
      meetings: [
        {
          id: MTG,
          organizationId: ORG,
          locationId: LOC,
          status: "scheduled",
          scheduledStart: "2026-06-22T14:00:00.000Z",
          scheduledEnd: "2026-06-22T16:00:00.000Z",
          includedPatientIds: [PATIENT],
        },
      ],
      reviewFloorBreaches: { [MTG]: [{ patientId: PATIENT, floorAt: "2026-06-25T00:00:00.000Z" }] },
    });
    return buildIdgAbacPredicates({ resolver: svc });
  }

  /** Session-context-derived, so the predicate's real M2-seam read (never a client header) is exercised. */
  function seedSession(
    lastStepUpAt: Date | null,
    factor: "webauthn" | "totp" | "sms" | null,
  ): void {
    const { store } = createInMemorySessionContextStore([
      {
        sessionId: SESSION,
        userId: "user-1",
        membershipId: COORD,
        organizationId: ORG,
        roles: ["idg_coordinator"],
        providerEntityIds: [],
        locationIds: [LOC],
        sessionClass: "staff",
        portalAccountId: null,
        sessionPatientId: null,
        lastStepUpAt,
        lastStepUpFactor: factor,
      },
    ]);
    registerSeam("SessionContextResolver", createSessionContextResolver(store));
  }

  function overrideCtx(sessionId: string | null = SESSION) {
    // `attributes` is the mutable server-assembled bag the predicate STAMPS the override flag into and the
    // assertion reads back; inferring it as `{ sessionId: string } | {}` made that read an implicit any.
    const attributes: Record<string, unknown> = sessionId ? { sessionId } : {};
    return { ...ctx(), attributes };
  }

  const target = { id: MTG, proposedTransition: "cancel" as const };

  beforeEach(() => {
    __resetSeamsForTest();
    resetAuthorizationContract();
  });
  afterEach(() => {
    __resetSeamsForTest();
    resetAuthorizationContract();
    resetEffectivePermissionResolver();
  });

  it("still denies a real breach when the actor holds no override permission (base case unchanged)", async () => {
    const predicates = breachingPredicates();
    expect(await predicates.per_patient_review_floor_clear!(overrideCtx(), target)).toBe(false);
  });

  it("denies when the actor holds the permission but has never stepped up", async () => {
    setEffectivePermissionResolver(() => new Set(["idg.override_review_floor"]));
    seedSession(null, null);
    const predicates = breachingPredicates();
    expect(await predicates.per_patient_review_floor_clear!(overrideCtx(), target)).toBe(false);
  });

  it("denies a stale step-up even with the permission", async () => {
    setEffectivePermissionResolver(() => new Set(["idg.override_review_floor"]));
    seedSession(new Date(Date.now() - 10 * 60_000), "totp"); // 10 min ago, past the 300s floor
    const predicates = breachingPredicates();
    expect(await predicates.per_patient_review_floor_clear!(overrideCtx(), target)).toBe(false);
  });

  it("denies a non-qualifying step-up factor (SMS) even when fresh", async () => {
    setEffectivePermissionResolver(() => new Set(["idg.override_review_floor"]));
    seedSession(new Date(Date.now() - 5_000), "sms");
    const predicates = breachingPredicates();
    expect(await predicates.per_patient_review_floor_clear!(overrideCtx(), target)).toBe(false);
  });

  it("denies when the request carries no session id, even with the permission (fail closed)", async () => {
    setEffectivePermissionResolver(() => new Set(["idg.override_review_floor"]));
    seedSession(new Date(Date.now() - 60_000), "totp");
    const predicates = breachingPredicates();
    expect(await predicates.per_patient_review_floor_clear!(overrideCtx(null), target)).toBe(false);
  });

  it("allows a real breach with the permission + a fresh qualifying step-up, and flags the override for the route handler", async () => {
    setEffectivePermissionResolver(() => new Set(["idg.override_review_floor"]));
    seedSession(new Date(Date.now() - 60_000), "webauthn"); // 60s ago, within the 300s floor
    const predicates = breachingPredicates();
    const context = overrideCtx();
    expect(await predicates.per_patient_review_floor_clear!(context, target)).toBe(true);
    expect(context.attributes[REVIEW_FLOOR_OVERRIDE_ATTRIBUTE]).toBe(true);
  });
});

describe("M14-T08 §9.3 / §4.12 security & authorization (quorum, inclusion-tamper, EoP, cross-tenant non-leak)", () => {
  it("a decision recorded for a patient NOT on the meeting's caseload is refused (INCLUSION_CRITERIA_FAILED — URL-tamper defense)", async () => {
    const svc = await liveQuorateMeeting();
    await expect(
      svc.recordDecision(ORG, COORD, MTG, {
        patientId: "99999999-9999-4999-8999-999999999999",
        decisionKind: "care_plan_update",
        payload: PAYLOAD.care_plan_update,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "INCLUSION_CRITERIA_FAILED" }));
  });

  it("a decision recorded while the meeting is not live is refused (MEETING_NOT_LIVE)", async () => {
    const svc = createInMemoryIdgBackend({
      now: () => NOW,
      disciplinesByMembership: QUORUM_DISCIPLINES,
      meetings: [
        {
          id: MTG,
          organizationId: ORG,
          locationId: LOC,
          status: "packets_ready",
          scheduledStart: "2026-06-22T14:00:00.000Z",
          scheduledEnd: "2026-06-22T16:00:00.000Z",
          includedPatientIds: [PATIENT],
        },
      ],
    });
    await expect(
      svc.recordDecision(ORG, COORD, MTG, {
        patientId: PATIENT,
        decisionKind: "care_plan_update",
        payload: PAYLOAD.care_plan_update,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "MEETING_NOT_LIVE" }));
  });

  it("the idg_meeting_scope ABAC denies a caller whose session location does not cover the meeting's location (cross-location EoP)", async () => {
    const svc = await liveQuorateMeeting();
    const predicates = buildIdgAbacPredicates({ resolver: svc });
    expect(await predicates.idg_meeting_scope!(ctx({ locationIds: [LOC] }), { id: MTG })).toBe(
      true,
    );
    expect(
      await predicates.idg_meeting_scope!(ctx({ locationIds: [LOC_OTHER] }), { id: MTG }),
    ).toBe(false);
    // A cross-tenant caller fails closed even with the right location id (the resolver returns null off-tenant).
    expect(
      await predicates.idg_meeting_scope!(ctx({ organizationId: ORG_B, locationIds: [LOC] }), {
        id: MTG,
      }),
    ).toBe(false);
  });

  it("a meeting in org_a is invisible to org_b (non-leaking NotFound, RLS-backstop layer above)", async () => {
    const svc = await liveQuorateMeeting();
    await expect(svc.getMeeting(ORG_B, MTG)).rejects.toThrow();
    expect(
      await svc.listSchedule(ORG_B, {
        location: LOC,
        from: "2026-06-01T00:00:00.000Z",
        to: "2026-07-01T00:00:00.000Z",
      }),
    ).toEqual([]);
  });

  it("the platform IDG_REQUIRED_QUORUM is the four-discipline CoP 418.56(b)(3) floor (physician/RN/MSW/chaplain)", () => {
    expect(evaluateQuorum(["hospice_physician", "rn_case_manager", "msw", "chaplain"]).met).toBe(
      true,
    );
    const short = evaluateQuorum(["rn_case_manager", "msw", "chaplain"]);
    expect(short.met).toBe(false);
    expect(short.missingDisciplines).toContain("hospice_physician|medical_director");
  });
});

// ── packet build input fixture (§2.4 D1) — one SUD-flagged encounter strictly after the since-cursor ────────
function packetInput(): PacketBuildInput {
  return {
    context: {
      meetingId: MTG,
      patientId: PATIENT,
      admissionId: "adm-1",
      locationId: LOC,
      builtAt: "2026-06-16T09:00:00.000Z",
      builderJobId: "job-1",
      priorIdgAdjournedAt: "2026-06-01T00:00:00.000Z",
      admissionActivatedAt: "2026-05-01T00:00:00.000Z",
    },
    cover: {
      firstName: "Jane",
      lastInitial: "D",
      age: 71,
      primaryDiagnosisIcd10: "C34.90",
      primaryDiagnosisLabel: "Malignant neoplasm of lung",
      levelOfCare: "routine",
      nextRecertDueAt: null,
      f2fWindowState: "not_due",
      activeDpoa: null,
      activeSudFlag: true,
    },
    sinceLastIdg: {
      encounters: [
        {
          encounterId: "enc-sud",
          encounterType: "rn_visit",
          signedAt: "2026-06-10T00:00:00.000Z",
          authorDiscipline: "rn",
        },
      ],
      significantAssessmentChanges: [],
      j2051Triggers: [],
      ordersChanged: [],
      medicationsChanged: [],
      flaggedEvents: [],
    },
    carePlanSummary: {
      activeProblemCount: 3,
      activeGoalCount: 5,
      activeInterventionCount: 8,
      lastSignedVersionId: "cpv-1",
      lastSignedAt: "2026-06-02T00:00:00.000Z",
      nextReviewDueAt: "2026-06-17T00:00:00.000Z",
      isReviewOverdue: false,
    },
    hopeContext: null,
    carryForwardActionItems: [],
  };
}
