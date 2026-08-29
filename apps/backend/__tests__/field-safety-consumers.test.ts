// apps/backend/__tests__/field-safety-consumers.test.ts — M20-T04 (§4.4 the seams M20 consumes, §4.8 the
// M17/M18 consumers, §7.1 / §7.5 / §7.7).
//
// The properties pinned here are the ones the bindings exist to preserve:
//   • §7.1's cadence arithmetic, endpoint INCLUSIVE — a 60-minute visit at a 60-minute cadence owes
//     exactly one mid-visit prompt, and an exclusive endpoint would silently delete the D2 obligation from
//     the commonest visit length on a hospice schedule;
//   • the mid-visit cadence is re-anchored to the EVV ARRIVAL, and an obligation that already went
//     `overdue` is never slid forward (that would retro-actively make a clinician on time);
//   • an EVV check-in does NOT close an unanswered pre-visit obligation — the ladder keeps running,
//     because `m20_scis_recorded_fulfilled` refuses `recorded` without a fulfilling row and minting one
//     would forge an attestation;
//   • the fail-safe DIRECTION of the per-kind fulfilment window: when a window exceeds
//     `gentleReminderMinutes` the detector's first act is the SUPERVISOR rung, never silence;
//   • the no-show consumer anchors its inquiry on a genuinely overdue obligation or emits nothing at all,
//     and retires the rest so a cancelled visit cannot walk the D4 ladder;
//   • the D14 set is three-valued, an `OnCallProvider` outage is `unavailable` rather than `[]`, and a
//     vendor-covered night is distinguishable from an uncovered one;
//   • M18's coordinates do not exist on the far side of `lastKnownLocationFrom`;
//   • the §7.7 badge is org-keyed, expires at 12 hours, and gates nothing.
import type { EvvLocationDto, OnCallActor, OrgId, SafetyPolicyEffectiveDto } from "@wardenx/types";
import { SAFETY_POLICY_FLOOR } from "@wardenx/types";
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import {
  SAFETY_GPS_SPOOF_BADGE_TTL_HOURS,
  type SafetyScheduleRowFacts,
  type SafetyVisitAnchors,
  createSafetyClinicianSignalCache,
  decideEvvCheckIn,
  decideEvvCheckOut,
  decideVisitCompleted,
  decideVisitNoShow,
  decideVisitReassigned,
  lastKnownLocationFrom,
  midVisitCadencePoints,
  partitionOnCallActors,
  planVisitCadence,
  readCurrentVisitForClinician,
  readLastKnownLocation,
  readOrgShiftLocations,
  readPatientFirstName,
  readVisitAnchors,
  resolveAfterHoursParallelSet,
  windowMinutesForKind,
} from "../src/modules/20-field-safety/consumers";
import { decideOverdueCheckIn } from "../src/modules/20-field-safety/lifecycle";

const ORG = "11111111-1111-4111-8111-111111111111" as OrgId;
const PE = "22222222-2222-4222-8222-222222222222";
const LOC = "33333333-3333-4333-8333-333333333333";
const CLINICIAN = "44444444-4444-4444-8444-444444444444";
const OTHER_CLINICIAN = "55555555-5555-4555-8555-555555555555";
const PATIENT = "66666666-6666-4666-8666-666666666666";
const VISIT = "77777777-7777-4777-8777-777777777777";
const POLICY_VERSION = "88888888-8888-4888-8888-888888888888";

/** The §7.1 visit: 10:00–11:00 UTC. */
const VISIT_ANCHORS: SafetyVisitAnchors = {
  visitId: VISIT,
  organizationId: ORG,
  providerEntityId: PE,
  locationId: LOC,
  clinicianMembershipId: CLINICIAN,
  patientId: PATIENT,
  scheduledStartedAt: "2026-08-03T10:00:00.000Z",
  scheduledEndedAt: "2026-08-03T11:00:00.000Z",
};

