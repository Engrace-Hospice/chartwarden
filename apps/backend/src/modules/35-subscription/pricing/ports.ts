// apps/backend/src/modules/35-subscription/pricing/ports.ts — what the pricing slice needs from outside M35, as ports the
// composition root binds (ADR-0025: M35 has no edge to M34 or M4, so neither the onboarding wizard nor the platform audit writer is
// imported here). Both fail CLOSED when unbound: a pricing write that cannot be audited, or cannot find its tenant, is refused.
import { ChartWardenError, type OrgId } from "@chartwarden/types";
import type { M35WriteActor } from "../routes/actor";
import type { PlatformRunner, WriteTx } from "../routes/service-drizzle";

/** One structured platform audit row: WHO, to WHICH organisation (null = the platform catalog), and WHY. Ids and codes only. */
export interface PlatformAuditEntry {
  readonly eventType: string;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly organizationId: string | null;
  readonly operator: Pick<M35WriteActor, "userId" | "membershipId">;
  readonly reason: string;
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
}

/** Writes `entry` on the caller's platform transaction, atomically with the change it describes. */
export interface PlatformAuditPort {
  record(tx: WriteTx, entry: PlatformAuditEntry): Promise<void>;
}

/** The tenant an onboarding call addresses, as the control plane (M34) knows it. */
export interface OnboardingTenantFacts {
  readonly organizationId: OrgId;
  readonly tenantAccountId: string;
  /** `tenant_account.status`: signup_intent | provisioning | onboarding | active | ... */
  readonly status: string;
}

/** Where the `plan_contract` wizard step stands for a tenant. */
export interface PlanContractStep {
  /** The task id; null when the tenant has no task row for the step yet. */
  readonly taskId: string | null;
  readonly status: "pending" | "in_progress" | "done" | "skipped" | "blocked";
  /** An earlier gating step is not settled, so this one cannot be acted on yet (the wizard's strict sequence). */
  readonly lockedBy: string | null;
}

/**
 * The M34 onboarding wizard as seen from the plan & contract step. The composition root implements it over the wizard service.
 *   enter            slug -> tenant facts on the caller's PLATFORM transaction, after taking the shared onboarding lock (the same
 *                    `tenant-onboarding:<org>` advisory lock every onboarding write holds, so a go-live approval cannot activate the
 *                    tenant between the status check and the write). null = no such tenant.
 *   planContractStep the step's state, read through the wizard.
 *   attestPlanContract settles the step through the wizard's own attest operation (strict sequence, evidence, the row audit).
 */
export interface OnboardingPricingPort {
  enter(tx: WriteTx, orgSlug: string): Promise<OnboardingTenantFacts | null>;
  planContractStep(orgSlug: string): Promise<PlanContractStep | null>;
  attestPlanContract(input: {
    readonly orgSlug: string;
    readonly operator: Pick<M35WriteActor, "userId" | "membershipId">;
    readonly evidenceNote: string;
    readonly evidenceRef: string;
    readonly reason: string;
  }): Promise<void>;
}

export const PLAN_CONTRACT_STEP_KEY = "plan_contract";

/** The default platform runner: refuses (503) rather than read or write pricing under a tenant's RLS scope. */
export const failClosedPlatformRunner: PlatformRunner = async () => {
  throw new ChartWardenError(
    "PLATFORM_CONTEXT_UNAVAILABLE",
    "the platform-ops pricing surface requires a bound platform credential",
    503,
  );
};

export function requireAuditPort(port: PlatformAuditPort | undefined): PlatformAuditPort {
  if (port) return port;
  throw new ChartWardenError(
    "AUDIT_UNBOUND",
    "the platform audit writer is not bound; refusing to change pricing without its audit row",
    503,
  );
}

export function requireOnboardingPort(
  port: OnboardingPricingPort | undefined,
): OnboardingPricingPort {
  if (port) return port;
  throw new ChartWardenError(
    "ONBOARDING_UNBOUND",
    "the onboarding wizard is not bound; a tenant's subscription cannot be created without settling its plan & contract step",
    503,
  );
}
