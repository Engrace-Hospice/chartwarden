import { describe, expect, it } from "vitest";
import {
  PLATFORM_FLOOR_SETTINGS,
  assertTightenOnly,
  missingResolutionBlocksBilling,
  missingResolutionDisposition,
  resolveEffectivePolicy,
} from "../src/modules/18-evv/domain/index";
// apps/backend/__tests__/evv-workflow-acceptance.test.ts — M18-T08 the §9 workflow-acceptance suite (the FINAL
// M18 task, closing M18 EVV). It pins the §12 sign-off behaviours that pure code + the in-memory route service
// reach deterministically, and the §9.4 LAYER-INDEPENDENCE half the application layer owns (org-pinned
// non-leaking NotFound, ABAC predicates fail-closed cross-tenant, the coordinate-minimised portal projection).
// The complementary §9.3/§9.4 RLS half — the database backstop across all six owned tables — lives in
// packages/db/migrations/__tests__/rls-isolation.live.test.ts (the M18 block, real Postgres). Together the two
// layers each INDEPENDENTLY block the cross-tenant / cross-caseload violation (defence in depth, §9.4).
//
// Scenarios map to the §12 decision checklist reachable without infra:
//   D2  — a check-in and a check-out are SEPARATE rows on one visit (single-row-per-event).
//   D3  — three-layer geofence precedence (platform → tenant → patient_address; narrowest wins) + tighten-only.
//   D6  — the missing-EVV resolution machine close paths + the ADR-0008 "only `open` blocks billing" classifiers.
//   D7  — the aggregator submission machine: resubmit valid only from rejected/timeout; cancel only non-terminal.
//   D10 — the portal arrival projection is coordinate-free; the team-location seam is the only coord-bearing read.
// Each pure machine has its own exhaustive unit suite (evv-aggregator / evv-missing-resolution / evv-geofence);
// this asserts the WORKFLOW outcomes over the same `EvvRouteService` the §4.1 routes compose over (M18-T06).
import {
  EvvRouteService,
  buildEvvAbacPredicates,
  isAggregatorSubmissionCancellable,
  isAggregatorSubmissionResubmittable,
} from "../src/modules/18-evv/index";

const ORG = "org_a";
const ORG_B = "org_b";
const MEM_RN = "mem_rn";
const PATIENT = "22222222-2222-4222-8222-222222222222";
const VISIT = "11111111-1111-4111-8111-111111111111";
const ADDR = "44444444-4444-4444-8444-444444444444";

// The visit window straddles the capture instant so `evv_within_visit_window` passes for an in-window capture.
const SCHED_START = "2026-06-22T14:00:00.000Z";
const SCHED_END = "2026-06-22T15:00:00.000Z";
const IN_WINDOW = "2026-06-22T14:05:00.000Z";

/** A service seeded with one org_a visit assigned to the RN, an open resolution, and two submissions. */
function service(): EvvRouteService {
  return new EvvRouteService({
    visits: [
      {
        organizationId: ORG,
        visitId: VISIT,
        patientId: PATIENT,
        assignedMembershipId: MEM_RN,
        scheduledStartedAt: SCHED_START,
        scheduledEndedAt: SCHED_END,
      },
    ],
    resolutions: [
      {
        organizationId: ORG,
        id: "mr-open",
        visitId: VISIT,
        kind: "missing_checkout",
        status: "open",
      },
    ],
    submissions: [
      {
        organizationId: ORG,
        id: "sub-rejected",
        visitId: VISIT,
        stateCode: "TX",
        aggregatorVendor: "sandata",
        status: "rejected",
      },
      {
        organizationId: ORG,
        id: "sub-accepted",
        visitId: VISIT,
        stateCode: "TX",
        aggregatorVendor: "sandata",
        status: "accepted",
        aggregatorTransactionId: "txn-1",
      },
    ],
  });
}

// ── §4.7 ABAC context helper (the server-assembled context a predicate evaluates against) ──────────────────
function ctx(organizationId: string = ORG) {
  return {
    organizationId,
    userId: "u1",
    roles: ["field_clinician"],
    providerEntityIds: [] as readonly string[],
    locationIds: [] as readonly string[],
    attributes: {},
  };
}