const POLICY: SafetyPolicyEffectiveDto = {
  organizationId: ORG,
  versionId: POLICY_VERSION,
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: null,
  ...SAFETY_POLICY_FLOOR,
  subscriptionModel:
    SAFETY_POLICY_FLOOR.subscriptionModel as SafetyPolicyEffectiveDto["subscriptionModel"],
};

function scheduleRow(over: Partial<SafetyScheduleRowFacts> = {}): SafetyScheduleRowFacts {
  return {
    scheduleId: "99999999-9999-4999-8999-999999999999",
    kind: "mid_visit",
    state: "proposed",
    expectedAt: "2026-08-03T11:00:00.000Z",
    windowMinutes: 5,
    clinicianMembershipId: CLINICIAN,
    ...over,
  };
}

afterEach(() => {
  __resetSeamsForTest();
});

describe("§7.1 / §4.8 — the cadence materializer", () => {
  it("owes a 60-minute visit exactly one mid-visit prompt, at its final minute (endpoint INCLUSIVE)", () => {
    expect(midVisitCadencePoints(VISIT_ANCHORS, POLICY)).toEqual(["2026-08-03T11:00:00.000Z"]);
  });

  it("materializes the §7.1 trio: the card at 09:45, the prompt at 11:00, the close at 11:00", () => {
    const decision = planVisitCadence({
      visit: VISIT_ANCHORS,
      policy: POLICY,
      policyVersionId: POLICY_VERSION,
      existing: [],
    });
    const inserts = decision.mutations.flatMap((m) => (m.kind === "insert" ? [m.row] : []));
    expect(inserts.map((r) => [r.kind, r.expectedAt])).toEqual([
      ["pre_visit", "2026-08-03T09:45:00.000Z"],
      ["mid_visit", "2026-08-03T11:00:00.000Z"],
      ["post_visit", "2026-08-03T11:00:00.000Z"],
    ]);
  });

  it("pins the §2.2.4 policy-version snapshot and the visit's tenancy anchors on every row", () => {
    const decision = planVisitCadence({
      visit: VISIT_ANCHORS,
      policy: POLICY,
      policyVersionId: POLICY_VERSION,
      existing: [],
    });
    for (const mutation of decision.mutations) {
      if (mutation.kind !== "insert") continue;
      expect(mutation.row.safetyPolicyVersionId).toBe(POLICY_VERSION);
      expect(mutation.row.organizationId).toBe(ORG);
      expect(mutation.row.providerEntityId).toBe(PE);
      expect(mutation.row.locationId).toBe(LOC);
      expect(mutation.row.windowMinutes).toBeGreaterThan(0);
    }
  });

  it("skips the mid-visit prompt on a visit shorter than the policy minimum, and says why", () => {
    const short = { ...VISIT_ANCHORS, scheduledEndedAt: "2026-08-03T10:45:00.000Z" };
    const decision = planVisitCadence({
      visit: short,
      policy: POLICY,
      policyVersionId: POLICY_VERSION,
      existing: [],
    });
    expect(
      decision.mutations.filter((m) => m.kind === "insert" && m.row.kind === "mid_visit"),
    ).toEqual([]);
    expect(decision.skipped).toEqual([
      { kind: "mid_visit", reason: "visit_shorter_than_mid_visit_minimum" },
    ]);
  });

  it("is a no-op on redelivery — an M17 republish must not become a unique-violation retry loop", () => {
    const first = planVisitCadence({
      visit: VISIT_ANCHORS,
      policy: POLICY,
      policyVersionId: POLICY_VERSION,
      existing: [],
    });
    const existing: SafetyScheduleRowFacts[] = first.mutations.flatMap((m) =>
      m.kind === "insert"
        ? [
            scheduleRow({
              scheduleId: `${m.row.kind}-id`,
              kind: m.row.kind,
              expectedAt: m.row.expectedAt,
              windowMinutes: m.row.windowMinutes,
            }),
          ]
        : [],
    );
    const second = planVisitCadence({
      visit: VISIT_ANCHORS,
      policy: POLICY,
      policyVersionId: POLICY_VERSION,
      existing,
    });
    expect(second.mutations).toEqual([]);
    expect(second.effects).toEqual([]);
    expect(second.skipped.every((s) => s.reason === "already_materialized")).toBe(true);
  });

  it("gives each kind its own fulfilment window (mid-visit borrows the gentle rung; no knob exists)", () => {
    expect(windowMinutesForKind("pre_visit", POLICY)).toBe(POLICY.preVisitWindowMinutes);
    expect(windowMinutesForKind("post_visit", POLICY)).toBe(POLICY.postVisitWindowMinutes);
    expect(windowMinutesForKind("mid_visit", POLICY)).toBe(POLICY.gentleReminderMinutes);
  });

  it("FAIL-SAFE DIRECTION: a window wider than the gentle rung makes the FIRST alert louder, not quieter", () => {
    // The pre-visit window (15) outruns `gentleReminderMinutes` (5), so the row is still `proposed` when
    // the gentle rung passes and the detector's first act is the SUPERVISOR rung at `critical`. Pinned so
    // nobody "fixes" the skipped rung by shortening the window into silence.
    const decision = decideOverdueCheckIn({
      schedule: {
        scheduleId: "pre-visit-id",
        state: "proposed",
        kind: "pre_visit",
        expectedAt: "2026-08-03T09:45:00.000Z",
        windowMinutes: windowMinutesForKind("pre_visit", POLICY),
        clinicianMembershipId: CLINICIAN,
        visitId: VISIT,
        overdueDetectedAt: null,
        escalatedAt: null,
      },
      policy: POLICY,
      nowIso: "2026-08-03T10:00:00.000Z",
      afterHours: false,
    });
    expect(decision.kind).toBe("advance");
    if (decision.kind !== "advance") return;
    expect(decision.tier).toBe("supervisor_alert");
    expect(decision.toState).toBe("escalated");
  });
});

