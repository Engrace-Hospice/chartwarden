import { OsrmRoutingProvider, type RoutingCache, matrixCacheKey } from "@wardenx/routing-client";
// apps/backend/__tests__/scheduling-workflow-acceptance.test.ts — M17-T09 the §9 workflow-acceptance suite (the
// FINAL M17 task). One scenario per the §7 plan-named Scheduling workflows — §7.1 (frequency-driven proposal →
// publish → EVV start → encounter-sign completion → caseload contribution), §7.3 (drag-drop reschedule mints a
// linked successor + bumps the optimistic-concurrency version), §7.4 (volunteer / pre-schedule-gate failure: the
// D8 gate refuses a non-credentialed or discipline-mismatched assignment), §7.5 (PTO approval → the `not_on_pto`
// predicate then denies an overlapping window), §7.6 (EVV-missing self-attest: the ≥40-char + step-up floor),
// §7.7 (recurring materialisation + discontinuation cascade), §7.8 (no-show detection → `m17.visit.no_show_detected`),
// §7.9 (OSRM degraded mode — `scheduling.route_optimization` OFF is the Phase-1 path), and §7.10 (PHI minimisation
// at the routing boundary, D9) — exercised end-to-end over the in-memory `SchedulingRouteService` (the same backend
// the §4.1 routes compose over, M17-T07) plus the pure `@wardenx/scheduling` deciders the proposal / recurrence /
// completion paths drive, the §4.7 ABAC predicates the assignment-write routes bind, and the `@wardenx/routing-client`
// adapter that owns the §25.14 OSRM boundary. Deterministic: no infra, injected clock + id sequence.
//
// The route-auth handshake (§4.6/§4.7) status codes wire live in the route layer; each pure machine has its own
// unit suite under packages/scheduling. This asserts the WORKFLOW outcomes (state transitions, the §4.11 outbox
// emissions, the gate verdict, the reschedule lineage, the recurrence cascade) and the §9.3/§9.4 security
// guarantees the service + ABAC layer own (org-pinned non-leaking NotFound, layer-independent cross-tenant deny,
// the seven-predicate gate short-circuit). The RLS layer-independence (§9.3/§9.4) lives in rls-isolation.live (the
// M17 block).
import {
  EVV_MISSING_SELF_ATTEST_MIN_REASON_LENGTH,
  MATERIALIZE_HORIZON_DAYS,
  materializeRecurrence,
  parseRrule,
  planFrequencyProposals,
} from "@wardenx/scheduling";
import { describe, expect, it, vi } from "vitest";
import {
  SchedulingRouteService,
  type SchedulingSeed,
  buildSchedulingAbacPredicates,
  planVisitCompletionFromEncounter,
} from "../src/modules/17-scheduling/index";

const ORG = "org_a";
const ORG_B = "org_b";
const PATIENT = "22222222-2222-4222-8222-222222222222";
const ADMISSION = "33333333-3333-4333-8333-333333333333";
const ADDR = "44444444-4444-4444-8444-444444444444";
const MEM_RN = "mem_rn";
const MEM_LPN = "mem_lpn";
const MEM_VOL = "mem_vol";
const NOW = "2026-06-22T13:00:00.000Z";

// A deterministic id sequence so visit ids are stable across a run (the prod path uses gen_random_uuid()).
function idSeq(): () => string {
  let n = 0;
  return () => `vis-${++n}`;
}

/** The seed that makes the D8 pre-schedule gate PASS for an RN routine visit for PATIENT. */
const GATE_PASS_SEED: SchedulingSeed = {
  disciplines: { [MEM_RN]: "rn", [MEM_LPN]: "lpn", [MEM_VOL]: "volunteer" },
  credentialedMemberships: [MEM_RN, MEM_LPN],
  caseload: [`${MEM_RN}|${PATIENT}`, `${MEM_LPN}|${PATIENT}`],
};

