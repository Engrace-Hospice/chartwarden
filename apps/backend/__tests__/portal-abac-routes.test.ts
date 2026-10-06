// apps/backend/__tests__/portal-abac-routes.test.ts — M31-T07 (§4.6 / §4.7).
//
// The route-layer contracts, unit-tested with no DB and no live seams: the forty-seven §4.6 permission
// keys, and the six §4.7 ABAC predicates decided over an injected resolver + ports. The cases that matter
// pin the fail-CLOSED direction §8.2 turns on — a NON-portal session class denies every `portal.*`
// predicate, an absent grant denies, and a live grant allows ONLY when the backing M39 consent is live.
import { M31_CONTRIBUTED_PERMISSIONS } from "@wardenx/auth";
import type { AbacContext, AbacTarget } from "@wardenx/auth";
import { describe, expect, it } from "vitest";
import {
  M31_ABAC_PREDICATES,
  type PortalAbacPorts,
  type PortalAbacResolver,
  buildPortalAbacPredicates,
  decideCaregiverPrimaryOrDpoa,
  decidePortalAccountActive,
} from "../src/modules/31-portal/abac-predicates";
import {
  M31_PERMISSION_KEY_LIST,
  M31_STEP_UP_PERMISSION_KEYS,
} from "../src/modules/31-portal/permission-keys";

const ACCOUNT = "11111111-1111-1111-1111-111111111111";
const PATIENT = "22222222-2222-2222-2222-222222222222";
const ORG = "33333333-3333-3333-3333-333333333333";

function ctx(overrides: Partial<AbacContext> = {}): AbacContext {
  return {
    organizationId: ORG,
    userId: "user-1",
    roles: [],
    providerEntityIds: [],
    locationIds: [],
    attributes: {
      sessionClass: "caregiver_portal",
      portalAccountId: ACCOUNT,
      sessionPatientId: PATIENT,
    },
    ...overrides,
  };
}

const target: AbacTarget = { portalAccountId: ACCOUNT, patientId: PATIENT };

const resolver = (over: Partial<PortalAbacResolver> = {}): PortalAbacResolver => ({
  async loadAccount() {
    return { portalAccountId: ACCOUNT, userId: "user-1", status: "active" };
  },
  async activeGrant() {
    return {
      grantId: "g1",
      portalAccountId: ACCOUNT,
      patientId: PATIENT,
      grantKind: "family_caregiver",
    };
  },
  async loadTelehealthVisit() {
    return { telehealthVisitId: "v1", patientId: PATIENT };
  },
  ...over,
});

const ports = (consentAllowed: boolean, over: Partial<PortalAbacPorts> = {}): PortalAbacPorts => ({
  async consentActive() {
    return consentAllowed;
  },
  async bereavedWindowOpen() {
    return true;
  },
  async primaryCaregiverUserId() {
    return "user-1";
  },
  async patientResidenceState() {
    return "CA";
  },
  async engagementActive() {
    return true;
  },
  ...over,
});

describe("M31-T07 §4.6 permission keys", () => {
  it("registers exactly forty-seven keys, each with a resource/action/category/abac", () => {
    expect(M31_PERMISSION_KEY_LIST).toHaveLength(47);
    for (const def of Object.values(M31_CONTRIBUTED_PERMISSIONS)) {
      expect(def.resource.length).toBeGreaterThan(0);
      expect(def.action.length).toBeGreaterThan(0);
      expect(def.category.length).toBeGreaterThan(0);
      expect(def.abac.length).toBeGreaterThan(0);
    }
  });
  it("the six step-up keys are all real permission keys", () => {
    for (const k of M31_STEP_UP_PERMISSION_KEYS) {
      expect(M31_PERMISSION_KEY_LIST).toContain(k);
    }
    expect(M31_STEP_UP_PERMISSION_KEYS).toHaveLength(6);
  });
});