describe("§2.2.1 — reassignment and completion", () => {
  it("re-points only the still-`proposed` obligations at the new clinician", () => {
    const decision = decideVisitReassigned({
      newClinicianMembershipId: OTHER_CLINICIAN,
      existing: [
        scheduleRow({ scheduleId: "a", state: "proposed" }),
        scheduleRow({ scheduleId: "b", state: "recorded" }),
      ],
    });
    expect(decision.mutations).toEqual([
      { kind: "repoint", scheduleId: "a", clinicianMembershipId: OTHER_CLINICIAN },
    ]);
  });

  it("NEVER rewrites the name on an obligation that already went unanswered", () => {
    for (const state of ["overdue", "escalated"] as const) {
      const decision = decideVisitReassigned({
        newClinicianMembershipId: OTHER_CLINICIAN,
        existing: [scheduleRow({ scheduleId: "a", state })],
      });
      expect(decision.mutations).toEqual([]);
    }
  });

  it("retires the mid-visit prompts a short visit outran, and nothing else", () => {
    const decision = decideVisitCompleted({
      completedAt: "2026-08-03T10:30:00.000Z",
      existing: [
        scheduleRow({
          scheduleId: "mid",
          kind: "mid_visit",
          expectedAt: "2026-08-03T11:00:00.000Z",
        }),
        scheduleRow({
          scheduleId: "post",
          kind: "post_visit",
          expectedAt: "2026-08-03T11:00:00.000Z",
        }),
        scheduleRow({
          scheduleId: "pre",
          kind: "pre_visit",
          state: "overdue",
          expectedAt: "2026-08-03T09:45:00.000Z",
        }),
      ],
    });
    expect(decision.mutations).toEqual([
      { kind: "retire", scheduleId: "mid", reason: "visit_completed_early" },
    ]);
  });
});