describe("M18-T08 §12 workflow acceptance", () => {
  it("D2 — a check-in and a check-out are SEPARATE rows on one visit; the bracket reads `present`", () => {
    const svc = service();
    const checkIn = svc.recordCapture(ORG, MEM_RN, "check_in", {
      visitId: VISIT,
      coords: { lat: 45.5, lng: -122.6 },
      accuracyM: 8,
      capturedAt: IN_WINDOW,
    });
    const checkOut = svc.recordCapture(ORG, MEM_RN, "check_out", {
      visitId: VISIT,
      coords: { lat: 45.5, lng: -122.6 },
      accuracyM: 8,
      capturedAt: SCHED_END,
    });
    expect(checkIn.eventId).not.toBe(checkOut.eventId); // single-row-per-event (D2)
    expect(checkIn.kind).toBe("check_in");
    expect(checkOut.kind).toBe("check_out");
    expect(svc.listEvents(ORG, { visit: VISIT })).toHaveLength(2);
    expect(svc.bracketForVisit(ORG, VISIT).bracketState).toBe("present");
  });

  it("D3 — the geofence policy resolves the NARROWEST layer (patient_address < tenant < platform) and tighten-only holds", () => {
    const layers = [
      { scope: "platform" as const, patientAddressId: null, radiusM: 200, maxAccuracyM: 50 },
      { scope: "tenant" as const, patientAddressId: null, radiusM: 100, maxAccuracyM: 40 },
      { scope: "patient_address" as const, patientAddressId: ADDR, radiusM: 60, maxAccuracyM: 20 },
    ];
    // A visit at ADDR resolves to the per-address override (narrowest).
    expect(resolveEffectivePolicy(layers, ADDR)).toEqual({ radiusM: 60, maxAccuracyM: 20 });
    // A visit at a different address falls back to the tenant default.
    expect(resolveEffectivePolicy(layers, "other-addr")).toEqual({
      radiusM: 100,
      maxAccuracyM: 40,
    });
    // The tenant layer tightens the platform floor; loosening is refused.
    expect(() =>
      assertTightenOnly(PLATFORM_FLOOR_SETTINGS, { radiusM: 100, maxAccuracyM: 40 }),
    ).not.toThrow();
    expect(() =>
      assertTightenOnly(PLATFORM_FLOOR_SETTINGS, { radiusM: 300, maxAccuracyM: 40 }),
    ).toThrowError(expect.objectContaining({ code: "GEOFENCE_POLICY_NOT_TIGHTENING" }));
  });

  it("D3 — the route service enforces tighten-only on a tenant policy edit (may not loosen past the platform floor)", () => {
    const svc = service();
    expect(svc.editTenantPolicy(ORG, "u1", { radiusM: 80, maxAccuracyM: 30 }).tenant).toEqual({
      radiusM: 80,
      maxAccuracyM: 30,
    });
    expect(() => svc.editTenantPolicy(ORG, "u1", { radiusM: 250, maxAccuracyM: 30 })).toThrowError(
      expect.objectContaining({ code: "CONFLICT" }),
    );
  });

  it("D6 — a clinician self-attest closes the open resolution; ADR-0008 then reports it documented (non-blocking)", () => {
    const svc = service();
    expect(missingResolutionBlocksBilling("open")).toBe(true); // unresolved_missing blocks (ADR-0008)
    const reason =
      "Patient's cellular signal dropped at the rural home; verified by tablet signature at the door.";
    const closed = svc.clinicianAttestResolution(ORG, MEM_RN, "mr-open", reason);
    expect(closed.status).toBe("closed_clinician_attested");
    expect(closed.resolvedByMembershipId).toBe(MEM_RN);
    expect(missingResolutionBlocksBilling("closed_clinician_attested")).toBe(false); // documented_missing → allowed
    expect(missingResolutionDisposition("closed_clinician_attested")).toBe("documented_missing");
  });

  it("D6 — a too-short self-attest reason is refused by the pure machine (the §7.3 ≥40-char floor)", () => {
    const svc = service();
    expect(() =>
      svc.clinicianAttestResolution(ORG, MEM_RN, "mr-open", "signal dropped"),
    ).toThrowError(expect.objectContaining({ code: "EVV_RESOLUTION_REASON_TOO_SHORT" }));
  });

  it("D6 — a supervisor override requires fresh step-up; without it the machine refuses", () => {
    const svc = service();
    const reason =
      "Supervisor override after review of the route log, the device sync history, and the patient call.";
    expect(() =>
      svc.supervisorOverrideResolution(ORG, "mem_sup", "mr-open", reason, false),
    ).toThrowError(expect.objectContaining({ code: "EVV_SUPERVISOR_OVERRIDE_STEP_UP_REQUIRED" }));
    const ok = svc.supervisorOverrideResolution(ORG, "mem_sup", "mr-open", reason, true);
    expect(ok.status).toBe("closed_supervisor_override");
  });

  it("D7 — a rejected submission resubmits (→ queued, attempt++); cancel is refused on a terminal accepted row", () => {
    const svc = service();
    expect(isAggregatorSubmissionResubmittable("rejected")).toBe(true);
    expect(isAggregatorSubmissionCancellable("accepted")).toBe(false);

    const resubmitted = svc.resubmitSubmission(ORG, "u1", "sub-rejected");
    expect(resubmitted.status).toBe("queued");
    expect(resubmitted.attemptCount).toBe(1); // §2.2.5 resubmit increments the attempt count

    // The accepted row is terminal (the §2.2.5 graph admits no operator event) — both paths are refused.
    expect(() => svc.resubmitSubmission(ORG, "u1", "sub-accepted")).toThrowError(
      expect.objectContaining({ code: "ILLEGAL_AGGREGATOR_SUBMISSION_TRANSITION" }),
    );
    expect(() =>
      svc.cancelSubmission(ORG, "u1", "sub-accepted", "already accepted by the state"),
    ).toThrowError(expect.objectContaining({ code: "ILLEGAL_AGGREGATOR_SUBMISSION_TRANSITION" }));
  });

  it("D10 — the portal arrival projection carries timestamps only; the team-location seam is the only coord-bearing read", () => {
    const svc = service();
    svc.recordCapture(ORG, MEM_RN, "check_in", {
      visitId: VISIT,
      coords: { lat: 45.5, lng: -122.6 },
      accuracyM: 8,
      capturedAt: IN_WINDOW,
    });
    const arrival = svc.portalArrival(ORG, VISIT);
    expect(arrival.arrivedAt).toBe(IN_WINDOW);
    // The DTO has NO coordinate fields (D10 — portal sessions never see clinician GPS).
    expect(Object.keys(arrival)).toEqual(["visitId", "arrivedAt", "departedAt"]);
    expect(JSON.stringify(arrival)).not.toContain("45.5");
    // The field-safety location seam IS coordinate-bearing (the one D10 exception, M20 supervisor awareness).
    const loc = svc.clinicianCurrentLocation(ORG, MEM_RN);
    expect(loc[0]!.lat).toBe(45.5);
    expect(loc[0]!.lng).toBe(-122.6);
  });
});

