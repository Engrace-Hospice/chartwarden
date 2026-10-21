// apps/backend/__tests__/portal-lifecycle.test.ts — M31-T03 (§2.2, §2.3, §4.4, §6.4, §7.1, §7.5, §8.1).
//
// The PURE M31 portal domain core — no DB, no live seams, no ambient clock: every fact (and `nowMs`) is
// injected. The cases that matter most pin the fail-CLOSED direction the §8 threat model turns on: an
// unreachable patient is a 403 not a leak, an expired invite is a 410 not a silent re-issue, a tenant
// overlay may tighten but never loosen the floor, and a bereaved flip refuses when M16 says out-of-window.
import {
  type PortalAccessGrantKind,
  type PortalAccountRelationship,
  SESSION_POLICY,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  type FlipCandidateGrant,
  INVITATION_TTL_CEILING_MS,
  INVITATION_TTL_FLOOR_MS,
  type PortalInvitation,
  PortalStateError,
  type SessionReachableGrant,
  acceptInvitation,
  assertNoOrgSwitch,
  assertSessionLive,
  assertStepUpFresh,
  categoryAllowedByFloor,
  consentTypeForGrantKind,
  decidePortalAccess,
  evaluateSessionExpiry,
  grantKindForRelationship,
  isInvitationOutstanding,
  isStepUpFresh,
  issueInvitation,
  mintPortalSession,
  planBereavedFlip,
  planBereavedWindowClose,
  platformFloorScopeSet,
  resolveInvitationTtlMs,
  resolvePortalSessionPolicy,
  scopeSetContains,
  switchActivePatient,
  touchSession,
  validateScopeSet,
} from "../src/modules/31-portal/lifecycle/index";

const T0 = Date.parse("2026-08-02T12:00:00.000Z");
const FLOOR_VERSION = "portal-floor-v1";

// ── §2.3 / §6.4 scope-set resolution ────────────────────────────────────────────────────────────────
describe("validateScopeSet (§2.3 / §6.4)", () => {
  it("platform floor: family_caregiver reads live-patient categories, not bereavement", () => {
    const s = platformFloorScopeSet("family_caregiver", FLOOR_VERSION);
    expect(scopeSetContains(s, "care_plan")).toBe(true);
    expect(scopeSetContains(s, "medications")).toBe(true);
    expect(scopeSetContains(s, "bereavement")).toBe(false);
  });

  it("bereaved_family floor is the narrow D6 scope: bereavement + messages only", () => {
    const s = platformFloorScopeSet("bereaved_family", FLOOR_VERSION);
    expect(scopeSetContains(s, "bereavement")).toBe(true);
    expect(scopeSetContains(s, "messages")).toBe(true);
    expect(scopeSetContains(s, "care_plan")).toBe(false);
    expect(scopeSetContains(s, "medications")).toBe(false);
  });

  it("personal_representative floor is historical read only (no messages/administrations/triage)", () => {
    expect(categoryAllowedByFloor("personal_representative", "care_plan")).toBe(true);
    expect(categoryAllowedByFloor("personal_representative", "documents")).toBe(true);
    expect(categoryAllowedByFloor("personal_representative", "messages")).toBe(false);
    expect(categoryAllowedByFloor("personal_representative", "administrations")).toBe(false);
  });

  it("tenant overlay TIGHTENS a floor-allowed category off", () => {
    const s = validateScopeSet("family_caregiver", FLOOR_VERSION, { medications: false });
    expect(scopeSetContains(s, "medications")).toBe(false);
    expect(scopeSetContains(s, "care_plan")).toBe(true);
  });

  it("tenant overlay LOOSENING a floor-denied category is REFUSED (SCOPE_SET_LOOSENS_FLOOR)", () => {
    expect(() =>
      validateScopeSet("bereaved_family", FLOOR_VERSION, { care_plan: true }),
    ).toThrowError(PortalStateError);
    try {
      validateScopeSet("bereaved_family", FLOOR_VERSION, { care_plan: true });
    } catch (e) {
      expect((e as PortalStateError).code).toBe("SCOPE_SET_LOOSENS_FLOOR");
      expect((e as PortalStateError).statusCode).toBe(422);
    }
  });

  it("overlay true on a floor-allowed category is a no-op (already on)", () => {
    const s = validateScopeSet("family_caregiver", FLOOR_VERSION, { care_plan: true });
    expect(scopeSetContains(s, "care_plan")).toBe(true);
  });
});