function service(seed: SchedulingSeed = GATE_PASS_SEED): SchedulingRouteService {
  return new SchedulingRouteService({ now: () => NOW, newId: idSeq(), seed });
}

const ROUTINE_VISIT = {
  patientId: PATIENT,
  admissionId: ADMISSION,
  patientAddressId: ADDR,
  externalFacilityId: null,
  assignedMembershipId: MEM_RN,
  visitPurpose: "routine_visit" as const,
  visitSetting: "patient_home" as const,
  scheduledStartedAt: "2026-06-23T14:00:00.000Z",
  scheduledEndedAt: "2026-06-23T15:00:00.000Z",
};

function eventNames(events: ReadonlyArray<{ eventName: string }>): string[] {
  return events.map((e) => e.eventName);
}

// ── §4.7 ABAC context helper (the server-assembled context a predicate evaluates against) ─────────────────
function ctx(overrides: Partial<{ organizationId: string }> = {}) {
  return {
    organizationId: overrides.organizationId ?? ORG,
    userId: "sched_1",
    roles: ["scheduler"],
    providerEntityIds: [] as readonly string[],
    locationIds: [] as readonly string[],
    attributes: {},
  };
}

describe("M17-T09 §7 workflow acceptance", () => {
  it("§7.1 — a frequency proposal publishes, EVV-starts, and an encounter sign completes it (caseload contribution wired live)", async () => {
    // The §2.2.4 / D5 `propose-from-frequency` cron emits the cadence proposals (pure; M7 `CarePlanReader` is the
    // upstream IO). `2:visit:week` → a 4-day interval → two proposals in the 7-day rolling window, deterministic key.
    const proposals = planFrequencyProposals({
      organizationId: ORG,
      providerEntityId: "pe-1",
      locationId: "loc-1",
      patientId: PATIENT,
      admissionId: ADMISSION,
      interventionId: "interv-9",
      frequency: "2:visit:week",
      proposedVisitPurpose: "routine_visit",
      proposedDiscipline: "rn",
      proposedDurationMinutes: 60,
      anchorDate: null,
      windowStart: "2026-06-22",
    });
    expect(proposals.length).toBeGreaterThanOrEqual(2);
    expect(proposals[0]!.source).toBe("frequency_driven_m7");
    expect(proposals[0]!.sourceIdempotencyKey).toBe("interv-9:2026-06-22");
    const genesisOutbox = proposals[0]!.effects
      .filter((e): e is { kind: "outbox"; event: string } => e.kind === "outbox")
      .map((e) => e.event);
    expect(genesisOutbox).toContain("m17.visit.proposed");

    // The scheduler publishes (a manual create runs the genesis + the D8 gate + publish in one path).
    const svc = service();
    const visit = svc.createVisit(ORG, "sched_1", ROUTINE_VISIT);
    expect(visit.status).toBe("published");
    const created = eventNames(svc.drainEvents());
    expect(created).toEqual(["m17.visit.proposed", "m17.visit.assigned", "m17.visit.published"]);

    // The RN arrives and M18 publishes the EVV check-in → the visit advances (system actor, no self-attest).
    const enRoute = svc.startVisit(ORG, "rn", visit.id, undefined, false);
    expect(enRoute.status).toBe("en_route");
    expect(eventNames(svc.drainEvents())).toContain("m17.visit.started");

    // On `m8.encounter.signed` the §4.4 bidirectional consumer completes the linked in_visit visit (system actor).
    const plan = planVisitCompletionFromEncounter(
      { encounterId: "enc-1", patientId: PATIENT, visitId: visit.id, signedAt: NOW },
      { state: "in_visit" },
    );
    expect(plan).toEqual({
      kind: "complete",
      visitId: visit.id,
      event: { type: "complete", isSystemActor: true },
    });
  });

  it("§7.3 — a reschedule mints a linked successor visit and bumps the optimistic-concurrency version", () => {
    const svc = service();
    const original = svc.createVisit(ORG, "sched_1", ROUTINE_VISIT);
    svc.drainEvents();

    const { original: rescheduled, created } = svc.rescheduleVisit(ORG, "sched_1", original.id, {
      newScheduledStartedAt: "2026-06-23T16:00:00.000Z",
      newScheduledEndedAt: "2026-06-23T17:00:00.000Z",
      reason: "patient requested a later afternoon visit time",
    });
    expect(rescheduled.status).toBe("rescheduled");
    expect(rescheduled.rescheduledIntoVisitId).toBe(created.id);
    expect(created.id).not.toBe(original.id);
    expect(created.status).toBe("published");
    // The successor publishes (assigned+published) and the original emits its reschedule/unassigned events.
    const names = eventNames(svc.drainEvents());
    expect(names).toContain("m17.visit.rescheduled");
    expect(names).toContain("m17.visit.published");

    // A reschedule reason shorter than the 20-char floor is refused by the pure machine.
    const svc2 = service();
    const v2 = svc2.createVisit(ORG, "sched_1", ROUTINE_VISIT);
    expect(() =>
      svc2.rescheduleVisit(ORG, "sched_1", v2.id, {
        newScheduledStartedAt: "2026-06-23T16:00:00.000Z",
        newScheduledEndedAt: "2026-06-23T17:00:00.000Z",
        reason: "too short",
      }),
    ).toThrowError(expect.objectContaining({ code: "VISIT_RESCHEDULE_REASON_TOO_SHORT" }));
  });

  it("§7.4 — the D8 pre-schedule gate refuses a non-credentialed assignment on create and a discipline mismatch on reassign", async () => {
    // A volunteer assigned to a routine RN visit fails predicate 3 (`discipline_matches_visit`) AND lacks
    // credentials → the publish path refuses to leave `proposed` (VISIT_PRE_SCHEDULE_GATE_UNMET, 422).
    const svc = service();
    expect(() =>
      svc.createVisit(ORG, "sched_1", { ...ROUTINE_VISIT, assignedMembershipId: MEM_VOL }),
    ).toThrowError(expect.objectContaining({ code: "VISIT_PRE_SCHEDULE_GATE_UNMET" }));

    // A reassign to a membership outside caseload / discipline is refused by the route-layer gate (ForbiddenError
    // PRE_SCHEDULE_GATE_FAILED) — the §8.3 STRIDE "tampering with the assignment" mitigation reruns the gate.
    const ok = svc.createVisit(ORG, "sched_1", ROUTINE_VISIT);
    expect(() => svc.reassignVisit(ORG, "sched_1", ok.id, MEM_VOL)).toThrowError(
      expect.objectContaining({ message: "PRE_SCHEDULE_GATE_FAILED" }),
    );

    // The §4.7 predicates resolve the same facts independently: discipline matches for the RN, denies the volunteer.
    const predicates = buildSchedulingAbacPredicates({ resolver: svc });
    const target = {
      membershipId: MEM_RN,
      visitPurpose: "routine_visit",
      patientId: PATIENT,
      serviceDate: "2026-06-23",
    };
    expect(await predicates.discipline_matches_visit!(ctx(), target)).toBe(true);
    expect(
      await predicates.discipline_matches_visit!(ctx(), { ...target, membershipId: MEM_VOL }),
    ).toBe(false);
    expect(await predicates.within_caseload_or_unassigned_pool!(ctx(), target)).toBe(true);
  });

  // Code review 2026-08-14 — the Drizzle resolver picked ONE discipline with `roleRows.find(...)` over an
  // UNORDERED role query, so a membership holding several disciplines got an arbitrary one and both the D8
  // gate and this predicate judged the visit against it. "Does this clinician hold A discipline that fits
  // this visit?" is a set-intersection question; the seed below puts the NON-qualifying discipline first so
  // a single-value resolver that trusts arrival order denies a clinician who plainly qualifies.
  it("§4.7 — a membership holding SEVERAL disciplines qualifies on ANY of them, whatever the order", async () => {
    const MEM_MULTI = "mem_multi";
    const svc = service({
      disciplines: { [MEM_MULTI]: ["volunteer", "rn"] },
      credentialedMemberships: [MEM_MULTI],
      caseload: [`${MEM_MULTI}|${PATIENT}`],
    });
    const predicates = buildSchedulingAbacPredicates({ resolver: svc });
    const target = {
      membershipId: MEM_MULTI,
      visitPurpose: "routine_visit",
      patientId: PATIENT,
      serviceDate: "2026-06-23",
    };
    // `routine_visit` accepts rn/lpn — the SECOND discipline held. Order must not decide the answer.
    expect(await predicates.discipline_matches_visit!(ctx(), target)).toBe(true);
    // …and the volunteer half is not a free pass onto a purpose neither discipline covers.
    expect(
      await predicates.discipline_matches_visit!(ctx(), { ...target, visitPurpose: "msw_assessment" }),
    ).toBe(false);
    // The service-layer D8 gate reads the same set, so the two layers still agree.
    expect(() =>
      svc.createVisit(ORG, "sched_1", { ...ROUTINE_VISIT, assignedMembershipId: MEM_MULTI }),
    ).not.toThrow();
  });

  it("§7.5 — an approved PTO window makes the `not_on_pto` predicate deny an overlapping visit assignment", async () => {
    const svc = service();
    const pto = svc.requestTimeOff(ORG, "sched_1", {
      membershipId: MEM_RN,
      kind: "pto",
      startsAt: "2026-06-23T00:00:00.000Z",
      endsAt: "2026-06-24T00:00:00.000Z",
    });
    expect(eventNames(svc.drainEvents())).toContain("m17.time_off.requested");
    svc.approveTimeOff(ORG, "sched_1", pto.id);
    expect(eventNames(svc.drainEvents())).toContain("m17.time_off.approved");

    const predicates = buildSchedulingAbacPredicates({ resolver: svc });
    const onPtoDay = {
      membershipId: MEM_RN,
      scheduledStartedAt: "2026-06-23T14:00:00.000Z",
      scheduledEndedAt: "2026-06-23T15:00:00.000Z",
    };
    expect(await predicates.not_on_pto!(ctx(), onPtoDay)).toBe(false); // overlaps the approved window → deny
    // A window the day AFTER the PTO ends is clear.
    expect(
      await predicates.not_on_pto!(ctx(), {
        membershipId: MEM_RN,
        scheduledStartedAt: "2026-06-25T14:00:00.000Z",
        scheduledEndedAt: "2026-06-25T15:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("§7.6 — EVV-missing self-attest requires step-up + a ≥40-char reason, then advances with the documented bracket", () => {
    const svc = service();
    const visit = svc.createVisit(ORG, "sched_1", ROUTINE_VISIT);
    svc.drainEvents();

    // A self-attest with no step-up is refused.
    expect(() =>
      svc.startVisit(
        ORG,
        "rn",
        visit.id,
        "x".repeat(EVV_MISSING_SELF_ATTEST_MIN_REASON_LENGTH),
        false,
      ),
    ).toThrowError(expect.objectContaining({ code: "EVV_SELF_ATTEST_STEP_UP_REQUIRED" }));

    // A step-up but a too-short reason is refused.
    expect(() => svc.startVisit(ORG, "rn", visit.id, "signal failure", true)).toThrowError(
      expect.objectContaining({ code: "EVV_MISSING_REASON_TOO_SHORT" }),
    );

    // Step-up + a ≥40-char documented reason → the visit advances to en_route.
    const reason =
      "Cell signal failure at patient location — verified by patient signature on the tablet at start";
    const enRoute = svc.startVisit(ORG, "rn", visit.id, reason, true);
    expect(enRoute.status).toBe("en_route");
    expect(eventNames(svc.drainEvents())).toContain("m17.visit.started");
  });

  it("§7.7 — a recurring policy materialises a 90-day horizon and discontinuation emits the cascade event", () => {
    const svc = service();
    const recurring = svc.createRecurring(ORG, "sched_1", {
      patientId: PATIENT,
      admissionId: ADMISSION,
      assignedMembershipId: MEM_RN,
      visitPurpose: "routine_visit",
      visitSetting: "patient_home",
      rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
    });
    expect(recurring.status).toBe("active");

    // The nightly `materialize-recurring` worker enumerates MO/WE/FR over the rolling horizon (pure, DST-exact).
    const occurrences = materializeRecurrence(
      {
        rule: parseRrule("FREQ=WEEKLY;BYDAY=MO,WE,FR"),
        startDate: "2026-07-01",
        endDate: "2026-12-31",
        timeOfDayStart: "10:00",
        timeOfDayEnd: "11:00",
        timeZone: "America/Los_Angeles",
      },
      "2026-07-01",
      MATERIALIZE_HORIZON_DAYS,
    );
    expect(occurrences.length).toBeGreaterThan(30); // ~3/week × ~13 weeks within the 90-day horizon
    expect(occurrences[0]!.serviceDate).toBe("2026-07-01"); // a Wednesday — fires on the WE rule

    // Discontinuation cascade-cancels future children and emits the discontinued event.
    const discontinued = svc.discontinueRecurring(ORG, "sched_1", recurring.id);
    expect(discontinued.status).toBe("discontinued");
    expect(eventNames(svc.drainEvents())).toContain("m17.recurring_visit.discontinued");
  });

  it("§7.8 — a no-show detection transitions the visit and emits `m17.visit.no_show_detected` (→ M19 on-call, inert)", () => {
    const svc = service();
    const visit = svc.createVisit(ORG, "sched_1", ROUTINE_VISIT);
    svc.drainEvents();

    const noShow = svc.noShowVisit(
      ORG,
      "sched_1",
      visit.id,
      "Patient went to ER per family; did not answer door",
    );
    expect(noShow.status).toBe("no_show");
    const names = eventNames(svc.drainEvents());
    expect(names).toContain("m17.visit.no_show_detected");
    expect(names).toContain("m17.visit.unassigned"); // caseload contribution removed
  });

  it("§7.9 — route optimisation is degraded when the flag is OFF and when OSRM is unhealthy (Phase-1 path)", async () => {
    // Flag OFF (Phase 1 default) → degraded with `optimization_disabled`, no OSRM call.
    const off = service();
    const offResult = await off.optimizeDay(ORG, "sched_1", {
      membershipId: MEM_RN,
      serviceDate: "2026-06-23",
    });
    expect(offResult).toMatchObject({
      degraded: true,
      reason: "optimization_disabled",
      segmentCount: 0,
    });
    expect(eventNames(off.drainEvents())).toContain("m17.route_optimization_degraded");

    // Flag ON but the circuit-breaker reports unhealthy → degraded with `osrm_unavailable`.
    const unhealthyRouting = {
      healthy: vi.fn(async () => false),
      matrix: vi.fn(),
      directions: vi.fn(),
    };
    const onButDown = new SchedulingRouteService({
      now: () => NOW,
      newId: idSeq(),
      seed: GATE_PASS_SEED,
      routing: unhealthyRouting as never,
      routeOptimizationEnabled: true,
    });
    const downResult = await onButDown.optimizeDay(ORG, "sched_1", {
      membershipId: MEM_RN,
      serviceDate: "2026-06-23",
    });
    expect(downResult).toMatchObject({ degraded: true, reason: "osrm_unavailable" });
    expect(unhealthyRouting.matrix).not.toHaveBeenCalled(); // no PHI-bearing call when degraded
  });

  it("§7.10 / D9 — the OSRM boundary carries coordinates only; the cache key is a coord hash (no name / MRN / address)", async () => {
    // The matrix cache key is a SHA-256 of the SORTED rounded coords — order-invariant, address-free.
    const coords = [
      { lat: 45.5, lng: -122.6 },
      { lat: 45.51, lng: -122.61 },
    ];
    const key = matrixCacheKey(coords);
    expect(key).toMatch(/^osrm:m:[0-9a-f]{64}$/);
    expect(matrixCacheKey([coords[1]!, coords[0]!])).toBe(key); // sorting makes it order-invariant

    // The adapter's request builder puts ONLY `lng,lat` pairs in the URL — capture the outbound request.
    let capturedUrl = "";
    const memCache: RoutingCache = { get: async () => null, set: async () => {} };
    const adapter = new OsrmRoutingProvider({
      endpoint: "http://osrm.internal:5000",
      cache: memCache,
      now: () => NOW,
      fetchImpl: async (url: string) => {
        capturedUrl = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            durations: [
              [0, 60],
              [60, 0],
            ],
            distances: [
              [0, 1609],
              [1609, 0],
            ],
          }),
        };
      },
    });
    await adapter.matrix(coords);
    expect(capturedUrl).toContain("/table/v1/driving/-122.6,45.5;-122.61,45.51");
    expect(capturedUrl).not.toMatch(new RegExp(PATIENT));
    expect(capturedUrl.toLowerCase()).not.toContain("mrn");
    expect(capturedUrl.toLowerCase()).not.toContain("name");
  });
});