describe("§4.8 — the no-show inquiry", () => {
  const detectedAt = "2026-08-03T10:15:00.000Z";

  it("anchors on the earliest genuinely-overdue obligation and retires the rest", () => {
    const decision = decideVisitNoShow({
      detectedAt,
      existing: [
        scheduleRow({
          scheduleId: "pre",
          kind: "pre_visit",
          expectedAt: "2026-08-03T09:45:00.000Z",
          windowMinutes: 15,
        }),
        scheduleRow({
          scheduleId: "mid",
          kind: "mid_visit",
          expectedAt: "2026-08-03T11:00:00.000Z",
        }),
        scheduleRow({
          scheduleId: "post",
          kind: "post_visit",
          expectedAt: "2026-08-03T11:00:00.000Z",
        }),
      ],
    });
    expect(decision.inquiry?.scheduleId).toBe("pre");
    expect(decision.inquiry?.minutesOverdue).toBe(30);
    expect(decision.mutations).toEqual([
      { kind: "mark_overdue", scheduleId: "pre", overdueDetectedAt: detectedAt },
      { kind: "retire", scheduleId: "mid", reason: "visit_no_show" },
      { kind: "retire", scheduleId: "post", reason: "visit_no_show" },
    ]);
    expect(decision.effects).toContainEqual({
      kind: "outbox",
      event: "m20.safety.check_in_overdue",
    });
    expect(decision.effects).toContainEqual({
      kind: "alert",
      alert: "m20.safety.check_in_overdue",
    });
  });

  it("emits NO inquiry when every prompt was answered or is still in the future", () => {
    const decision = decideVisitNoShow({
      detectedAt,
      existing: [
        scheduleRow({ scheduleId: "pre", kind: "pre_visit", state: "recorded" }),
        scheduleRow({
          scheduleId: "mid",
          kind: "mid_visit",
          expectedAt: "2026-08-03T11:00:00.000Z",
        }),
      ],
    });
    expect(decision.inquiry).toBeNull();
    expect(decision.effects.some((e) => e.kind === "outbox")).toBe(false);
    expect(decision.mutations).toEqual([
      { kind: "retire", scheduleId: "mid", reason: "visit_no_show" },
    ]);
  });

  it("does not raise a second inquiry when the D4 ladder is already running", () => {
    const decision = decideVisitNoShow({
      detectedAt,
      existing: [
        scheduleRow({
          scheduleId: "pre",
          kind: "pre_visit",
          state: "overdue",
          expectedAt: "2026-08-03T09:45:00.000Z",
        }),
        scheduleRow({
          scheduleId: "mid",
          kind: "mid_visit",
          expectedAt: "2026-08-03T11:00:00.000Z",
        }),
      ],
    });
    expect(decision.inquiry).toBeNull();
    expect(decision.mutations).toEqual([
      { kind: "retire", scheduleId: "mid", reason: "visit_no_show" },
    ]);
  });
});

