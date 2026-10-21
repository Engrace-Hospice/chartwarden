import type { RecipientResolverFn } from "@wardenx/messaging";
import { resolveRecipients } from "@wardenx/messaging";
// apps/backend/__tests__/field-safety-seams.test.ts — M20-T05 (§4.3 the seven published seams, §4.5 the
// `field_safety_composed` recipient resolver, M20-F06 the emergency-contact row).
//
// The properties pinned here are the ones the task exists to guarantee:
//   • all seven seams are DECLARED in the M1 registry with a fail-closed deny-stub, and every deny-stub
//     THROWS — an empty board and an empty recipient set are real answers and an outage must not be able
//     to produce either;
//   • `registerFieldSafetySeams` with no store registers NOTHING, so a DB-less boot cannot manufacture
//     "everyone is fine";
//   • the `orgId` argument is an ASSERTION: a mismatched org is a 403, not a cross-tenant read;
//   • `SafetyPolicyProvider` answers the platform floor for a tenant with no version row, and REPLAYS the
//     row in force at an arbitrary instant rather than today's;
//   • the coverage gap distinguishes all three §7.8 reasons, and `vacation_forwards_unresolved` needs
//     BOTH sides of the forwarding pair in the active-supervisor set;
//   • `supervisorsForClinician` scopes on the requested ALERT KIND, not on `sos` alone;
//   • the per-visit badge trio reports the WORST outstanding mid-visit prompt, so an answered 11:02 does
//     not clear an unanswered 12:02;
//   • the §8.6 projection REFUSES without a DEK decipher and rounds to three decimals with it;
//   • the after-hours metric judges each press against the window ITS OWN policy version pinned, in the
//     org's zone, and refuses when no zone is bound;
//   • the §4.5 composed resolver returns USER ids, delivers to the vacation-forward TARGET, unions the
//     on-call rotation after the supervisors, and reports every gap a `string[]` cannot express.
import type {
  IsoInstant,
  MembershipId,
  OrgId,
  ProviderEntityId,
  SafetyMetricsWindow,
} from "@wardenx/types";
import { SAFETY_POLICY_FLOOR } from "@wardenx/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  REQUIRED_SEAMS,
  __resetSeamsForTest,
  getSeam,
  registerSeam,
  validateSeams,
} from "../src/bootstrap/seams/registry";
import {
  type M20AlertResolverPorts,
  M20_COMPOSED_RECIPIENT_RESOLVER,
  type SafetyComposedGap,
  type SafetySeamSeed,
  createInMemorySafetySeamStore,
  createSafetyCheckInProvider,
  createSafetyContextReader,
  createSafetyDashboardProvider,
  createSafetyIncidentReader,
  createSafetyMetricsProvider,
  createSafetyPolicyProvider,
  createSafetySupervisorProvider,
  deliveryMembershipsFor,
  emergencyContactConsentPresent,
  perHundredVisits,
  percentileOf,
  pointInPolygon,
  readEmergencyContact,
  registerFieldSafetySeams,
  registerM20AlertResolvers,
  roundCoordinates,
  supervisorRecipientsFrom,
  visitCheckInBadges,
} from "../src/modules/20-field-safety/index";
import type { SafetySubscriptionFacts } from "../src/modules/20-field-safety/lifecycle";

const ORG = "11111111-1111-4111-8111-111111111111" as OrgId;
const OTHER_ORG = "99999999-9999-4999-8999-999999999999" as OrgId;
const PE = "22222222-2222-4222-8222-222222222222" as ProviderEntityId;
const LOC_A = "33333333-3333-4333-8333-333333333333";
const LOC_B = "3b333333-3333-4333-8333-333333333333";
const CLINICIAN = "44444444-4444-4444-8444-444444444444" as MembershipId;
const SUPERVISOR = "55555555-5555-4555-8555-555555555555" as MembershipId;
const BACKUP_SUP = "5b555555-5555-4555-8555-555555555555" as MembershipId;
const VISIT = "77777777-7777-4777-8777-777777777777";
const NOW = "2026-08-04T03:00:00.000Z" as IsoInstant;

/** The org resolver every provider gets in these tests: the caller IS in `ORG`. */
const orgOf = () => ORG;
const now = () => NOW;

const SEVEN_SEAMS = [
  "SafetyDashboardProvider",
  "SafetyContextReader",
  "SafetyIncidentReader",
  "SafetyMetricsProvider",
  "SafetyCheckInProvider",
  "SafetyPolicyProvider",
  "SafetySupervisorProvider",
] as const;

const subscription = (over: Partial<SafetySubscriptionFacts> = {}): SafetySubscriptionFacts => ({
  supervisorMembershipId: SUPERVISOR,
  scopeKind: "explicit",
  clinicianMembershipId: CLINICIAN,
  locationId: null,
  providerEntityId: null,
  alertKinds: ["sos", "overdue"],
  isVacationForwarding: false,
  vacationForwardToMembershipId: null,
  ...over,
});

const store = (seed: SafetySeamSeed = {}) => createInMemorySafetySeamStore(seed);