// ── §8.1 portal session lifecycle ───────────────────────────────────────────────────────────────────
describe("mintPortalSession (§2.3 / §8.1)", () => {
  const grants: SessionReachableGrant[] = [
    { patientId: "pat-A", grantKind: "family_caregiver", revoked: false },
    { patientId: "pat-B", grantKind: "family_caregiver", revoked: true },
  ];

  it("mints scoped to a reachable, non-revoked patient", () => {
    const s = mintPortalSession(
      { accountStatus: "active", requestedPatientId: "pat-A", reachableGrants: grants },
      { orgId: "org-1", portalAccountId: "acct-1", nowMs: T0 },
    );
    expect(s.activePatientId).toBe("pat-A");
    expect(s.activeGrantKind).toBe("family_caregiver");
    expect(s.mintedAtMs).toBe(T0);
    expect(s.stepUpAtMs).toBeNull();
  });

  it("refuses a patient reachable only via a REVOKED grant (403, fail-closed)", () => {
    try {
      mintPortalSession(
        { accountStatus: "active", requestedPatientId: "pat-B", reachableGrants: grants },
        { orgId: "org-1", portalAccountId: "acct-1", nowMs: T0 },
      );
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as PortalStateError).code).toBe("SESSION_PATIENT_UNREACHABLE");
      expect((e as PortalStateError).statusCode).toBe(403);
    }
  });

  it("refuses a suspended account", () => {
    try {
      mintPortalSession(
        { accountStatus: "suspended", requestedPatientId: "pat-A", reachableGrants: grants },
        { orgId: "org-1", portalAccountId: "acct-1", nowMs: T0 },
      );
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as PortalStateError).code).toBe("SESSION_ACCOUNT_NOT_ACTIVE");
    }
  });

  it("allows a bereaved account to mint (lateral flip preserves the row)", () => {
    const s = mintPortalSession(
      {
        accountStatus: "bereaved",
        requestedPatientId: "pat-A",
        reachableGrants: [{ patientId: "pat-A", grantKind: "bereaved_family", revoked: false }],
      },
      { orgId: "org-1", portalAccountId: "acct-1", nowMs: T0 },
    );
    expect(s.activeGrantKind).toBe("bereaved_family");
  });
});