describe("§7.1 — the M18 bracket consumers", () => {
  it("re-anchors the mid-visit cadence to the ARRIVAL (§7.1: 10:02 in → 11:02 prompt)", () => {
    const decision = decideEvvCheckIn({
      visit: VISIT_ANCHORS,
      checkedInAt: "2026-08-03T10:02:00.000Z",
      existing: [scheduleRow({ scheduleId: "mid", expectedAt: "2026-08-03T11:00:00.000Z" })],
    });
    expect(decision.mutations).toEqual([
      {
        kind: "reanchor",
        scheduleId: "mid",
        expectedAt: "2026-08-03T11:02:00.000Z",
        windowMinutes: 5,
      },
    ]);
  });

  it("never slides an obligation that already went overdue — that would make her retro-actively on time", () => {
    const decision = decideEvvCheckIn({
      visit: VISIT_ANCHORS,
      checkedInAt: "2026-08-03T10:40:00.000Z",
      existing: [scheduleRow({ scheduleId: "mid", state: "overdue" })],
    });
    expect(decision.mutations).toEqual([]);
  });

  it("leaves an unanswered PRE-VISIT obligation open — arriving is not the same as answering (D2)", () => {
    const decision = decideEvvCheckIn({
      visit: VISIT_ANCHORS,
      checkedInAt: "2026-08-03T10:02:00.000Z",
      existing: [
        scheduleRow({
          scheduleId: "pre",
          kind: "pre_visit",
          expectedAt: "2026-08-03T09:45:00.000Z",
          windowMinutes: 15,
        }),
      ],
    });
    expect(decision.mutations).toEqual([]);
  });

  it("opens the post-visit window at the check-out and retires the prompts the visit outran", () => {
    const decision = decideEvvCheckOut({
      visit: VISIT_ANCHORS,
      checkedOutAt: "2026-08-03T10:40:00.000Z",
      policy: POLICY,
      policyVersionId: POLICY_VERSION,
      existing: [
        scheduleRow({
          scheduleId: "post",
          kind: "post_visit",
          expectedAt: "2026-08-03T11:00:00.000Z",
        }),
        scheduleRow({
          scheduleId: "mid",
          kind: "mid_visit",
          expectedAt: "2026-08-03T11:00:00.000Z",
        }),
      ],
    });
    expect(decision.mutations).toEqual([
      {
        kind: "reanchor",
        scheduleId: "post",
        expectedAt: "2026-08-03T10:40:00.000Z",
        windowMinutes: POLICY.postVisitWindowMinutes,
      },
      { kind: "retire", scheduleId: "mid", reason: "visit_completed_early" },
    ]);
  });

  it("MATERIALIZES the post-visit obligation for a visit published before M20 was enabled", () => {
    const decision = decideEvvCheckOut({
      visit: VISIT_ANCHORS,
      checkedOutAt: "2026-08-03T11:55:00.000Z",
      policy: POLICY,
      policyVersionId: POLICY_VERSION,
      existing: [],
    });
    expect(decision.mutations).toEqual([
      {
        kind: "insert",
        row: {
          organizationId: ORG,
          providerEntityId: PE,
          locationId: LOC,
          visitId: VISIT,
          clinicianMembershipId: CLINICIAN,
          kind: "post_visit",
          expectedAt: "2026-08-03T11:55:00.000Z",
          windowMinutes: POLICY.postVisitWindowMinutes,
          safetyPolicyVersionId: POLICY_VERSION,
        },
      },
    ]);
  });

  it("does not resurrect a post-visit obligation the clinician already answered", () => {
    const decision = decideEvvCheckOut({
      visit: VISIT_ANCHORS,
      checkedOutAt: "2026-08-03T11:55:00.000Z",
      policy: POLICY,
      policyVersionId: POLICY_VERSION,
      existing: [scheduleRow({ scheduleId: "post", kind: "post_visit", state: "recorded" })],
    });
    expect(decision.mutations).toEqual([]);
  });
});

describe("§7.7 — the GPS-spoof defensive badge", () => {
  it("lives for 12 hours from the M18 event instant and then expires", () => {
    const cache = createSafetyClinicianSignalCache();
    cache.recordGpsSpoofSuspected(ORG, CLINICIAN, "2026-08-03T08:00:00.000Z");
    expect(cache.gpsSpoofSuspected(ORG, CLINICIAN, "2026-08-03T19:59:00.000Z")).toBe(true);
    expect(cache.gpsSpoofSuspected(ORG, CLINICIAN, "2026-08-03T20:00:00.000Z")).toBe(false);
    expect(SAFETY_GPS_SPOOF_BADGE_TTL_HOURS).toBe(12);
  });

  it("keys on the ORG as well as the membership — a process cache has no RLS", () => {
    const cache = createSafetyClinicianSignalCache();
    const otherOrg = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as OrgId;
    cache.recordGpsSpoofSuspected(ORG, CLINICIAN, "2026-08-03T08:00:00.000Z");
    expect(cache.gpsSpoofSuspected(otherOrg, CLINICIAN, "2026-08-03T09:00:00.000Z")).toBe(false);
  });

  it("does not let a redelivered OLDER event shorten a badge a newer one extended", () => {
    const cache = createSafetyClinicianSignalCache();
    cache.recordGpsSpoofSuspected(ORG, CLINICIAN, "2026-08-03T10:00:00.000Z");
    cache.recordGpsSpoofSuspected(ORG, CLINICIAN, "2026-08-03T08:00:00.000Z");
    expect(cache.gpsSpoofSuspected(ORG, CLINICIAN, "2026-08-03T21:00:00.000Z")).toBe(true);
  });

  it("prunes expired entries so a busy night cannot grow the map without bound", () => {
    const cache = createSafetyClinicianSignalCache();
    cache.recordGpsSpoofSuspected(ORG, CLINICIAN, "2026-08-03T08:00:00.000Z");
    expect(cache.size).toBe(1);
    expect(cache.prune("2026-08-04T08:00:00.000Z")).toBe(1);
    expect(cache.size).toBe(0);
  });
});

