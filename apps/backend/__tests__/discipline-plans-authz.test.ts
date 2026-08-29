// apps/backend/__tests__/discipline-plans-authz.test.ts — M15-T06 (§4.4 permission keys · §4.5 ABAC
// predicates · §7.8/§7.9 the M39 SUD + family-violence disclosure gates).
//
// The properties this file exists to hold — each one is a way the surface could quietly become fail-OPEN:
//   • every §4.4 key is single-owner in the platform mirror, and the three `*_internal` seam keys are
//     platform-category (never a clinical grant);
//   • `aide_supervisor_eligible` admits the plan's NAMED supervising RN and the location-scoped Clinical
//     Supervisor override — and denies an unnamed RN, a supervisor at another location, and an absent plan;
//   • `volunteer_compliance_active` denies on an UNREADABLE gate store (§8.7 — the M15-F11 headline: the
//     gate never assumes compliance);
//   • `family_violence_disclosure_allowed` denies a portal/collaborator session whatever its roles, denies
//     a role outside the §4.5 caseload default, and REDACTS when M39 errors (never discloses);
//   • the §7.8 disclosure gate reports the exact `redacted_categories` the response envelope carries, the
//     RN-Case-Manager Part-2 fast path needs no consent round-trip, and an M39 outage redacts;
//   • the §4.6.1 cursor envelope is `{data, next_cursor, has_more}` and `?offset=` is refused.
import {
  M15_CONTRIBUTED_PERMISSIONS,
  allPermissionMirrorRows,
  resetAbacRegistry,
} from "@wardenx/auth";
import type { AbacContext } from "@wardenx/auth";
import type { IsoInstant } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  type DisciplinePlanAbacResolver,
  M15_ABAC_PREDICATES,
  M15_INTERNAL_PERMISSION_KEYS,
  M15_PERMISSION_KEY_LIST,
  buildDisciplinePlanAbacPredicates,
  denyStubDisciplinePlanAbacResolver,
} from "../src/modules/15-discipline-care-plans/index";
import type { M15ReadActor } from "../src/modules/15-discipline-care-plans/routes/actor";
import {
  M15_PAGE_SIZES,
  clampLimit,
  decodeCursor,
  encodeCursor,
  toCursorPage,
} from "../src/modules/15-discipline-care-plans/routes/concurrency";
import {
  type DisclosurePort,
  SUMMARY_DISCLOSURE,
  resolveDisclosure,
} from "../src/modules/15-discipline-care-plans/routes/disclosure";
import type { VolunteerGateFacts } from "../src/modules/15-discipline-care-plans/volunteer/index";

const NOW = "2026-07-30T12:00:00.000Z" as IsoInstant;
const ORG = "11111111-1111-4111-8111-111111111111";
const PLAN = "22222222-2222-4222-8222-222222222222";
const PATIENT = "33333333-3333-4333-8333-333333333333";
const RN_MEMBERSHIP = "44444444-4444-4444-8444-444444444444";
const OTHER_MEMBERSHIP = "55555555-5555-4555-8555-555555555555";
const LOCATION = "66666666-6666-4666-8666-666666666666";
const VOLUNTEER = "77777777-7777-4777-8777-777777777777";

function ctx(overrides: Partial<AbacContext> = {}): AbacContext {
  return {
    organizationId: ORG,
    userId: "user-1",
    roles: [],
    providerEntityIds: [],
    locationIds: [],
    attributes: {},
    ...overrides,
  };
}

const planResolver = (
  gates: readonly VolunteerGateFacts[] | null = [],
): DisciplinePlanAbacResolver => ({
  async loadPlanScope(orgId, planId) {
    if (orgId !== ORG || planId !== PLAN) return null;
    return {
      organizationId: ORG,
      patientId: PATIENT,
      locationId: LOCATION,
      supervisingRnMembershipId: RN_MEMBERSHIP as never,
      aideMembershipId: OTHER_MEMBERSHIP as never,
    };
  },
  async loadVolunteerGates() {
    return gates;
  },
});

const clearingGate = (kind: string): VolunteerGateFacts => ({
  gateId: `gate-${kind}`,
  volunteerMembershipId: VOLUNTEER as never,
  gateKind: kind as never,
  status: "satisfied",
  validFrom: "2026-01-01T00:00:00.000Z" as IsoInstant,
  validUntil: "2027-01-01T00:00:00.000Z" as IsoInstant,
  revokedAt: null,
});