describe("session expiry / step-up / org-switch (§8.1)", () => {
  const policy = resolvePortalSessionPolicy();

  it("idle window is 30min, hard cap 8h, step-up 15min (platform floor)", () => {
    expect(policy.idleTimeoutMs).toBe(SESSION_POLICY.byClass.patient_portal.idleSec * 1000);
    expect(policy.idleTimeoutMs).toBe(30 * 60_000);
    expect(policy.hardTimeoutMs).toBe(8 * 60 * 60_000);
    expect(policy.stepUpWindowMs).toBe(15 * 60_000);
    expect(policy.allowOrgSwitch).toBe(false);
  });

  it("tenant policy may only TIGHTEN (shorten) the windows", () => {
    const p = resolvePortalSessionPolicy({
      idleTimeoutMs: 15 * 60_000,
      hardTimeoutMs: 100 * 60 * 60_000,
    });
    expect(p.idleTimeoutMs).toBe(15 * 60_000); // honored (tighter)
    expect(p.hardTimeoutMs).toBe(8 * 60 * 60_000); // clamped to floor (a loosening attempt)
  });

  it("evaluates idle then hard expiry", () => {
    const session = { mintedAtMs: T0, lastActiveAtMs: T0 };
    expect(evaluateSessionExpiry(session, policy, T0 + 10 * 60_000)).toBeNull();
    expect(evaluateSessionExpiry(session, policy, T0 + 31 * 60_000)).toBe("idle_expired");
    // fresh touch but past the hard cap → hard expiry wins
    expect(
      evaluateSessionExpiry(
        { mintedAtMs: T0, lastActiveAtMs: T0 + 8 * 60 * 60_000 },
        policy,
        T0 + 8 * 60 * 60_000,
      ),
    ).toBe("hard_expired");
  });

  it("assertSessionLive throws the right code + touch resets idle", () => {
    const s = { mintedAtMs: T0, lastActiveAtMs: T0 };
    expect(() => assertSessionLive(s, policy, T0 + 31 * 60_000)).toThrowError(/idle/i);
    const touched = touchSession(
      mintPortalSession(
        {
          accountStatus: "active",
          requestedPatientId: "pat-A",
          reachableGrants: [{ patientId: "pat-A", grantKind: "family_caregiver", revoked: false }],
        },
        { orgId: "org-1", portalAccountId: "acct-1", nowMs: T0 },
      ),
      T0 + 20 * 60_000,
    );
    expect(() => assertSessionLive(touched, policy, T0 + 45 * 60_000)).not.toThrow();
  });

  it("step-up is fresh only within the window", () => {
    expect(isStepUpFresh({ stepUpAtMs: null }, policy, T0)).toBe(false);
    expect(isStepUpFresh({ stepUpAtMs: T0 }, policy, T0 + 5 * 60_000)).toBe(true);
    expect(isStepUpFresh({ stepUpAtMs: T0 }, policy, T0 + 16 * 60_000)).toBe(false);
    expect(() => assertStepUpFresh({ stepUpAtMs: null }, policy, T0)).toThrowError(/step-up/i);
  });

  it("refuses an org switch mid-session", () => {
    expect(() => assertNoOrgSwitch({ orgId: "org-1" }, "org-1")).not.toThrow();
    try {
      assertNoOrgSwitch({ orgId: "org-1" }, "org-2");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as PortalStateError).code).toBe("SESSION_ORG_SWITCH_FORBIDDEN");
    }
  });

  it("switchActivePatient stays on the same account, one patient at a time, keeps the mint clock", () => {
    const s = mintPortalSession(
      {
        accountStatus: "active",
        requestedPatientId: "pat-A",
        reachableGrants: [
          { patientId: "pat-A", grantKind: "family_caregiver", revoked: false },
          { patientId: "pat-C", grantKind: "dpoa_healthcare", revoked: false },
        ],
      },
      { orgId: "org-1", portalAccountId: "acct-1", nowMs: T0 },
    );
    const next = switchActivePatient(
      s,
      {
        accountStatus: "active",
        requestedPatientId: "pat-C",
        reachableGrants: [{ patientId: "pat-C", grantKind: "dpoa_healthcare", revoked: false }],
      },
      T0 + 60_000,
    );
    expect(next.activePatientId).toBe("pat-C");
    expect(next.activeGrantKind).toBe("dpoa_healthcare");
    expect(next.mintedAtMs).toBe(T0); // hard cap unchanged by a switch
    expect(next.stepUpAtMs).toBeNull();
  });
});