const WINDOW: SafetyMetricsWindow = {
  from: "2026-08-01T00:00:00.000Z" as IsoInstant,
  to: "2026-09-01T00:00:00.000Z" as IsoInstant,
};

afterEach(() => {
  __resetSeamsForTest();
});

describe("M20-T05 §4.3 — the seven seams are declared and fail CLOSED", () => {
  it("declares all seven in REQUIRED_SEAMS, owned by M20", () => {
    for (const key of SEVEN_SEAMS) {
      const entry = REQUIRED_SEAMS.find((s) => s.key === key);
      expect(entry, `${key} must be a declared required seam`).toBeDefined();
      expect(entry?.ownerModule).toBe(20);
      expect(entry?.denyStub).toBeDefined();
    }
  });

  // The deny-stubs throw SYNCHRONOUSLY rather than returning a rejected promise — a consumer that
  // forgot to await still cannot proceed on a fabricated value, which is the point.
  it("every deny-stub THROWS — an empty board is a real answer an outage must not be able to give", () => {
    validateSeams();
    expect(() =>
      getSeam("SafetyDashboardProvider").clinicianStatusForLocation(ORG, LOC_A, NOW),
    ).toThrow();
    expect(() =>
      getSeam("SafetySupervisorProvider").supervisorsForClinician(ORG, CLINICIAN, "sos"),
    ).toThrow();
    expect(() => getSeam("SafetyCheckInProvider").checkInStatusForVisit(ORG, VISIT)).toThrow();
    expect(() => getSeam("SafetyPolicyProvider").effectivePolicy(ORG)).toThrow();
    expect(() => getSeam("SafetyContextReader").activeIncidentForVisit(ORG, VISIT)).toThrow();
    expect(() => getSeam("SafetyMetricsProvider").getAfterHoursSosCount(ORG, PE, WINDOW)).toThrow();
    expect(() =>
      getSeam("SafetyIncidentReader").recentIncidentsForClinician(ORG, CLINICIAN, NOW),
    ).toThrow();
  });

  it("registers NOTHING without a store, so a DB-less boot cannot manufacture 'everyone is fine'", () => {
    registerFieldSafetySeams({});
    validateSeams();
    // Still the deny-stub, not an empty in-memory board.
    expect(() =>
      getSeam("SafetyDashboardProvider").clinicianStatusForSupervisor(ORG, SUPERVISOR, NOW),
    ).toThrow(/deny-stub/);
  });

  it("registers all seven real impls when a store IS supplied", async () => {
    registerFieldSafetySeams({ store: store(), orgOf, now });
    validateSeams();
    const policy = await getSeam("SafetyPolicyProvider").effectivePolicy(ORG);
    expect(policy.midVisitCadenceMinutes).toBe(SAFETY_POLICY_FLOOR.midVisitCadenceMinutes);
  });
});

describe("M20-T05 — the orgId argument is an ASSERTION, never a selector", () => {
  it("refuses a seam call whose org disagrees with the caller's scope", async () => {
    const provider = createSafetyPolicyProvider(store(), orgOf, now);
    // `ChartWardenError`'s message is not its code — assert on the CODE, which is the contract a caller
    // branches on (the platform-wide `expect().toThrowError(/CODE/)` false-green, M15-T07).
    await expect(provider.effectivePolicy(OTHER_ORG)).rejects.toMatchObject({
      code: "SAFETY_SEAM_ORG_MISMATCH",
      statusCode: 403,
    });
  });

  it("does not refuse outside a request scope — the store is what refuses there", async () => {
    const provider = createSafetyPolicyProvider(store(), () => "" as OrgId, now);
    await expect(provider.effectivePolicy(OTHER_ORG)).resolves.toBeDefined();
  });
});

describe("M20-T05 §2.2.4 — SafetyPolicyProvider", () => {
  const V1 = {
    versionId: "v1",
    effectiveFrom: "2026-01-01T00:00:00.000Z" as IsoInstant,
    effectiveTo: "2026-06-01T00:00:00.000Z" as IsoInstant,
    supervisorAlertMinutes: 15,
  };
  const V2 = {
    versionId: "v2",
    effectiveFrom: "2026-06-01T00:00:00.000Z" as IsoInstant,
    effectiveTo: null,
    supervisorAlertMinutes: 5,
  };

  it("answers the platform FLOOR for a tenant with no version row (M20-F03)", async () => {
    const policy = await createSafetyPolicyProvider(store(), orgOf, now).effectivePolicy(ORG);
    expect(policy.versionId).toBe("");
    expect(policy.supervisorAlertMinutes).toBe(SAFETY_POLICY_FLOOR.supervisorAlertMinutes);
  });

  it("REPLAYS the version in force at an instant, not today's (a 2026 incident reads 2026 rules)", async () => {
    const provider = createSafetyPolicyProvider(store({ policyVersions: [V1, V2] }), orgOf, now);
    const then = await provider.policyAtTime(ORG, "2026-03-01T00:00:00.000Z" as IsoInstant);
    const current = await provider.effectivePolicy(ORG);
    expect(then.versionId).toBe("v1");
    expect(then.supervisorAlertMinutes).toBe(15);
    expect(current.versionId).toBe("v2");
    expect(current.supervisorAlertMinutes).toBe(5);
  });

  it("merges the floor UNDER an absent knob rather than passing undefined through", async () => {
    const policy = await createSafetyPolicyProvider(
      store({ policyVersions: [V2] }),
      orgOf,
      now,
    ).effectivePolicy(ORG);
    expect(policy.sosTier1SlaSeconds).toBe(SAFETY_POLICY_FLOOR.sosTier1SlaSeconds);
    expect(Number.isNaN(policy.sosTier1SlaSeconds)).toBe(false);
  });
});