describe("M15-T06 §4.4 permission keys", () => {
  it("registers twenty keys, single-owner across the platform mirror", () => {
    expect(M15_PERMISSION_KEY_LIST).toHaveLength(20);
    const rows = allPermissionMirrorRows();
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of M15_PERMISSION_KEY_LIST) expect(keys).toContain(key);
  });

  it("keeps the three seam keys platform-category — never a clinical grant (§4.1 system principal)", () => {
    for (const key of M15_INTERNAL_PERMISSION_KEYS) {
      expect(M15_CONTRIBUTED_PERMISSIONS[key].category).toBe("platform");
      expect(key.endsWith("_internal")).toBe(true);
    }
  });
});

describe("M15-T06 §4.5 ABAC — aide_supervisor_eligible (§8.6 spoofing control)", () => {
  const predicates = buildDisciplinePlanAbacPredicates({
    resolver: planResolver(),
    now: () => NOW,
  });

  it("admits the plan's NAMED supervising RN", async () => {
    const allowed = await predicates.aide_supervisor_eligible!(
      ctx({ attributes: { membershipId: RN_MEMBERSHIP } }),
      { planId: PLAN },
    );
    expect(allowed).toBe(true);
  });

  it("denies an RN who is not the one named on the plan", async () => {
    const allowed = await predicates.aide_supervisor_eligible!(
      ctx({ roles: ["rn"], attributes: { membershipId: OTHER_MEMBERSHIP } }),
      { planId: PLAN },
    );
    expect(allowed).toBe(false);
  });

  it("admits the §6 Clinical Supervisor override only at the plan's own location", async () => {
    const inScope = await predicates.aide_supervisor_eligible!(
      ctx({ roles: ["clinical_supervisor"], locationIds: [LOCATION] }),
      { planId: PLAN },
    );
    const elsewhere = await predicates.aide_supervisor_eligible!(
      ctx({ roles: ["clinical_supervisor"], locationIds: ["other-location"] }),
      { planId: PLAN },
    );
    expect([inScope, elsewhere]).toEqual([true, false]);
  });

  it("denies when no plan is named, and when the plan is absent / cross-tenant", async () => {
    const noTarget = await predicates.aide_supervisor_eligible!(
      ctx({ attributes: { membershipId: RN_MEMBERSHIP } }),
      {},
    );
    const absent = await predicates.aide_supervisor_eligible!(
      ctx({ attributes: { membershipId: RN_MEMBERSHIP } }),
      { planId: "unknown-plan" },
    );
    expect([noTarget, absent]).toEqual([false, false]);
  });
});

describe("M15-T06 §4.5 ABAC — volunteer_compliance_active (§8.7 fail-CLOSED)", () => {
  it("DENIES when the gate store is unreadable — it never assumes compliance", async () => {
    const predicates = buildDisciplinePlanAbacPredicates({
      resolver: denyStubDisciplinePlanAbacResolver, // loadVolunteerGates → null
      now: () => NOW,
    });
    const allowed = await predicates.volunteer_compliance_active!(ctx(), {
      volunteerMembershipId: VOLUNTEER,
    });
    expect(allowed).toBe(false);
  });

  it("denies a volunteer with an incomplete 418.78 gate set", async () => {
    const predicates = buildDisciplinePlanAbacPredicates({
      resolver: planResolver([clearingGate("tb_screening")]),
      now: () => NOW,
    });
    const allowed = await predicates.volunteer_compliance_active!(ctx(), {
      volunteerMembershipId: VOLUNTEER,
    });
    expect(allowed).toBe(false);
  });
});

