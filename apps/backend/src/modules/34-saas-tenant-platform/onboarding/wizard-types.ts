// apps/backend/src/modules/34-saas-tenant-platform/onboarding/wizard-types.ts - the onboarding wizard's public contract: the
// dependencies the composition root binds and the operations the two route surfaces call. Types only; the rules live in
// wizard-steps.ts (a step's lifecycle), wizard-go-live.ts (officer and go-live) and wizard-service.ts (the factory).
import type { PlatformActor, TenantActor } from "./model";
import type { OrgProfile, OrgProfilePort } from "./org-profile";
import type { WizardRunner } from "./wizard-store";
import type { WizardStepView, WizardView } from "./wizard-view";

/**
 * Binds the `compliance_officer` role to one ACTIVE member of a tenant. The production binder commits the grant on the TENANT
 * pool under the tenant's own RLS scope (never on the platform pool, which holds no write on role grants) and writes an audit
 * event naming the operator, the organisation and the reason in the same transaction. It throws a typed refusal when the
 * organisation has no such role or the member is not active.
 */
export type ComplianceOfficerRoleBinder = (input: {
  readonly organizationId: string;
  readonly tenantAccountId: string;
  readonly membershipId: string;
  readonly operator: PlatformActor;
  readonly reason: string;
}) => Promise<void>;

export interface OnboardingWizardDeps {
  readonly runner: WizardRunner;
  readonly orgProfile: OrgProfilePort;
  /**
   * The PLATFORM assignment route binds the role when the chosen member lacks it, so a new tenant's compliance officer can be
   * designated at all: the tenant's org_admin cannot grant it (anti-escalation; the role carries keys org_admin deliberately
   * lacks, ADR-0055 D9). Unbound, the platform route still requires the member to hold the role already.
   */
  readonly bindComplianceOfficerRole?: ComplianceOfficerRoleBinder;
  /**
   * Go-live approval activates the tenant's M2 organization, which stays `created` through onboarding (its first admin signs
   * in under the onboarding allowlist, bootstrap/onboarding-org-gate.ts). Runs AFTER the approval commits; the production
   * binding activates a `created` organization and leaves any other status alone. Unbound: the organization is not touched.
   */
  readonly activateOrganization?: (input: {
    readonly organizationId: string;
    readonly operator: PlatformActor;
    readonly reason: string;
  }) => Promise<void>;
  /** Runs the advance sweep for one tenant after a change (best effort; a failure never fails the change). */
  readonly advance?: (tenant: { tenantAccountId: string; organizationId: string }) => Promise<void>;
  /** `err` carries a raw error: the composition root logs it through the redacting serializer (a database error holds bound values). */
  readonly warn?: (message: string, context: Record<string, unknown>) => void;
  readonly now?: () => Date;
}

export interface WizardViewWithProfile extends WizardView {
  readonly orgProfile: OrgProfile | null;
}

export interface OnboardingWizard {
  // ── platform surface (addressed by org slug; the actor is a platform operator) ─────────────────────────────
  getPlatform(orgSlug: string): Promise<WizardViewWithProfile>;
  attestPlatform(
    orgSlug: string,
    taskId: string,
    actor: PlatformActor,
    input: AttestInput,
  ): Promise<WizardStepView>;
  skipPlatform(
    orgSlug: string,
    taskId: string,
    actor: PlatformActor,
    rationale: string,
  ): Promise<WizardStepView>;
  reopenPlatform(
    orgSlug: string,
    taskId: string,
    actor: PlatformActor,
    reason: string,
  ): Promise<WizardStepView>;
  setOrgProfilePlatform(
    orgSlug: string,
    actor: PlatformActor,
    patch: ProfileInput,
  ): Promise<OrgProfile>;
  setComplianceOfficerPlatform(
    orgSlug: string,
    actor: PlatformActor,
    membershipId: string,
    reason: unknown,
  ): Promise<{ complianceOfficerMembershipId: string }>;
  approveGoLive(orgSlug: string, actor: PlatformActor, reason: string): Promise<WizardView>;
  revokeGoLive(orgSlug: string, actor: PlatformActor, reason: string): Promise<WizardView>;
  // ── tenant surface (the actor's own org) ───────────────────────────────────────────────────────────────────
  getTenant(organizationId: string): Promise<WizardViewWithProfile>;
  startTask(actor: TenantActor, organizationId: string, taskId: string): Promise<WizardStepView>;
  blockTask(
    actor: TenantActor,
    organizationId: string,
    taskId: string,
    blockerReason: string,
  ): Promise<WizardStepView>;
  attestTask(
    actor: TenantActor,
    organizationId: string,
    taskId: string,
    input: AttestInput,
  ): Promise<WizardStepView>;
  reopenTask(
    actor: TenantActor,
    organizationId: string,
    taskId: string,
    reason: string | undefined,
  ): Promise<WizardStepView>;
  setOrgProfile(
    actor: TenantActor,
    organizationId: string,
    patch: ProfileInput,
  ): Promise<OrgProfile>;
  setComplianceOfficer(
    actor: TenantActor,
    organizationId: string,
    membershipId: string,
  ): Promise<{ complianceOfficerMembershipId: string }>;
  attestGoLive(
    actor: TenantActor,
    organizationId: string,
    note: string | undefined,
  ): Promise<WizardView>;
}

export interface AttestInput {
  readonly evidenceNote?: unknown;
  readonly evidenceRef?: unknown;
  /** Why a platform operator is settling the step on the tenant's behalf (required for platform actors). */
  readonly reason?: unknown;
}
export interface ProfileInput {
  readonly displayName?: unknown;
  readonly orgTimezone?: unknown;
}