describe("M20-T05 §4.2 — SafetyDashboardProvider", () => {
  const IN_SCOPE = CLINICIAN;
  const OUT_OF_SCOPE = "6c666666-6666-4666-8666-666666666666" as MembershipId;

  const boardStore = () =>
    store({
      coverageSubjects: [
        {
          membershipId: IN_SCOPE,
          locationIds: [LOC_A],
          providerEntityId: PE,
          isFieldEligible: true,
          hasInactiveSubscriptions: false,
        },
        {
          membershipId: OUT_OF_SCOPE,
          locationIds: [LOC_B],
          providerEntityId: PE,
          isFieldEligible: true,
          hasInactiveSubscriptions: false,
        },
      ],
      boardFacts: [
        {
          membershipId: IN_SCOPE,
          displayName: "Patricia RN",
          lastCheckInAt: "2026-08-04T02:00:00.000Z" as IsoInstant,
          lastCheckInStatus: "ok",
          // Expected at 02:30, the policy floor's supervisor rung is 15 minutes, and "now" is 03:00.
          nextExpectedCheckInAt: "2026-08-04T02:30:00.000Z" as IsoInstant,
          nextExpectedWindowMinutes: 15,
          activeSosAlert: null,
        },
        {
          membershipId: OUT_OF_SCOPE,
          displayName: "Other RN",
          lastCheckInAt: null,
          lastCheckInStatus: null,
          nextExpectedCheckInAt: null,
          nextExpectedWindowMinutes: null,
          activeSosAlert: null,
        },
      ],
      subscriptions: [subscription()],
    });

  /** The three §4.4 reads the board enriches through. Registering them as throwing stubs is the
   *  realistic shape here — every one of them DEGRADES to a null cell rather than failing the board. */
  const registerDegradedUpstreams = () => {
    registerSeam("VisitAssignmentReader", {
      currentVisitForClinician: async () => null,
      activeVisitsForMembershipOnDate: async () => [],
      tonightsOnCallRoster: async () => [],
    } as never);
    registerSeam("EvvLocationProvider", {
      lastKnownLocationForClinician: async () => null,
      lastKnownLocationsForOrgShift: async () => [],
    } as never);
    registerSeam("PatientReader", { findById: async () => null } as never);
  };

  it("scopes the LOCATION board to the clinicians who work at that location", async () => {
    registerDegradedUpstreams();
    const provider = createSafetyDashboardProvider(boardStore(), orgOf);
    const snapshot = await provider.clinicianStatusForLocation(ORG, LOC_A, NOW);
    expect(snapshot.clinicians.map((c) => c.membershipId)).toEqual([IN_SCOPE]);
    expect(snapshot.fetchedAt).toBe(NOW);
  });

  it("scopes the SUPERVISOR board to her PAGING set, not to whatever RBAC lets her see", async () => {
    registerDegradedUpstreams();
    const provider = createSafetyDashboardProvider(boardStore(), orgOf);
    const snapshot = await provider.clinicianStatusForSupervisor(ORG, SUPERVISOR, NOW);
    // The one `explicit` subscription names CLINICIAN and nobody else.
    expect(snapshot.clinicians.map((c) => c.membershipId)).toEqual([IN_SCOPE]);
  });

  it("derives the D4 overdue badge from the policy, and counts the tiles over the SAME snapshot", async () => {
    registerDegradedUpstreams();
    const provider = createSafetyDashboardProvider(boardStore(), orgOf);
    const snapshot = await provider.clinicianStatusForLocation(ORG, LOC_A, NOW);
    // 30 minutes past `expected_at` is past the floor's 15-minute supervisor rung.
    expect(snapshot.clinicians[0]?.overdueState).toBe("escalated");
    expect(snapshot.overdueCount).toBe(1);
    expect(snapshot.activeSosCount).toBe(0);
  });

  it("leaves `inHighRiskArea` NULL — D12 has no address source and a fabricated advisory would lie", async () => {
    registerDegradedUpstreams();
    const provider = createSafetyDashboardProvider(boardStore(), orgOf);
    const snapshot = await provider.clinicianStatusForLocation(ORG, LOC_A, NOW);
    expect(snapshot.clinicians[0]?.inHighRiskArea).toBeNull();
  });

  it("carries NO coordinates onto the board even when M18 answers with them", async () => {
    registerSeam("VisitAssignmentReader", {
      currentVisitForClinician: async () => null,
      activeVisitsForMembershipOnDate: async () => [],
      tonightsOnCallRoster: async () => [],
    } as never);
    registerSeam("EvvLocationProvider", {
      lastKnownLocationForClinician: async () => null,
      lastKnownLocationsForOrgShift: async () => [
        {
          membershipId: IN_SCOPE,
          eventId: "e-1",
          visitId: VISIT,
          lat: 45.5,
          lng: -122.6,
          accuracyM: 10,
          capturedAt: "2026-08-04T02:40:00.000Z",
        },
      ],
    } as never);
    registerSeam("PatientReader", { findById: async () => null } as never);

    const provider = createSafetyDashboardProvider(boardStore(), orgOf);
    const snapshot = await provider.clinicianStatusForLocation(ORG, LOC_A, NOW);
    const location = snapshot.clinicians[0]?.lastKnownLocation;
    expect(location?.ageMinutes).toBe(20);
    expect(JSON.stringify(location)).not.toContain("45.5");
  });

  it("PROPAGATES an M20-side store failure — an unreadable board must not render as an empty one", async () => {
    registerDegradedUpstreams();
    const broken = {
      ...boardStore(),
      coverageSubjects: async () => {
        throw new Error("connection reset");
      },
    };
    const provider = createSafetyDashboardProvider(broken, orgOf);
    await expect(provider.clinicianStatusForLocation(ORG, LOC_A, NOW)).rejects.toThrow(
      /connection reset/,
    );
  });
});