// ── §7.1 / §2.6 magic-link invitation ───────────────────────────────────────────────────────────────
describe("invitation state machine (§7.1 / §2.6 / §8.3)", () => {
  const rel: PortalAccountRelationship = "family_caregiver";

  it("relationship → grant kind", () => {
    expect(grantKindForRelationship("family_caregiver")).toBe("family_caregiver");
    expect(grantKindForRelationship("dpoa_healthcare_agent")).toBe("dpoa_healthcare");
    expect(grantKindForRelationship("personal_representative_post_death")).toBe(
      "personal_representative",
    );
    expect(grantKindForRelationship("bereaved_family_member")).toBe("bereaved_family");
  });

  it("TTL clamps into the 72h..7d band", () => {
    expect(resolveInvitationTtlMs()).toBe(INVITATION_TTL_FLOOR_MS);
    expect(resolveInvitationTtlMs(1_000)).toBe(INVITATION_TTL_FLOOR_MS); // below floor → floor
    expect(resolveInvitationTtlMs(999 * 24 * 60 * 60_000)).toBe(INVITATION_TTL_CEILING_MS);
  });

  const invite = (): PortalInvitation =>
    issueInvitation({ tokenHash: "tok", patientId: "pat-A", relationship: rel, nowMs: T0 });

  it("issues an outstanding invite and accepts it into a scoped grant", () => {
    const inv = invite();
    expect(isInvitationOutstanding(inv, T0)).toBe(true);
    const res = acceptInvitation(inv, {
      portalAccountId: "acct-1",
      floorVersion: FLOOR_VERSION,
      nowMs: T0 + 60_000,
    });
    expect(res.replayed).toBe(false);
    expect(res.grantKind).toBe("family_caregiver");
    expect(res.invitation.acceptedByPortalAccountId).toBe("acct-1");
    expect(scopeSetContains(res.resolvedScope, "care_plan")).toBe(true);
  });

  it("expired invite → 410 (INVITATION_EXPIRED)", () => {
    const inv = invite();
    try {
      acceptInvitation(inv, {
        portalAccountId: "acct-1",
        floorVersion: FLOOR_VERSION,
        nowMs: T0 + INVITATION_TTL_FLOOR_MS,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as PortalStateError).code).toBe("INVITATION_EXPIRED");
      expect((e as PortalStateError).statusCode).toBe(410);
    }
  });

  it("revoked invite → 410 (INVITATION_REVOKED)", () => {
    const inv: PortalInvitation = { ...invite(), revokedAtMs: T0 + 10_000 };
    expect(() =>
      acceptInvitation(inv, {
        portalAccountId: "acct-1",
        floorVersion: FLOOR_VERSION,
        nowMs: T0 + 20_000,
      }),
    ).toThrowError(/revoked/i);
  });

  it("§2.6 idempotent replay: same account re-hitting an accepted token returns the existing binding", () => {
    const inv = invite();
    const first = acceptInvitation(inv, {
      portalAccountId: "acct-1",
      floorVersion: FLOOR_VERSION,
      nowMs: T0 + 60_000,
    });
    const replay = acceptInvitation(first.invitation, {
      portalAccountId: "acct-1",
      floorVersion: FLOOR_VERSION,
      nowMs: T0 + 120_000,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.invitation.acceptedAtMs).toBe(first.invitation.acceptedAtMs);
  });

  it("a DIFFERENT account against an accepted token is a collision (409 INVITATION_ALREADY_BOUND)", () => {
    const inv = invite();
    const first = acceptInvitation(inv, {
      portalAccountId: "acct-1",
      floorVersion: FLOOR_VERSION,
      nowMs: T0 + 60_000,
    });
    try {
      acceptInvitation(first.invitation, {
        portalAccountId: "acct-2",
        floorVersion: FLOOR_VERSION,
        nowMs: T0 + 120_000,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as PortalStateError).code).toBe("INVITATION_ALREADY_BOUND");
      expect((e as PortalStateError).statusCode).toBe(409);
    }
  });

  it("a proposed overlay that loosens the floor is refused as INVITATION_SCOPE_INVALID", () => {
    const inv = issueInvitation({
      tokenHash: "tok2",
      patientId: "pat-A",
      relationship: "bereaved_family_member",
      proposedScopeOverlay: { care_plan: true },
      nowMs: T0,
    });
    try {
      acceptInvitation(inv, {
        portalAccountId: "acct-1",
        floorVersion: FLOOR_VERSION,
        nowMs: T0 + 60_000,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as PortalStateError).code).toBe("INVITATION_SCOPE_INVALID");
      expect((e as PortalStateError).statusCode).toBe(422);
    }
  });
});

// ── §4.4 / §8.2 the M39 portal-access foundation gate ───────────────────────────────────────────────
describe("portal-access foundation gate (§4.4 / §8.2)", () => {
  it("maps each grant kind to its backing M39 consent type", () => {
    const cases: [PortalAccessGrantKind, string][] = [
      ["patient_self", "portal_access"],
      ["family_caregiver", "family_caregiver_access"],
      ["dpoa_healthcare", "dpoa_healthcare"],
      ["personal_representative", "personal_representative_authority_post_death"],
      ["bereaved_family", "bereavement_outreach_consent"],
    ];
    for (const [kind, type] of cases) expect(consentTypeForGrantKind(kind)).toBe(type);
  });

  it("decidePortalAccess passes on allowed=true and fails CLOSED on allowed=false (403)", () => {
    expect(() => decidePortalAccess({ allowed: true })).not.toThrow();
    try {
      decidePortalAccess({ allowed: false });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as PortalStateError).code).toBe("PORTAL_CONSENT_ABSENT");
      expect((e as PortalStateError).statusCode).toBe(403);
    }
  });
});