describe("§7.5 D14 — the after-hours parallel recipient set", () => {
  const membershipActor = (
    over: Partial<Extract<OnCallActor, { kind: "membership" }>> = {},
  ): OnCallActor => ({
    kind: "membership",
    shiftId: "shift-1",
    membershipId: "rn-patricia",
    userId: "user-patricia",
    discipline: "clinical_rn",
    isBackup: false,
    shiftStartsAt: "2026-08-03T18:00:00.000Z",
    shiftEndsAt: "2026-08-04T08:00:00.000Z",
    ...over,
  });

  it("separates external triage vendors — an unpageable membership list is not an uncovered night", () => {
    const { recipients, externalActors } = partitionOnCallActors([
      {
        kind: "external_vendor",
        shiftId: "shift-2",
        externalActorId: "vendor-1",
        externalActorLabel: "NightNurse Triage",
        discipline: "external",
        shiftStartsAt: "2026-08-03T18:00:00.000Z",
        shiftEndsAt: "2026-08-04T08:00:00.000Z",
      },
    ]);
    expect(recipients).toEqual([]);
    expect(externalActors).toEqual([
      { shiftId: "shift-2", externalActorId: "vendor-1", externalActorLabel: "NightNurse Triage" },
    ]);
  });

  it("pages one phone once, primary beating backup, primaries first", () => {
    const { recipients } = partitionOnCallActors([
      membershipActor({ membershipId: "daniel", isBackup: true, shiftId: "shift-9" }),
      membershipActor({ membershipId: "patricia", isBackup: true, shiftId: "shift-1" }),
      membershipActor({ membershipId: "patricia", isBackup: false, shiftId: "shift-2" }),
    ]);
    expect(recipients.map((r) => [r.membershipId, r.isBackup])).toEqual([
      ["patricia", false],
      ["daniel", true],
    ]);
    expect(recipients.every((r) => r.scope === "on_call_parallel")).toBe(true);
  });

  it("does not consult M19 during business hours (§7.4: no parallel set at 11 AM)", async () => {
    let called = false;
    registerSeam("OnCallProvider", {
      currentOnCallActors: async () => {
        called = true;
        return [];
      },
      activeShiftsAt: async () => [],
    });
    const set = await resolveAfterHoursParallelSet({
      orgId: ORG,
      providerEntityId: PE,
      atIso: "2026-08-03T18:00:00.000Z", // 11:00 America/Los_Angeles
      policy: POLICY,
      orgTimeZone: "America/Los_Angeles",
    });
    expect(set).toEqual({ kind: "not_after_hours" });
    expect(called).toBe(false);
  });

  it("unions the on-call rotation into a 22:30 Saturday SOS (§7.5)", async () => {
    registerSeam("OnCallProvider", {
      currentOnCallActors: async () => [membershipActor({ membershipId: "patricia" })],
      activeShiftsAt: async () => [],
    });
    const set = await resolveAfterHoursParallelSet({
      orgId: ORG,
      providerEntityId: PE,
      atIso: "2026-08-04T05:30:00.000Z", // 22:30 America/Los_Angeles
      policy: POLICY,
      orgTimeZone: "America/Los_Angeles",
    });
    expect(set.kind).toBe("resolved");
    if (set.kind !== "resolved") return;
    expect(set.recipients.map((r) => r.membershipId)).toEqual(["patricia"]);
  });

  it("reports an M19 outage as `unavailable`, NEVER as an empty recipient list", async () => {
    registerSeam("OnCallProvider", {
      currentOnCallActors: async () => {
        throw new Error("on-call read failed");
      },
      activeShiftsAt: async () => [],
    });
    const set = await resolveAfterHoursParallelSet({
      orgId: ORG,
      providerEntityId: PE,
      atIso: "2026-08-04T05:30:00.000Z",
      policy: POLICY,
      orgTimeZone: "America/Los_Angeles",
    });
    expect(set).toEqual({ kind: "unavailable", reason: "on-call read failed" });
  });

  it("treats an UNREGISTERED seam as `unavailable` too — a missing binding is not a quiet night", async () => {
    const set = await resolveAfterHoursParallelSet({
      orgId: ORG,
      providerEntityId: PE,
      atIso: "2026-08-04T05:30:00.000Z",
      policy: POLICY,
      orgTimeZone: "America/Los_Angeles",
    });
    expect(set.kind).toBe("unavailable");
  });

  it("keeps 'nobody is rostered' as a REAL answer, distinct from the outage", async () => {
    registerSeam("OnCallProvider", {
      currentOnCallActors: async () => [],
      activeShiftsAt: async () => [],
    });
    const set = await resolveAfterHoursParallelSet({
      orgId: ORG,
      providerEntityId: PE,
      atIso: "2026-08-04T05:30:00.000Z",
      policy: POLICY,
      orgTimeZone: "America/Los_Angeles",
    });
    expect(set).toEqual({ kind: "resolved", recipients: [], externalActors: [] });
  });
});