describe("M31-T07 §4.7 ABAC predicates — fail-closed", () => {
  it("names exactly the seven owned predicates", () => {
    expect([...M31_ABAC_PREDICATES]).toEqual([
      "portal_account_active",
      "portal_grant_active_for_patient",
      "portal_caregiver_is_primary_or_dpoa",
      "bereaved_portal_window_open",
      "telehealth_consent_active",
      "state_two_party_recording_consent_present",
      "portal_engagement_scope",
    ]);
  });

  it("portal_grant_active_for_patient allows only when grant AND consent are live", async () => {
    const allow = buildPortalAbacPredicates({ resolver: resolver(), ports: ports(true) });
    expect(await allow.portal_grant_active_for_patient(ctx(), target)).toBe(true);

    const consentGone = buildPortalAbacPredicates({ resolver: resolver(), ports: ports(false) });
    expect(await consentGone.portal_grant_active_for_patient(ctx(), target)).toBe(false);

    const noGrant = buildPortalAbacPredicates({
      resolver: resolver({
        async activeGrant() {
          return null;
        },
      }),
      ports: ports(true),
    });
    expect(await noGrant.portal_grant_active_for_patient(ctx(), target)).toBe(false);
  });

  it("a non-portal session class denies every portal predicate", async () => {
    const p = buildPortalAbacPredicates({ resolver: resolver(), ports: ports(true) });
    const staff = ctx({
      attributes: { sessionClass: "staff", portalAccountId: ACCOUNT, sessionPatientId: PATIENT },
    });
    expect(await p.portal_account_active(staff, target)).toBe(false);
    expect(await p.portal_grant_active_for_patient(staff, target)).toBe(false);
  });

  it("telehealth_consent_active resolves the patient from the visit, not the wire", async () => {
    const p = buildPortalAbacPredicates({ resolver: resolver(), ports: ports(true) });
    const own = { telehealthVisitId: "v1", sessionPatientId: PATIENT };
    expect(await p.telehealth_consent_active(ctx(), own)).toBe(true);
    // GAP-094: a portal session scoped to ANOTHER patient (or none) never passes for this visit.
    expect(
      await p.telehealth_consent_active(ctx(), { ...own, sessionPatientId: "other-patient" }),
    ).toBe(false);
    expect(await p.telehealth_consent_active(ctx(), { telehealthVisitId: "v1" })).toBe(false);
    const denied = buildPortalAbacPredicates({ resolver: resolver(), ports: ports(false) });
    expect(await denied.telehealth_consent_active(ctx(), own)).toBe(false);
  });

  it("state_two_party_recording_consent_present: two-party state needs consent; one-party passes", async () => {
    const twoParty = buildPortalAbacPredicates({ resolver: resolver(), ports: ports(false) });
    expect(
      await twoParty.state_two_party_recording_consent_present(ctx(), { telehealthVisitId: "v1" }),
    ).toBe(false);
    const oneParty = buildPortalAbacPredicates({
      resolver: resolver(),
      ports: ports(false, {
        async patientResidenceState() {
          return "TX";
        },
      }),
    });
    expect(
      await oneParty.state_two_party_recording_consent_present(ctx(), { telehealthVisitId: "v1" }),
    ).toBe(true);
  });
});