describe("M15-T06 §4.5 ABAC — family_violence_disclosure_allowed (D9 / §7.9)", () => {
  const build = (redacted: boolean | "throw") =>
    buildDisciplinePlanAbacPredicates({
      resolver: planResolver(),
      now: () => NOW,
      familyViolenceRedacted: async () => {
        if (redacted === "throw") throw new Error("M39 unavailable");
        return redacted;
      },
    });

  it("admits the §4.5 caseload default (MSW / RN Case Manager)", async () => {
    const allowed = await build(false).family_violence_disclosure_allowed!(
      ctx({ roles: ["msw"] }),
      { planId: PLAN },
    );
    expect(allowed).toBe(true);
  });

  it("denies a role outside the default, and any portal/collaborator session", async () => {
    const wrongRole = await build(false).family_violence_disclosure_allowed!(
      ctx({ roles: ["chha"] }),
      { planId: PLAN },
    );
    const portal = await build(false).family_violence_disclosure_allowed!(
      ctx({ roles: ["msw"], attributes: { sessionClass: "caregiver_portal" } }),
      { planId: PLAN },
    );
    expect([wrongRole, portal]).toEqual([false, false]);
  });

  it("lets M39 NARROW the default, and REDACTS when M39 throws (never discloses)", async () => {
    const narrowed = await build(true).family_violence_disclosure_allowed!(
      ctx({ roles: ["msw"] }),
      { planId: PLAN },
    );
    const outage = await build("throw").family_violence_disclosure_allowed!(
      ctx({ roles: ["msw"] }),
      { planId: PLAN },
    );
    expect([narrowed, outage]).toEqual([false, false]);
  });
});

describe("M15-T06 §4.5 ABAC — registration surface", () => {
  it("names exactly the four predicates M15 owns", () => {
    expect([...M15_ABAC_PREDICATES]).toEqual([
      "aide_supervisor_eligible",
      "volunteer_compliance_active",
      "family_violence_disclosure_allowed",
      "volunteer_coordinator_role",
    ]);
    const built = buildDisciplinePlanAbacPredicates({
      resolver: denyStubDisciplinePlanAbacResolver,
    });
    expect(Object.keys(built).sort()).toEqual([...M15_ABAC_PREDICATES].sort());
    resetAbacRegistry();
  });

  it("volunteer_coordinator_role reads the caller's role set alone (no subject to resolve)", async () => {
    const predicates = buildDisciplinePlanAbacPredicates({
      resolver: denyStubDisciplinePlanAbacResolver,
    });
    const coordinator = await predicates.volunteer_coordinator_role!(
      ctx({ roles: ["volunteer_coordinator"] }),
      {},
    );
    const other = await predicates.volunteer_coordinator_role!(ctx({ roles: ["msw"] }), {});
    expect([coordinator, other]).toEqual([true, false]);
  });
});

