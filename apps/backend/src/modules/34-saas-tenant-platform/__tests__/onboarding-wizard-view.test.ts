// The tenant's view of the wizard never carries a ChartWarden operator's membership: it says "ChartWarden operations" and
// when. Reasons stay. A tenant's own members stay visible, including a tenant admin who voided an attestation.
import { describe, expect, it } from "vitest";
import {
  PLATFORM_OPERATOR_LABEL,
  TENANT_OWN_LABEL,
  type WizardView,
  redactStepForTenant,
  redactViewForTenant,
} from "../onboarding/wizard-view";

const AT = "2026-11-05T12:00:00.000Z";
const ADMIN_VIEWER = { roles: ["org_admin"] };
const step = (attestedBy: WizardView["steps"][number]["attestedBy"]): WizardView["steps"][number] =>
  ({
    id: "t1",
    key: "billing",
    status: "done",
    attestedBy,
    skippedBy: null,
    skippedByLabel: null,
    tenantSkippable: false,
  }) as WizardView["steps"][number];

const attestation = (over: Partial<NonNullable<WizardView["goLive"]["attestation"]>> = {}) =>
  ({
    id: "att-1",
    status: "approved",
    attestedByMembershipId: "m-co",
    attestedAt: AT,
    expiresAt: null,
    attestationNote: "all reviewed",
    approvedByMembershipId: "m-ops",
    approvedByLabel: null,
    approvedAt: AT,
    approvalReason: "reviewed the evidence and the BAA",
    revokedByMembershipId: null,
    revokedByLabel: null,
    revokedAt: null,
    revokeReason: null,
    ...over,
  }) as NonNullable<WizardView["goLive"]["attestation"]>;

const wizardView = (
  steps: WizardView["steps"],
  attested: WizardView["goLive"]["attestation"],
): WizardView =>
  ({
    tenantAccountId: "ta",
    orgSlug: "acme",
    tenantStatus: "onboarding",
    currentStepKey: null,
    steps,
    goLive: {
      state: "live",
      attestation: attested,
      failedGuards: [],
      complianceOfficerMembershipId: "m-co",
    },
  }) as WizardView;

describe("redactStepForTenant", () => {
  it("replaces a platform operator's membership with the organisation's name and keeps the time", () => {
    const out = redactStepForTenant(
      step({ membershipId: "m-ops", actorKind: "platform_ops", label: null, at: AT }),
      ADMIN_VIEWER,
    );
    expect(out.attestedBy).toEqual({
      membershipId: null,
      actorKind: "platform_ops",
      label: PLATFORM_OPERATOR_LABEL,
      at: AT,
    });
    expect(JSON.stringify(out)).not.toContain("m-ops");
  });

  it("leaves a tenant member's own attestation, and an unattested step, as they are", () => {
    const own = step({ membershipId: "m-admin", actorKind: "tenant", label: null, at: AT });
    expect(redactStepForTenant(own, ADMIN_VIEWER)).toEqual(own);
    expect(redactStepForTenant(step(null), ADMIN_VIEWER)).toEqual(step(null));
  });

  const skipped = (skippedBy: "system" | "tenant" | "platform_ops") =>
    ({
      ...step(null),
      status: "skipped",
      skippedBy,
      skipRationale: "does not apply to us",
    }) as WizardView["steps"][number];

  it("shows an operator's skip as ChartWarden operations and the tenant's own as the organization's, keeping the rationale", () => {
    expect(redactStepForTenant(skipped("platform_ops"), ADMIN_VIEWER)).toMatchObject({
      skippedBy: "platform_ops",
      skippedByLabel: PLATFORM_OPERATOR_LABEL,
      skipRationale: "does not apply to us",
    });
    expect(redactStepForTenant(skipped("tenant"), ADMIN_VIEWER)).toMatchObject({
      skippedBy: "tenant",
      skippedByLabel: TENANT_OWN_LABEL,
    });
    expect(redactStepForTenant(skipped("system"), ADMIN_VIEWER).skippedByLabel).toBeNull();
    expect(redactStepForTenant(step(null), ADMIN_VIEWER).skippedByLabel).toBeNull();
  });

  it("narrows tenantSkippable to a viewer who is an org_admin, and to nobody when the viewer holds no roles", () => {
    const open = {
      ...step(null),
      status: "pending",
      tenantSkippable: true,
    } as WizardView["steps"][number];
    expect(redactStepForTenant(open, ADMIN_VIEWER).tenantSkippable).toBe(true);
    expect(redactStepForTenant(open, { roles: ["administrator"] }).tenantSkippable).toBe(false);
    expect(redactStepForTenant(open, { roles: ["compliance_officer"] }).tenantSkippable).toBe(
      false,
    );
    expect(redactStepForTenant(open, { roles: [] }).tenantSkippable).toBe(false);
    // it only ever narrows: a step the server did not offer is never offered by the redaction
    expect(redactStepForTenant(step(null), ADMIN_VIEWER).tenantSkippable).toBe(false);
  });
});

describe("redactViewForTenant", () => {
  it("hides the approving operator, keeps the reason and the time, and says who approved", () => {
    const out = redactViewForTenant(wizardView([], attestation()), {
      revokedByTenantMember: false,
      viewer: ADMIN_VIEWER,
    });
    expect(out.goLive.attestation).toMatchObject({
      approvedByMembershipId: null,
      approvedByLabel: PLATFORM_OPERATOR_LABEL,
      approvedAt: AT,
      approvalReason: "reviewed the evidence and the BAA",
      attestedByMembershipId: "m-co",
    });
    expect(JSON.stringify(out)).not.toContain("m-ops");
  });

  it("hides a platform operator's revocation but not a tenant admin's", () => {
    const revoked = attestation({
      status: "revoked",
      approvedByMembershipId: null,
      approvedAt: null,
      approvalReason: null,
      revokedByMembershipId: "m-revoker",
      revokedAt: AT,
      revokeReason: "BAA addendum is being renegotiated",
    });
    const byOperator = redactViewForTenant(wizardView([], revoked), {
      revokedByTenantMember: false,
      viewer: ADMIN_VIEWER,
    });
    expect(byOperator.goLive.attestation).toMatchObject({
      revokedByMembershipId: null,
      revokedByLabel: PLATFORM_OPERATOR_LABEL,
      revokeReason: "BAA addendum is being renegotiated",
    });
    const byAdmin = redactViewForTenant(wizardView([], revoked), {
      revokedByTenantMember: true,
      viewer: ADMIN_VIEWER,
    });
    expect(byAdmin.goLive.attestation).toMatchObject({
      revokedByMembershipId: "m-revoker",
      revokedByLabel: null,
    });
  });

  it("redacts every step and tolerates a view with no attestation", () => {
    const out = redactViewForTenant(
      wizardView(
        [step({ membershipId: "m-ops", actorKind: "platform_ops", label: null, at: AT })],
        null,
      ),
      { revokedByTenantMember: false, viewer: ADMIN_VIEWER },
    );
    expect(out.steps[0]?.attestedBy?.membershipId).toBeNull();
    expect(out.goLive.attestation).toBeNull();
  });
});