describe("M18-T08 §9.3 / §9.4 layer-independence (org-pinned non-leak, ABAC fail-closed cross-tenant)", () => {
  it("§9.4 a visit + its events in org_a are invisible to org_b (non-leaking NotFound / empty list)", () => {
    const svc = service();
    svc.recordCapture(ORG, MEM_RN, "check_in", {
      visitId: VISIT,
      coords: { lat: 45.5, lng: -122.6 },
      accuracyM: 8,
      capturedAt: IN_WINDOW,
    });
    // Org A reads its own bracket; Org B is denied with a non-leaking NotFound.
    expect(svc.bracketForVisit(ORG, VISIT).visitId).toBe(VISIT);
    expect(() => svc.bracketForVisit(ORG_B, VISIT)).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    // Cross-tenant list reads return empty (org-pinned), never another tenant's rows.
    expect(svc.listEvents(ORG_B, { visit: VISIT })).toEqual([]);
    expect(svc.listAggregatorSubmissions(ORG_B, {})).toEqual([]);
    expect(svc.listMissingResolutions(ORG_B, {})).toEqual([]);
    expect(svc.clinicianCurrentLocation(ORG_B, MEM_RN)).toEqual([]);
  });

  it("§9.4 a cross-tenant resolution / submission mutation is a non-leaking NotFound (the resolver is org-pinned)", () => {
    const svc = service();
    expect(() => svc.resubmitSubmission(ORG_B, "u1", "sub-rejected")).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    expect(() =>
      svc.clinicianAttestResolution(ORG_B, MEM_RN, "mr-open", "x".repeat(40)),
    ).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("§4.7/§9.4 `assigned_clinician_for_visit` passes only for the visit's clinician and fails closed cross-tenant", async () => {
    const svc = service();
    const predicates = buildEvvAbacPredicates({ resolver: svc });
    const pass = await predicates.assigned_clinician_for_visit!(ctx(), {
      visitId: VISIT,
      membershipId: MEM_RN,
    });
    expect(pass).toBe(true);
    // A different membership is denied.
    expect(
      await predicates.assigned_clinician_for_visit!(ctx(), {
        visitId: VISIT,
        membershipId: "other",
      }),
    ).toBe(false);
    // A cross-tenant caller is denied (the resolver returns null for org_b → fail-closed).
    expect(
      await predicates.assigned_clinician_for_visit!(ctx(ORG_B), {
        visitId: VISIT,
        membershipId: MEM_RN,
      }),
    ).toBe(false);
    // An incomplete target denies (fail-closed) rather than throwing.
    expect(await predicates.assigned_clinician_for_visit!(ctx(), {})).toBe(false);
  });

  it("§4.7/§9.4 `evv_within_visit_window` passes inside the window, denies outside it and cross-tenant", async () => {
    const svc = service();
    const predicates = buildEvvAbacPredicates({ resolver: svc });
    expect(
      await predicates.evv_within_visit_window!(ctx(), {
        visitId: VISIT,
        eventCapturedAt: IN_WINDOW,
      }),
    ).toBe(true);
    // A capture a full day after the scheduled end is outside the 4h-after window.
    expect(
      await predicates.evv_within_visit_window!(ctx(), {
        visitId: VISIT,
        eventCapturedAt: "2026-06-23T20:00:00.000Z",
      }),
    ).toBe(false);
    // Cross-tenant → the resolver returns null → fail-closed.
    expect(
      await predicates.evv_within_visit_window!(ctx(ORG_B), {
        visitId: VISIT,
        eventCapturedAt: IN_WINDOW,
      }),
    ).toBe(false);
  });
});