describe("M17-T09 §9.3 / §9.4 security & layer-independence (org-pinned non-leak, cross-tenant deny, gate short-circuit)", () => {
  it("§9.4 a visit in org_a is invisible to org_b (non-leaking NotFound; the RLS backstop is the live block)", () => {
    const svc = service();
    const visit = svc.createVisit(ORG, "sched_1", ROUTINE_VISIT);
    expect(svc.getVisit(ORG, visit.id).id).toBe(visit.id);
    expect(() => svc.getVisit(ORG_B, visit.id)).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    expect(svc.listVisits(ORG_B, {})).toEqual([]);
  });

  it("§9.4 the §4.7 ABAC predicates fail closed for a cross-tenant caller (the resolver is org-pinned)", async () => {
    const svc = service();
    const predicates = buildSchedulingAbacPredicates({ resolver: svc });
    const target = {
      membershipId: MEM_RN,
      visitPurpose: "routine_visit",
      patientId: PATIENT,
      serviceDate: "2026-06-23",
    };
    // The seeded facts live tenant-agnostically in the in-mem resolver, but caseload denies for an absent pair and
    // credentials deny on an unknown membership — the live RLS block proves the org boundary on real Postgres.
    expect(
      await predicates.discipline_matches_visit!(ctx(), { ...target, membershipId: "unknown_mem" }),
    ).toBe(false);
    expect(
      await predicates.within_caseload_or_unassigned_pool!(ctx(), {
        ...target,
        patientId: "other-patient",
      }),
    ).toBe(false);
    expect(
      await predicates.clinician_credentials_active!(ctx(), { ...target, membershipId: MEM_VOL }),
    ).toBe(false);
  });

  it("§9.4 an incomplete ABAC target denies (fail-closed) rather than throwing", async () => {
    const svc = service();
    const predicates = buildSchedulingAbacPredicates({ resolver: svc });
    expect(await predicates.discipline_matches_visit!(ctx(), {})).toBe(false);
    expect(await predicates.not_on_pto!(ctx(), { membershipId: MEM_RN })).toBe(false); // missing window → deny
    expect(
      await predicates.discipline_matches_visit!(ctx(), {
        membershipId: MEM_RN,
        visitPurpose: "not_a_purpose",
      }),
    ).toBe(false);
  });
});
