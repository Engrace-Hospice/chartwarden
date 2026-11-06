// apps/backend/src/modules/34-saas-tenant-platform/onboarding/pricing-port.ts — the onboarding wizard as M35's plan & contract step
// sees it (slice 2, tenant pricing). M35 has no edge to M34 (ADR-0025), so it owns the port's shape (`OnboardingPricingPort`) and the
// composition root hands it this implementation, which is nothing but the wizard's own operations:
//   enter              slug -> tenant facts on the caller's PLATFORM transaction, after the SHARED onboarding lock (the lock every
//                      onboarding write holds; a go-live approval takes it exclusively, so it cannot activate the tenant between the
//                      status check and the write);
//   planContractStep   the step as the platform wizard view reports it (status, and the earlier step that still locks it);
//   attestPlanContract the wizard's own platform attest: strict sequence, evidence rules, the row audit, the advance sweep afterwards.
import { type DbClient, schema } from "@chartwarden/db";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import { eq } from "drizzle-orm";
import { lockTenantOnboardingShared } from "../routes/platform/tenant-onboarding-lock";
import type { OnboardingWizard } from "./wizard-service";

const ORG = schema.organizations;
const ACCOUNT = schema.tenantAccount;

/** The wizard step this port settles (the `onboarding_task_template.key` migration 1327 seeds at position 2). */
export const PLAN_CONTRACT_TEMPLATE_KEY = "plan_contract";

type StepStatus = "pending" | "in_progress" | "done" | "skipped" | "blocked";

export interface PricingOnboardingPort {
  enter(
    tx: DbClient,
    orgSlug: string,
  ): Promise<{ organizationId: string; tenantAccountId: string; status: string } | null>;
  planContractStep(
    orgSlug: string,
  ): Promise<{ taskId: string | null; status: StepStatus; lockedBy: string | null } | null>;
  attestPlanContract(input: {
    orgSlug: string;
    operator: { userId: string; membershipId: string };
    evidenceNote: string;
    evidenceRef: string;
    reason: string;
  }): Promise<void>;
}

/**
 * When the tenant went live: `tenant_account.activated_at`, which the lifecycle machine stamps on the `onboarding -> active` transition
 * (the go-live approval). null = not live yet. M35's statement run reads it through its `GoLiveReader` port, on the platform transaction
 * it already holds: a tenant is charged from its go-live day, not from the day its contract was signed.
 */
export async function readTenantGoLive(tx: DbClient, organizationId: string): Promise<Date | null> {
  const [account] = await tx
    .select({ activatedAt: ACCOUNT.activatedAt })
    .from(ACCOUNT)
    .where(eq(ACCOUNT.organizationId, organizationId))
    .limit(1);
  return account?.activatedAt ?? null;
}

export function buildPricingOnboardingPort(deps: {
  readonly wizard: Pick<OnboardingWizard, "getPlatform" | "attestPlatform">;
}): PricingOnboardingPort {
  async function stepOf(orgSlug: string) {
    try {
      const view = await deps.wizard.getPlatform(orgSlug);
      return view.steps.find((s) => s.key === PLAN_CONTRACT_TEMPLATE_KEY) ?? null;
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  return {
    async enter(tx, orgSlug) {
      const [org] = await tx.select({ id: ORG.id }).from(ORG).where(eq(ORG.slug, orgSlug)).limit(1);
      if (!org) return null;
      await lockTenantOnboardingShared(tx, org.id);
      const [account] = await tx
        .select({ id: ACCOUNT.id, status: ACCOUNT.status })
        .from(ACCOUNT)
        .where(eq(ACCOUNT.organizationId, org.id))
        .limit(1);
      return account
        ? { organizationId: org.id, tenantAccountId: account.id, status: account.status }
        : null;
    },

    async planContractStep(orgSlug) {
      const step = await stepOf(orgSlug);
      return step ? { taskId: step.id, status: step.status, lockedBy: step.lockedBy } : null;
    },

    async attestPlanContract({ orgSlug, operator, evidenceNote, evidenceRef, reason }) {
      const step = await stepOf(orgSlug);
      if (!step?.id) {
        throw new ChartWardenError(
          "ONBOARDING_STEP_MISSING",
          "the tenant has no plan & contract step to settle",
          409,
        );
      }
      await deps.wizard.attestPlatform(
        orgSlug,
        step.id,
        { kind: "platform", userId: operator.userId, membershipId: operator.membershipId },
        { evidenceNote, evidenceRef, reason },
      );
    },
  };
}