describe("M31 GAP-093 portal_engagement_scope — fail-closed", () => {
  const ENGAGEMENT = "44444444-4444-4444-8444-444444444444";
  const auditor = ctx({ attributes: { sessionClass: "auditor", engagementId: ENGAGEMENT } });
  const own: AbacTarget = { engagementId: ENGAGEMENT, sessionEngagementId: ENGAGEMENT };

  it("allows an auditor session on its own, active engagement", async () => {
    const p = buildPortalAbacPredicates({ resolver: resolver(), ports: ports(true) });
    expect(await p.portal_engagement_scope(auditor, own)).toBe(true);
  });

  it("denies a non-auditor session class", async () => {
    const p = buildPortalAbacPredicates({ resolver: resolver(), ports: ports(true) });
    const staff = ctx({ attributes: { sessionClass: "staff", engagementId: ENGAGEMENT } });
    expect(await p.portal_engagement_scope(staff, own)).toBe(false);
  });

  it("denies when the route names a different engagement than the session's, or the session has none", async () => {
    const p = buildPortalAbacPredicates({ resolver: resolver(), ports: ports(true) });
    expect(await p.portal_engagement_scope(auditor, { ...own, engagementId: "other" })).toBe(false);
    expect(await p.portal_engagement_scope(auditor, { engagementId: ENGAGEMENT })).toBe(false);
    expect(await p.portal_engagement_scope(auditor, {})).toBe(false);
  });

  it("denies an inactive engagement and catches a throwing reader", async () => {
    const inactive = buildPortalAbacPredicates({
      resolver: resolver(),
      ports: ports(true, {
        async engagementActive() {
          return false;
        },
      }),
    });
    expect(await inactive.portal_engagement_scope(auditor, own)).toBe(false);
    const throwing = buildPortalAbacPredicates({
      resolver: resolver(),
      ports: ports(true, {
        async engagementActive() {
          throw new Error("M3 unreadable");
        },
      }),
    });
    expect(await throwing.portal_engagement_scope(auditor, own)).toBe(false);
  });

  it("hands the reader the SESSION's user and org, never a target-supplied one", async () => {
    const seen: unknown[] = [];
    const p = buildPortalAbacPredicates({
      resolver: resolver(),
      ports: ports(true, {
        async engagementActive(input) {
          seen.push(input);
          return true;
        },
      }),
      now: () => new Date("2026-07-30T12:00:00.000Z"),
    });
    await p.portal_engagement_scope(auditor, {
      ...own,
      organizationId: "evil",
      auditorUserId: "evil",
    });
    expect(seen).toEqual([
      {
        organizationId: ORG,
        engagementId: ENGAGEMENT,
        auditorUserId: "user-1",
        at: "2026-07-30T12:00:00.000Z",
      },
    ]);
  });
});

describe("M31-T07 §4.7 pure decisions", () => {
  it("decidePortalAccountActive: active/bereaved live, others deny", () => {
    expect(
      decidePortalAccountActive({ portalAccountId: ACCOUNT, userId: "u", status: "active" }),
    ).toBe(true);
    expect(
      decidePortalAccountActive({ portalAccountId: ACCOUNT, userId: "u", status: "bereaved" }),
    ).toBe(true);
    expect(
      decidePortalAccountActive({ portalAccountId: ACCOUNT, userId: "u", status: "suspended" }),
    ).toBe(false);
    expect(decidePortalAccountActive(null)).toBe(false);
  });

  it("decideCaregiverPrimaryOrDpoa: DPOA/self always, family only when primary", () => {
    const account = { portalAccountId: ACCOUNT, userId: "u1", status: "active" as const };
    expect(
      decideCaregiverPrimaryOrDpoa({
        grant: {
          grantId: "g",
          portalAccountId: ACCOUNT,
          patientId: PATIENT,
          grantKind: "dpoa_healthcare",
        },
        account,
        primaryCaregiverUserId: null,
      }),
    ).toBe(true);
    expect(
      decideCaregiverPrimaryOrDpoa({
        grant: {
          grantId: "g",
          portalAccountId: ACCOUNT,
          patientId: PATIENT,
          grantKind: "family_caregiver",
        },
        account,
        primaryCaregiverUserId: "u1",
      }),
    ).toBe(true);
    expect(
      decideCaregiverPrimaryOrDpoa({
        grant: {
          grantId: "g",
          portalAccountId: ACCOUNT,
          patientId: PATIENT,
          grantKind: "family_caregiver",
        },
        account,
        primaryCaregiverUserId: "someone-else",
      }),
    ).toBe(false);
  });
});