describe("§4.4 — the M17 / M18 / M5 reads", () => {
  const sample: EvvLocationDto = {
    membershipId: CLINICIAN,
    eventId: "evv-1",
    visitId: VISIT,
    lat: 45.52,
    lng: -122.68,
    accuracyM: 12,
    capturedAt: "2026-08-03T10:02:00.000Z",
  };

  it("strips M18's coordinates at the boundary — the board DTO has a source and an age, nothing else", () => {
    const dto = lastKnownLocationFrom(sample, "2026-08-03T10:32:00.000Z", VISIT);
    expect(Object.keys(dto).sort()).toEqual(["ageMinutes", "sampledAt", "source"]);
    expect(dto.ageMinutes).toBe(30);
    expect(dto.source).toBe("evv_check_in");
  });

  it("infers a departure when the sample is not the visit she is in right now", () => {
    expect(lastKnownLocationFrom(sample, "2026-08-03T12:00:00.000Z", null).source).toBe(
      "evv_check_out",
    );
  });

  it("floors the age at zero — a device clock ahead of the server must not read as −3 minutes", () => {
    expect(lastKnownLocationFrom(sample, "2026-08-03T10:00:00.000Z", VISIT).ageMinutes).toBe(0);
  });

  it("keeps 'between visits' and 'M17 did not answer' apart", async () => {
    registerSeam("VisitAssignmentReader", {
      activeVisitsForMembershipOnDate: async () => [],
      tonightsOnCallRoster: async () => [],
      currentVisitForClinician: async () => null,
    });
    expect(await readCurrentVisitForClinician(ORG, CLINICIAN)).toEqual({ kind: "no_visit" });

    __resetSeamsForTest();
    registerSeam("VisitAssignmentReader", {
      activeVisitsForMembershipOnDate: async () => [],
      tonightsOnCallRoster: async () => [],
      currentVisitForClinician: async () => {
        throw new Error("visit read failed");
      },
    });
    const read = await readCurrentVisitForClinician(ORG, CLINICIAN);
    expect(read.kind).toBe("unknown");
  });

  it("keeps 'no EVV sample' and 'M18 did not answer' apart", async () => {
    registerSeam("EvvLocationProvider", {
      lastKnownLocationForClinician: async () => null,
      lastKnownLocationsForOrgShift: async () => [],
    });
    expect(
      await readLastKnownLocation({
        orgId: ORG,
        membershipId: CLINICIAN,
        nowIso: "2026-08-03T10:32:00.000Z",
        currentVisitId: null,
      }),
    ).toEqual({ kind: "none" });

    __resetSeamsForTest();
    registerSeam("EvvLocationProvider", {
      lastKnownLocationForClinician: async () => {
        throw new Error("evv read failed");
      },
      lastKnownLocationsForOrgShift: async () => [],
    });
    const read = await readLastKnownLocation({
      orgId: ORG,
      membershipId: CLINICIAN,
      nowIso: "2026-08-03T10:32:00.000Z",
      currentVisitId: null,
    });
    expect(read.kind).toBe("unknown");
  });

  it("keeps the freshest sample per membership on the board read, and nulls the whole map on an outage", async () => {
    registerSeam("EvvLocationProvider", {
      lastKnownLocationForClinician: async () => null,
      lastKnownLocationsForOrgShift: async () => [
        { ...sample, capturedAt: "2026-08-03T09:00:00.000Z", eventId: "old" },
        { ...sample, capturedAt: "2026-08-03T10:02:00.000Z", eventId: "new" },
      ],
    });
    const byMembership = await readOrgShiftLocations(ORG);
    expect(byMembership?.get(CLINICIAN)?.eventId).toBe("new");

    __resetSeamsForTest();
    expect(await readOrgShiftLocations(ORG)).toBeNull();
  });

  it("reads ONE patient field and returns null rather than failing a board row", async () => {
    registerSeam("PatientReader", {
      findByMrn: async () => null,
      findByExternalMrn: async () => null,
      findBySsnLast4AndDob: async () => [],
      findByNameDobSex: async () => [],
      findByLooseName: async () => [],
      findById: async () => ({
        id: PATIENT,
        organizationId: ORG,
        mrn: "MRN-1",
        externalMrns: [],
        lastName: "Whitfield",
        firstName: "William",
        dateOfBirth: "1940-02-02",
        administrativeSex: "M",
        ssnLast4: "1234",
      }),
    });
    expect(await readPatientFirstName(ORG, PATIENT)).toBe("William");

    __resetSeamsForTest();
    expect(await readPatientFirstName(ORG, PATIENT)).toBeNull();
  });

  it("narrows M17's VisitDto to the safety anchors, and answers null when there is no anchor", async () => {
    registerSeam("VisitReader", {
      visitForEncounter: async () => ({
        id: VISIT,
        organizationId: ORG,
        providerEntityId: PE,
        locationId: LOC,
        patientId: PATIENT,
        admissionId: "adm-1",
        patientAddressId: null,
        externalFacilityId: null,
        assignedMembershipId: CLINICIAN,
        assignedDisciplineAtAssignment: "rn",
        visitPurpose: "routine_visit",
        visitSetting: "patient_home",
        scheduledStartedAt: VISIT_ANCHORS.scheduledStartedAt,
        scheduledEndedAt: VISIT_ANCHORS.scheduledEndedAt,
        serviceDate: "2026-08-03",
        actualStartedAt: null,
        actualEndedAt: null,
        status: "published",
        evvBracketState: null,
        encounterId: null,
      }),
      visitsScheduledForMembershipOnDate: async () => [],
      completedVisitsForPatientSince: async () => [],
    });
    expect(await readVisitAnchors(ORG, VISIT)).toEqual(VISIT_ANCHORS);

    __resetSeamsForTest();
    expect(await readVisitAnchors(ORG, VISIT)).toBeNull();
  });
});