// ── §7.5 / D6 the bereaved lateral flip ─────────────────────────────────────────────────────────────
describe("bereaved flip planner (§7.5 / D6)", () => {
  const grants: FlipCandidateGrant[] = [
    { grantId: "g-1", patientId: "pat-A", grantKind: "family_caregiver", revoked: false },
    { grantId: "g-2", patientId: "pat-Z", grantKind: "family_caregiver", revoked: false },
  ];

  it("revokes the live care-time grant (patient_deceased) and inserts a bereaved_family grant", () => {
    const plan = planBereavedFlip({
      decedentPatientId: "pat-A",
      accountGrants: grants,
      bereavedInWindow: true,
      floorVersion: FLOOR_VERSION,
    });
    expect(plan.revoke).toEqual([{ grantId: "g-1", revokeCascadeSource: "patient_deceased" }]);
    expect(plan.insert).toHaveLength(1);
    expect(plan.insert[0]!.grantKind).toBe("bereaved_family");
    expect(scopeSetContains(plan.insert[0]!.scopeSet, "bereavement")).toBe(true);
    expect(scopeSetContains(plan.insert[0]!.scopeSet, "care_plan")).toBe(false);
    // pat-Z's grant is untouched — the flip is per decedent
    expect(plan.revoke.find((r) => r.grantId === "g-2")).toBeUndefined();
  });

  it("refuses when M16 says out-of-window (BEREAVED_SCOPE_UNAVAILABLE)", () => {
    try {
      planBereavedFlip({
        decedentPatientId: "pat-A",
        accountGrants: grants,
        bereavedInWindow: false,
        floorVersion: FLOOR_VERSION,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as PortalStateError).code).toBe("BEREAVED_SCOPE_UNAVAILABLE");
    }
  });

  it("refuses when there is no live grant to flip (BEREAVED_FLIP_GRANT_NOT_ACTIVE)", () => {
    try {
      planBereavedFlip({
        decedentPatientId: "pat-A",
        accountGrants: [
          { grantId: "g-1", patientId: "pat-A", grantKind: "family_caregiver", revoked: true },
        ],
        bereavedInWindow: true,
        floorVersion: FLOOR_VERSION,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as PortalStateError).code).toBe("BEREAVED_FLIP_GRANT_NOT_ACTIVE");
    }
  });

  it("window-close revokes bereaved grants with bereavement_window_expired", () => {
    const plan = planBereavedWindowClose({
      decedentPatientId: "pat-A",
      accountGrants: [
        { grantId: "b-1", patientId: "pat-A", grantKind: "bereaved_family", revoked: false },
        { grantId: "c-1", patientId: "pat-A", grantKind: "family_caregiver", revoked: false },
      ],
    });
    expect(plan.revoke).toEqual([
      { grantId: "b-1", revokeCascadeSource: "bereavement_window_expired" },
    ]);
    expect(plan.insert).toHaveLength(0);
  });
});