describe("M20-T05 §4.3 / §7.8 — SafetySupervisorProvider", () => {
  const subject = {
    membershipId: CLINICIAN,
    locationIds: [LOC_A],
    providerEntityId: PE,
    isFieldEligible: true,
    hasInactiveSubscriptions: false,
  };

  it("scopes on the requested ALERT KIND, not on 'sos' alone", async () => {
    const provider = createSafetySupervisorProvider(
      store({
        coverageSubjects: [subject],
        subscriptions: [subscription({ alertKinds: ["incident"] })],
      }),
      orgOf,
      now,
    );
    expect(await provider.supervisorsForClinician(ORG, CLINICIAN, "incident")).toHaveLength(1);
    // The same row does NOT page on sos, and reporting it would be a recipient who never rings.
    expect(await provider.supervisorsForClinician(ORG, CLINICIAN, "sos")).toHaveLength(0);
  });

  it("resolves the org-wide `role` layer for a clinician on the roster", async () => {
    const provider = createSafetySupervisorProvider(
      store({
        coverageSubjects: [subject],
        subscriptions: [
          subscription({
            scopeKind: "role",
            clinicianMembershipId: null,
            supervisorMembershipId: BACKUP_SUP,
          }),
        ],
      }),
      orgOf,
      now,
    );
    const out = await provider.supervisorsForClinician(ORG, CLINICIAN, "sos");
    expect(out.map((r) => r.supervisorMembershipId)).toEqual([BACKUP_SUP]);
    expect(out[0]?.scopeKind).toBe("role");
  });

  it("de-duplicates one supervisor to her MOST SPECIFIC scope, so a coverage review reads the real reason", () => {
    const out = supervisorRecipientsFrom([
      {
        supervisorMembershipId: SUPERVISOR,
        scopeKind: "role",
        isVacationForwarding: false,
        vacationForwardToMembershipId: null,
      },
      {
        supervisorMembershipId: SUPERVISOR,
        scopeKind: "explicit",
        isVacationForwarding: false,
        vacationForwardToMembershipId: null,
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.scopeKind).toBe("explicit");
  });

  it("reports `no_subscription` vs `all_subscriptions_deactivated` vs `vacation_forwards_unresolved`", async () => {
    const uncovered = { ...subject, membershipId: "aaaa" as MembershipId };
    const lapsed = { ...subject, membershipId: "bbbb" as MembershipId };
    const forwarded = { ...subject, membershipId: CLINICIAN };

    const provider = createSafetySupervisorProvider(
      store({
        coverageSubjects: [uncovered, lapsed, forwarded],
        membershipsWithInactiveSubscriptions: [lapsed.membershipId],
        subscriptions: [
          subscription({
            isVacationForwarding: true,
            vacationForwardToMembershipId: BACKUP_SUP,
          }),
        ],
        // BACKUP_SUP is NOT active — the forward lands nowhere. SUPERVISOR is, which is exactly the case
        // a set built from forward targets alone would have got wrong.
        activeMemberships: [SUPERVISOR],
      }),
      orgOf,
      now,
    );

    const gaps = await provider.coverageGapsForOrg(ORG, NOW);
    const byMembership = new Map(gaps.map((g) => [g.clinicianMembershipId, g.reason]));
    expect(byMembership.get(uncovered.membershipId)).toBe("no_subscription");
    expect(byMembership.get(lapsed.membershipId)).toBe("all_subscriptions_deactivated");
    expect(byMembership.get(CLINICIAN)).toBe("vacation_forwards_unresolved");
  });

  it("reports NO gap when a non-forwarding subscriber is an active supervisor", async () => {
    const provider = createSafetySupervisorProvider(
      store({
        coverageSubjects: [subject],
        subscriptions: [subscription()],
        activeMemberships: [SUPERVISOR],
      }),
      orgOf,
      now,
    );
    expect(await provider.coverageGapsForOrg(ORG, NOW)).toEqual([]);
  });
});

describe("M20-T05 §4.3 — SafetyCheckInProvider badge trio", () => {
  it("reports the WORST outstanding mid-visit prompt, not the newest", async () => {
    const provider = createSafetyCheckInProvider(
      store({
        visitSchedules: new Map([
          [
            VISIT,
            [
              { kind: "pre_visit", expectedAt: NOW, windowMinutes: 15, state: "recorded" },
              { kind: "mid_visit", expectedAt: NOW, windowMinutes: 15, state: "recorded" },
              { kind: "mid_visit", expectedAt: NOW, windowMinutes: 15, state: "overdue" },
            ],
          ],
        ]),
      }),
      orgOf,
    );
    expect(await provider.checkInStatusForVisit(ORG, VISIT)).toEqual({
      preVisit: "recorded",
      midVisit: "overdue",
      // No `post_visit` obligation exists — that is `not_required`, which is the truth for a visit whose
      // cadence never materialized one.
      postVisit: "not_required",
    });
  });

  it("collapses `escalated` into `overdue` — the rung is the supervisor board's business", () => {
    expect(
      visitCheckInBadges([
        { kind: "pre_visit", expectedAt: NOW, windowMinutes: 5, state: "escalated" },
      ]).preVisit,
    ).toBe("overdue");
  });

  it("maps `superseded` to `not_required` — a corrected-away obligation is one nobody owes", () => {
    expect(
      visitCheckInBadges([
        { kind: "post_visit", expectedAt: NOW, windowMinutes: 5, state: "superseded" },
      ]).postVisit,
    ).toBe("not_required");
  });
});

describe("M20-T05 §4.3 — SafetyContextReader", () => {
  const incident = {
    incidentId: "inc-1",
    category: "verbal_assault" as const,
    severity: "moderate" as const,
    lifecycleState: "under_review",
    occurredAt: "2026-08-04T02:00:00.000Z" as IsoInstant,
    affectedClinicianMembershipId: CLINICIAN,
    visitId: VISIT,
    linkedSosAlertId: null,
    oshaReportable: false,
  };

  it("surfaces an OPEN incident for the visit M8 is documenting", async () => {
    const reader = createSafetyContextReader(store({ incidents: [incident] }), orgOf);
    expect((await reader.activeIncidentForVisit(ORG, VISIT))?.incidentId).toBe("inc-1");
  });

  it("does not surface a CLOSED one", async () => {
    const reader = createSafetyContextReader(
      store({ incidents: [{ ...incident, lifecycleState: "closed_no_action" }] }),
      orgOf,
    );
    expect(await reader.activeIncidentForVisit(ORG, VISIT)).toBeNull();
  });

  it("lists the clinician's incidents for a date", async () => {
    const reader = createSafetyContextReader(store({ incidents: [incident] }), orgOf);
    expect(
      await reader.activeIncidentsForClinicianToday(ORG, CLINICIAN, "2026-08-04"),
    ).toHaveLength(1);
    expect(
      await reader.activeIncidentsForClinicianToday(ORG, CLINICIAN, "2026-08-05"),
    ).toHaveLength(0);
  });
});

describe("M20-T05 §8.6 — SafetyIncidentReader", () => {
  const geo = {
    incidentId: "inc-1",
    category: "animal_other" as const,
    severity: "minor" as const,
    occurredAt: "2026-08-04T02:00:00.000Z" as IsoInstant,
    linkedSosCoordinatesCipher: new Uint8Array([1, 2, 3]),
    affectedClinicianMembershipId: CLINICIAN,
  };
  const decipher = async () => ({ lat: 45.512345, lng: -122.678901 });

  it("REFUSES without a DEK decipher rather than reporting every incident as having no geography", async () => {
    const reader = createSafetyIncidentReader(store({ incidentGeo: [geo] }), orgOf);
    await expect(
      reader.recentIncidentsForClinician(ORG, CLINICIAN, "2026-08-01T00:00:00.000Z" as IsoInstant),
    ).rejects.toMatchObject({ code: "SAFETY_COORDINATE_DECIPHER_UNBOUND" });
  });

  it("rounds to three decimals (~110 m), symmetrically", () => {
    expect(roundCoordinates(45.512345, -122.678901)).toEqual({
      latitude3: 45.512,
      longitude3: -122.679,
    });
  });

  it("projects an SOS-linked incident with coordinates and a freestanding one without", async () => {
    const reader = createSafetyIncidentReader(
      store({
        incidentGeo: [geo, { ...geo, incidentId: "inc-2", linkedSosCoordinatesCipher: null }],
      }),
      orgOf,
      decipher,
    );
    const out = await reader.recentIncidentsForClinician(
      ORG,
      CLINICIAN,
      "2026-08-01T00:00:00.000Z" as IsoInstant,
    );
    expect(out.find((i) => i.incidentId === "inc-1")?.roundedCoordinates).toEqual({
      latitude3: 45.512,
      longitude3: -122.679,
    });
    expect(out.find((i) => i.incidentId === "inc-2")?.roundedCoordinates).toBeNull();
  });

  it("drops the geography-less incident from an AREA query instead of defaulting it inside", async () => {
    const reader = createSafetyIncidentReader(
      store({
        incidentGeo: [geo, { ...geo, incidentId: "inc-2", linkedSosCoordinatesCipher: null }],
      }),
      orgOf,
      decipher,
    );
    const box: readonly (readonly (readonly [number, number])[])[] = [
      [
        [-123, 45],
        [-122, 45],
        [-122, 46],
        [-123, 46],
        [-123, 45],
      ],
    ];
    const out = await reader.recentIncidentsForArea(
      ORG,
      box,
      "2026-08-01T00:00:00.000Z" as IsoInstant,
    );
    expect(out.map((i) => i.incidentId)).toEqual(["inc-1"]);
  });

  it("ray-casts holes correctly — a point inside outer AND hole is OUTSIDE", () => {
    const donut: readonly (readonly (readonly [number, number])[])[] = [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
      [
        [4, 4],
        [6, 4],
        [6, 6],
        [4, 6],
        [4, 4],
      ],
    ];
    expect(pointInPolygon(donut, { latitude3: 1, longitude3: 1 })).toBe(true);
    expect(pointInPolygon(donut, { latitude3: 5, longitude3: 5 })).toBe(false);
    expect(pointInPolygon(donut, { latitude3: 20, longitude3: 20 })).toBe(false);
  });
});

describe("M20-T05 §4.3 — SafetyMetricsProvider", () => {
  it("ships every rate WITH its denominator", async () => {
    const provider = createSafetyMetricsProvider(
      store({
        metrics: {
          sosCount: 3,
          incidentCount: 2,
          observedVisitCount: 200,
          overdueCounts: { numerator: 4, denominator: 40 },
          checkInComplianceCounts: { numerator: 36, denominator: 40 },
          sosResponseSeconds: [10, 20, 30, 400],
        },
      }),
      orgOf,
      () => "UTC",
    );
    expect(await provider.getSosFrequency(ORG, PE, WINDOW)).toEqual({
      count: 3,
      perHundredVisits: 1.5,
      visitCount: 200,
    });
    expect(await provider.getOverdueRate(ORG, PE, WINDOW)).toEqual({ rate: 0.1, sampleSize: 40 });
    expect(await provider.getCheckInComplianceRate(ORG, PE, WINDOW)).toEqual({
      rate: 0.9,
      sampleSize: 40,
    });
    expect(await provider.getIncidentRate(ORG, PE, WINDOW)).toEqual({
      rate: 0.01,
      perHundredVisits: 1,
      visitCount: 200,
    });
  });

  it("reports 0 over an empty denominator, and says the denominator was empty", async () => {
    const provider = createSafetyMetricsProvider(store(), orgOf, () => "UTC");
    expect(await provider.getSosFrequency(ORG, PE, WINDOW)).toEqual({
      count: 0,
      perHundredVisits: 0,
      visitCount: 0,
    });
    expect(perHundredVisits(0, 0)).toBe(0);
  });

  it("uses nearest-rank percentiles — an observed latency, never an interpolated one", async () => {
    const provider = createSafetyMetricsProvider(
      store({ metrics: { sosResponseSeconds: [10, 20, 30, 400] } }),
      orgOf,
      () => "UTC",
    );
    const out = await provider.getResponseTimeMedian(ORG, PE, WINDOW);
    expect(out.sampleSize).toBe(4);
    expect([10, 20, 30, 400]).toContain(out.medianSeconds);
    expect(out.p95Seconds).toBe(400);
    expect(percentileOf([], 95)).toBe(0);
  });

  it("REFUSES the after-hours count with no org time zone bound", async () => {
    const provider = createSafetyMetricsProvider(store(), orgOf);
    await expect(provider.getAfterHoursSosCount(ORG, PE, WINDOW)).rejects.toMatchObject({
      code: "SAFETY_SEAM_ORG_TIME_ZONE_UNRESOLVED",
    });
  });

  it("judges each press against the window ITS OWN policy version pinned, in the org's zone", async () => {
    const provider = createSafetyMetricsProvider(
      store({
        metrics: {
          afterHoursSosSamples: [
            // 22:30 America/Los_Angeles (05:30Z next day) against an 18→08 window: after hours.
            {
              postedAt: "2026-08-05T05:30:00.000Z" as IsoInstant,
              afterHoursStartHour: 18,
              afterHoursEndHour: 8,
            },
            // 11:00 America/Los_Angeles (18:00Z) against the same window: business hours.
            {
              postedAt: "2026-08-04T18:00:00.000Z" as IsoInstant,
              afterHoursStartHour: 18,
              afterHoursEndHour: 8,
            },
            // The SAME 11:00 local instant against a version that ran a 20→10 window is still business
            // hours; against a 24-hour posture (start === end) it would not be. This is the row that
            // proves the count reads the ALERT's version and not today's.
            {
              postedAt: "2026-08-04T18:00:00.000Z" as IsoInstant,
              afterHoursStartHour: 9,
              afterHoursEndHour: 9,
            },
          ],
        },
      }),
      orgOf,
      () => "America/Los_Angeles",
    );
    expect(await provider.getAfterHoursSosCount(ORG, PE, WINDOW)).toEqual({ count: 2 });
  });
});

describe("M20-T05 M20-F06 — the emergency-contact row", () => {
  const contact = {
    consentId: "c-1",
    clinicianMembershipId: CLINICIAN,
    consentPurpose: "emergency_contact_call" as const,
    grantedAt: "2026-01-01T00:00:00.000Z" as IsoInstant,
    expiresAt: null,
    consentScopeDetail: { contact: "<cipher>" },
  };

  it("answers `granted` and hands the scope detail up UNOPENED", async () => {
    const read = await readEmergencyContact(store({ emergencyContacts: [contact] }), {
      orgId: ORG,
      clinicianMembershipId: CLINICIAN,
      atIso: NOW,
    });
    expect(read.kind).toBe("granted");
    expect(read.kind === "granted" && read.consentScopeDetail).toEqual({ contact: "<cipher>" });
    expect(emergencyContactConsentPresent(read)).toBe(true);
  });

  it("answers `absent` for a clinician who declined — declining does NOT disable SOS (M20-F16)", async () => {
    const read = await readEmergencyContact(store(), {
      orgId: ORG,
      clinicianMembershipId: CLINICIAN,
      atIso: NOW,
    });
    expect(read.kind).toBe("absent");
    expect(emergencyContactConsentPresent(read)).toBe(false);
  });

  it("answers `unavailable` on a store failure — NOT `absent`, which would write a false statement", async () => {
    const broken = {
      ...store(),
      emergencyContactConsent: async () => {
        throw new Error("connection reset");
      },
    };
    const read = await readEmergencyContact(broken, {
      orgId: ORG,
      clinicianMembershipId: CLINICIAN,
      atIso: NOW,
    });
    expect(read.kind).toBe("unavailable");
    // Both map to "do not dial", and only one of them is a fact about the clinician's own choice.
    expect(emergencyContactConsentPresent(read)).toBe(false);
  });

  it("treats an EXPIRED consent as no permission to dial", async () => {
    const read = await readEmergencyContact(
      store({
        emergencyContacts: [{ ...contact, expiresAt: "2026-02-01T00:00:00.000Z" as IsoInstant }],
      }),
      { orgId: ORG, clinicianMembershipId: CLINICIAN, atIso: NOW },
    );
    expect(read.kind).toBe("absent");
  });

  it("replays the consent that was live at an EARLIER instant (§2.7 BCP re-entry)", async () => {
    const st = store({
      emergencyContacts: [{ ...contact, expiresAt: "2026-02-01T00:00:00.000Z" as IsoInstant }],
    });
    const then = await readEmergencyContact(st, {
      orgId: ORG,
      clinicianMembershipId: CLINICIAN,
      atIso: "2026-01-15T00:00:00.000Z" as IsoInstant,
    });
    expect(then.kind).toBe("granted");
  });
});

describe("M20-T05 §4.5 — the `field_safety_composed` recipient resolver", () => {
  const gaps: SafetyComposedGap[] = [];
  const ports = (over: Partial<M20AlertResolverPorts> = {}): M20AlertResolverPorts => ({
    async supervisorsForClinician() {
      return [
        {
          supervisorMembershipId: SUPERVISOR,
          isVacationForwarded: false,
          vacationForwardToMembershipId: null,
        },
      ];
    },
    async afterHoursParallelSet() {
      return {
        kind: "resolved",
        recipients: [
          {
            membershipId: "rn-patricia",
            userId: "user-patricia",
            scope: "on_call_parallel",
            shiftId: "shift-1",
            discipline: "rn",
            isBackup: false,
          },
        ],
        externalActors: [],
      };
    },
    async userIdsForMemberships(_orgId, ids) {
      return new Map(ids.map((id) => [id, `user-${id}`]));
    },
    onCompositionGap(_orgId, gap) {
      gaps.push(gap);
    },
    ...over,
  });

  const registryWith = (p: M20AlertResolverPorts): Map<string, RecipientResolverFn> =>
    registerM20AlertResolvers(new Map<string, RecipientResolverFn>(), p);

  const PAYLOAD = {
    postedByMembershipId: CLINICIAN,
    providerEntityId: PE,
    raisedAt: NOW,
  } as Record<string, unknown>;

  afterEach(() => {
    gaps.length = 0;
  });

  it("returns USER ids — M36 delivers to users, M20's rows name memberships", async () => {
    const out = await resolveRecipients(
      registryWith(ports()),
      M20_COMPOSED_RECIPIENT_RESOLVER,
      ORG,
      {},
      PAYLOAD,
    );
    expect(out).toEqual([`user-${SUPERVISOR}`, "user-patricia"]);
  });

  it("orders supervisors BEFORE the on-call parallel set (§4.5's primary/combined split)", async () => {
    const out = await resolveRecipients(
      registryWith(ports()),
      M20_COMPOSED_RECIPIENT_RESOLVER,
      ORG,
      {},
      PAYLOAD,
    );
    expect(out[0]).toBe(`user-${SUPERVISOR}`);
  });

  it("delivers to the vacation-forward TARGET, never the supervisor on a plane", () => {
    expect(
      deliveryMembershipsFor([
        {
          supervisorMembershipId: SUPERVISOR,
          isVacationForwarded: true,
          vacationForwardToMembershipId: BACKUP_SUP,
        },
      ]),
    ).toEqual([BACKUP_SUP]);
  });

  it("drops a forwarding row with no target rather than silently repairing it", () => {
    expect(
      deliveryMembershipsFor([
        {
          supervisorMembershipId: SUPERVISOR,
          isVacationForwarded: true,
          vacationForwardToMembershipId: null,
        },
      ]),
    ).toEqual([]);
  });

  it("reports `on_call_unavailable` and still pages the supervisors", async () => {
    const out = await resolveRecipients(
      registryWith(
        ports({
          async afterHoursParallelSet() {
            return { kind: "unavailable", reason: "OnCallProvider read failed" };
          },
        }),
      ),
      M20_COMPOSED_RECIPIENT_RESOLVER,
      ORG,
      {},
      PAYLOAD,
    );
    expect(out).toEqual([`user-${SUPERVISOR}`]);
    expect(gaps).toContainEqual({
      kind: "on_call_unavailable",
      reason: "OnCallProvider read failed",
    });
  });

  it("reports a vendor-covered night as `external_actors_unreachable`, not as an uncovered one", async () => {
    await resolveRecipients(
      registryWith(
        ports({
          async afterHoursParallelSet() {
            return {
              kind: "resolved",
              recipients: [],
              externalActors: [
                { shiftId: "shift-9", externalActorId: "vendor-1", externalActorLabel: null },
              ],
            };
          },
        }),
      ),
      M20_COMPOSED_RECIPIENT_RESOLVER,
      ORG,
      {},
      PAYLOAD,
    );
    expect(gaps).toContainEqual({ kind: "external_actors_unreachable", shiftIds: ["shift-9"] });
  });

  it("reports `no_recipients` when the composed set is empty — the §7.8 gap M36 would fan out to nobody", async () => {
    const out = await resolveRecipients(
      registryWith(
        ports({
          async supervisorsForClinician() {
            return [];
          },
          async afterHoursParallelSet() {
            return { kind: "not_after_hours" };
          },
        }),
      ),
      M20_COMPOSED_RECIPIENT_RESOLVER,
      ORG,
      {},
      PAYLOAD,
    );
    expect(out).toEqual([]);
    expect(gaps).toContainEqual({ kind: "no_recipients" });
  });

  it("DROPS a membership whose user will not resolve, and says so", async () => {
    const out = await resolveRecipients(
      registryWith(
        ports({
          async userIdsForMemberships() {
            return new Map();
          },
          async afterHoursParallelSet() {
            return { kind: "not_after_hours" };
          },
        }),
      ),
      M20_COMPOSED_RECIPIENT_RESOLVER,
      ORG,
      {},
      PAYLOAD,
    );
    expect(out).toEqual([]);
    expect(gaps).toContainEqual({
      kind: "unresolvable_memberships",
      membershipIds: [SUPERVISOR],
    });
  });

  it("PROPAGATES an unreadable supervisor registry — never `[]`, which M36 cannot tell from a real gap", async () => {
    await expect(
      resolveRecipients(
        registryWith(
          ports({
            async supervisorsForClinician() {
              throw new Error("SafetySupervisorProvider: Phase-0 deny-stub");
            },
          }),
        ),
        M20_COMPOSED_RECIPIENT_RESOLVER,
        ORG,
        {},
        PAYLOAD,
      ),
    ).rejects.toThrow(/deny-stub/);
  });

  it("does not consult M19 outside the after-hours window (§7.4)", async () => {
    let consulted = false;
    const out = await resolveRecipients(
      registryWith(
        ports({
          async afterHoursParallelSet() {
            consulted = true;
            return { kind: "not_after_hours" };
          },
        }),
      ),
      M20_COMPOSED_RECIPIENT_RESOLVER,
      ORG,
      {},
      PAYLOAD,
    );
    // The read runs — it is what DECIDES whether the window applies — but it contributes nobody.
    expect(consulted).toBe(true);
    expect(out).toEqual([`user-${SUPERVISOR}`]);
  });
});