describe("M15-T06 §7.8/§7.9 disclosure gate", () => {
  const actor = (overrides: Partial<M15ReadActor> = {}): M15ReadActor => ({
    organizationId: ORG,
    userId: "user-1",
    membershipId: RN_MEMBERSHIP,
    roles: [],
    sessionClass: "staff",
    locationIds: [LOCATION],
    ...overrides,
  });

  const port = (opts: {
    part2?: boolean | "throw";
    /** M39 says the patient's release names workforce members and this actor is not one of them. */
    part2RestrictedToOthers?: boolean;
    fvRedacted?: boolean | "throw";
    onPart2?: (membershipId: string | null) => void;
  }): DisclosurePort => ({
    async part2ReleaseActive(input) {
      opts.onPart2?.(input.membershipId);
      if (opts.part2 === "throw") throw new Error("M39 unavailable");
      return {
        allowed: opts.part2 === true,
        restrictedToNamedWorkforce: opts.part2RestrictedToOthers === true,
      };
    },
    async familyViolenceRedacted() {
      if (opts.fvRedacted === "throw") throw new Error("M39 unavailable");
      return opts.fvRedacted === true;
    },
  });

  it("reports BOTH categories redacted for a consulting clinician with no consent (§7.8)", async () => {
    const decision = await resolveDisclosure(
      actor({ roles: ["pt"] }),
      PATIENT,
      port({ part2: false, fvRedacted: false }),
    );
    expect(decision.sudAllowed).toBe(false);
    expect(decision.familyViolenceAllowed).toBe(false);
    expect([...decision.redactedCategories]).toEqual(["sud", "family_violence"]);
  });

  // §7.6 — the RN-Case-Manager treatment path still clears SUD with no release on file (an
  // intra-program read is not a §2.31 disclosure). What CHANGED is that M39 is consulted first: since
  // a release can now name workforce members, "is there a restriction naming someone else?" is a fact
  // the role path has to know before it can apply. The round-trip it used to skip is the price.
  it("clears both for the RN Case Manager when no release restricts the patient's SUD content (§7.6)", async () => {
    let seenMembership: string | null | undefined;
    const decision = await resolveDisclosure(
      actor({ roles: ["rn_case_manager"] }),
      PATIENT,
      port({
        part2: false,
        fvRedacted: false,
        onPart2: (m) => {
          seenMembership = m;
        },
      }),
    );
    expect(decision.sudAllowed).toBe(true);
    expect(decision.familyViolenceAllowed).toBe(true);
    expect(decision.redactedCategories).toEqual([]);
    // …and M39 was asked, about THIS actor.
    expect(seenMembership).toBe(RN_MEMBERSHIP);
  });

  it("the RN Case Manager does NOT override a release restricted to other named workforce members", async () => {
    const decision = await resolveDisclosure(
      actor({ roles: ["rn_case_manager"] }),
      PATIENT,
      port({ part2: false, part2RestrictedToOthers: true, fvRedacted: false }),
    );
    // The patient named who may see this and did not name the case manager. A role key does not
    // outrank the person who signed the release — this is the one case the §7.6 path yields to.
    expect(decision.sudAllowed).toBe(false);
    expect([...decision.redactedCategories]).toEqual(["sud"]);
  });

  it("clears SUD for a workforce member the release DOES name, whatever their role", async () => {
    const decision = await resolveDisclosure(
      actor({ roles: ["pt"] }),
      PATIENT,
      port({ part2: true, fvRedacted: false }),
    );
    expect(decision.sudAllowed).toBe(true);
  });

  it("clears SUD on a satisfied 42 CFR Part 2 release", async () => {
    const decision = await resolveDisclosure(
      actor({ roles: ["msw"] }),
      PATIENT,
      port({ part2: true, fvRedacted: false }),
    );
    expect(decision.sudAllowed).toBe(true);
    expect(decision.redactedCategories).toEqual([]);
  });

  it("REDACTS both categories when M39 is unavailable (§8.7 — an outage narrows, never widens)", async () => {
    const decision = await resolveDisclosure(
      actor({ roles: ["msw"] }),
      PATIENT,
      port({ part2: "throw", fvRedacted: "throw" }),
    );
    expect([...decision.redactedCategories]).toEqual(["sud", "family_violence"]);
  });

  it("strips both categories from the patient-shareable summary whoever reads it (§7.9)", () => {
    expect(SUMMARY_DISCLOSURE.sudAllowed).toBe(false);
    expect(SUMMARY_DISCLOSURE.familyViolenceAllowed).toBe(false);
    expect([...SUMMARY_DISCLOSURE.redactedCategories]).toEqual(["sud", "family_violence"]);
  });
});

describe("M15-T06 §4.6.1 cursor pagination", () => {
  it("emits the spec's `{data, next_cursor, has_more}` envelope and round-trips the cursor", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const page = toCursorPage(
      rows,
      2,
      (r) => ({ a: r.id, id: r.id }),
      (r) => r.id,
    );
    expect(page.data).toEqual(["a", "b"]);
    expect(page.has_more).toBe(true);
    expect(decodeCursor(page.next_cursor ?? undefined)).toEqual({ a: "b", id: "b" });
  });

  it("closes the page when the row set fits", () => {
    const page = toCursorPage(
      [{ id: "a" }],
      2,
      (r) => ({ a: r.id, id: r.id }),
      (r) => r.id,
    );
    expect([page.has_more, page.next_cursor]).toEqual([false, null]);
  });

  it("treats a malformed cursor as 'start from the beginning' rather than throwing", () => {
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(decodeCursor(encodeCursor({ a: "x", id: "y" }))).toEqual({ a: "x", id: "y" });
  });

  it("clamps `limit` to each route's §4.6.1 page-size policy", () => {
    expect(clampLimit(undefined, M15_PAGE_SIZES.plans)).toBe(25);
    expect(clampLimit("500", M15_PAGE_SIZES.plans)).toBe(100);
    expect(clampLimit("0", M15_PAGE_SIZES.versions)).toBe(1);
    expect(clampLimit("500", M15_PAGE_SIZES.supervisoryCadence)).toBe(200);
  });
});
