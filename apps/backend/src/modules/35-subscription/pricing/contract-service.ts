// apps/backend/src/modules/35-subscription/pricing/contract-service.ts — a tenant's CONTRACT (slice 2, tenant pricing).
//
// ONBOARDING STEP 2 (`plan_contract`). A platform operator signs the tenant onto a published census_banded plan VERSION and picks the
// billing service mode. In ONE platform transaction this takes the shared onboarding lock, checks the tenant is still provisioning or
// onboarding, creates the subscription, its state-history row, the signed `subscription_contract`, the `m35.subscription.created` event
// and a structured audit row (operator, tenant, reason). It then settles the wizard's `plan_contract` step THROUGH THE WIZARD (the
// `OnboardingPricingPort`: the same attest operation, strict sequence and evidence rules every onboarding step has). Order matters:
//   * BEFORE anything is written the step is read, and a step locked behind an earlier one refuses (409 ONBOARDING_STEP_OUT_OF_ORDER):
//     the sequential wizard stays sequential, and nothing is created that cannot be settled in turn;
//   * AFTER the commit the step is attested with the contract as evidence. If that fails (the tenant moved, a concurrent change) the
//     subscription stays and the response says the step is `pending`: the same POST then RESUMES (an existing subscription on the same
//     plan and mode is reused, never duplicated) and attests again. The step is `either`-attestable by an operator at any time too.
//
// The billing service mode changes later by its own audited route; it prices from the next statement computation (a draft month is
// recomputed with the mode in force, and a closed month keeps what it was finalized with).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { BillingServiceMode } from "@chartwarden/types";
import { ChartWardenError, ConflictError, NotFoundError } from "@chartwarden/types";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import type { M35WriteActor } from "../routes/actor";
import type { PlatformRunner, WriteOutboxPort, WriteTx } from "../routes/service-drizzle";
import { utcDateOf } from "./census-daily";
import { type PricingBandView, bandViews } from "./plan-service";
import {
  type OnboardingPricingPort,
  PLAN_CONTRACT_STEP_KEY,
  type PlatformAuditPort,
  failClosedPlatformRunner,
  requireAuditPort,
  requireOnboardingPort,
} from "./ports";
import { type StatementView, toStatementView } from "./statement-service";
import { normalizeOptionalRef, normalizeReason } from "./text";

const PL = schema.plan;
const PCB = schema.planCensusBand;
const SC = schema.subscriptionContract;
const SUB = schema.subscriptionRow;
const SH = schema.subscriptionStateHistory;
const SS = schema.subscriptionStatement;

const ORDER_REF_MAX = 500;
const STATEMENTS_ON_PLATFORM_VIEW = 12;
/** Tenant statuses in which a subscription may be created for it. */
const SIGNABLE_TENANT_STATUSES: ReadonlySet<string> = new Set(["provisioning", "onboarding"]);

export interface ContractView {
  readonly subscriptionId: string;
  readonly plan: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly version: number;
    readonly currencyCode: string;
  };
  readonly billingServiceMode: BillingServiceMode;
  /** The rate in force for this subscription: 0 when it bills outside ChartWarden. */
  readonly billingBps: number;
  readonly contractStartOn: string;
  readonly contractTermMonths: number;
  readonly contractEndsOn: string;
  readonly perUserPriceCents: number;
  readonly bands: readonly PricingBandView[];
  readonly billingSoftwareBps: number;
  readonly managedBillingBps: number;
  readonly implementationFeeCents: number;
  readonly minimumMonthlyCents: number | null;
}

/** The platform's richer view: who signed, why, and the order form reference. Never on the tenant surface. */
export interface PlatformContractView extends ContractView {
  readonly signedByMembershipId: string;
  readonly signedReason: string;
  readonly orderFormRef: string | null;
}

export interface TenantPricingView {
  readonly contract: ContractView | null;
  /** The latest statement: the month in progress (`draft`) or the last closed one. Null before the first. */
  readonly latestStatement: StatementView | null;
}

export interface PlatformPricingView {
  readonly contract: PlatformContractView | null;
  readonly statements: readonly StatementView[];
}

export interface PlanContractSettlement {
  /** settled = attested now; already_settled = it was done; pending = the subscription exists but the step is not settled yet. */
  readonly status: "settled" | "already_settled" | "pending";
  readonly reason?: string;
}

export interface CreateContractInput {
  readonly planSlug: string;
  readonly billingServiceMode: BillingServiceMode;
  readonly orderFormRef?: string | null;
  readonly reason: unknown;
}

export interface CreateContractResult {
  readonly contract: PlatformContractView;
  /** True when an existing subscription on the same plan and mode was reused (a retry after a failed settlement). */
  readonly resumed: boolean;
  readonly planContractStep: PlanContractSettlement;
}

export interface ContractService {
  createForTenant(
    actor: M35WriteActor,
    orgSlug: string,
    input: CreateContractInput,
  ): Promise<CreateContractResult>;
  setBillingServiceMode(
    actor: M35WriteActor,
    orgSlug: string,
    mode: BillingServiceMode,
    reason: unknown,
  ): Promise<PlatformContractView>;
  platformView(orgSlug: string): Promise<PlatformPricingView>;
  tenantView(organizationId: string, userId: string): Promise<TenantPricingView>;
  /** The tenant's billing service mode (null without a contract), on the tenant pool. The `BillingServiceModeReader` seam body. */
  billingServiceModeForOrg(organizationId: string): Promise<BillingServiceMode | null>;
}

export interface ContractServiceDeps {
  readonly db: DbClient;
  readonly platformRunner?: PlatformRunner;
  readonly outbox?: WriteOutboxPort;
  readonly audit?: PlatformAuditPort;
  readonly onboarding?: OnboardingPricingPort;
  readonly now?: () => Date;
  readonly log?: (message: string, detail: Record<string, unknown>) => void;
}

type ContractRow = typeof SC.$inferSelect;
type PlanRow = typeof PL.$inferSelect;

/** `start` plus `months` calendar months, on the same day (clamped to the month's last day), as `YYYY-MM-DD` (UTC). */
export function addMonthsIso(startIso: string, months: number): string {
  const [y, m, d] = startIso.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

function contractViewOf(
  contract: ContractRow,
  plan: PlanRow,
  bands: readonly { minAdc: number; monthlyFeeCents: number }[],
): ContractView {
  if (
    plan.perUserPriceCents === null ||
    plan.billingSoftwareBps === null ||
    plan.managedBillingBps === null ||
    plan.contractTermMonths === null ||
    plan.implementationFeeCents === null
  ) {
    throw new ChartWardenError("PLAN_PRICING_INCOMPLETE", "the contracted plan has no prices", 500);
  }
  const mode = contract.billingServiceMode;
  return {
    subscriptionId: contract.subscriptionId,
    plan: {
      id: plan.id,
      slug: plan.slug,
      name: plan.name,
      version: plan.version,
      currencyCode: plan.currencyCode,
    },
    billingServiceMode: mode,
    billingBps:
      mode === "billing_software"
        ? plan.billingSoftwareBps
        : mode === "managed_billing"
          ? plan.managedBillingBps
          : 0,
    contractStartOn: contract.contractStartOn,
    contractTermMonths: plan.contractTermMonths,
    contractEndsOn: addMonthsIso(contract.contractStartOn, plan.contractTermMonths),
    perUserPriceCents: plan.perUserPriceCents,
    bands: bandViews(bands),
    billingSoftwareBps: plan.billingSoftwareBps,
    managedBillingBps: plan.managedBillingBps,
    implementationFeeCents: plan.implementationFeeCents,
    minimumMonthlyCents: plan.minimumMonthlyCents,
  };
}

const platformViewOf = (
  contract: ContractRow,
  plan: PlanRow,
  bands: readonly { minAdc: number; monthlyFeeCents: number }[],
): PlatformContractView => ({
  ...contractViewOf(contract, plan, bands),
  signedByMembershipId: contract.signedByMembershipId,
  signedReason: contract.signedReason,
  orderFormRef: contract.orderFormRef,
});

/** The contract of an org with its plan and bands, newest contract first. Works on a tenant or a platform transaction. */
async function loadContract(tx: WriteTx, organizationId: string) {
  const [row] = await tx
    .select({ contract: SC, plan: PL })
    .from(SC)
    .innerJoin(PL, eq(PL.id, SC.planId))
    .where(eq(SC.organizationId, organizationId))
    .orderBy(desc(SC.createdAt))
    .limit(1);
  if (!row) return null;
  const bands = await tx
    .select({ minAdc: PCB.minAdc, monthlyFeeCents: PCB.monthlyFeeCents })
    .from(PCB)
    .where(eq(PCB.planId, row.plan.id))
    .orderBy(asc(PCB.minAdc));
  return { ...row, bands };
}

/**
 * The billing service mode of the org's contracted subscription (newest contract), or null when it has none. Reads on the TENANT pool
 * under `withOrgContext` (the contract table is SELECT-only to the app role); no cache; a failed read throws and the caller decides
 * (slice 3 fails closed: an unread mode must never read as `none`). This is the body of the `BillingServiceModeReader` seam.
 */
export async function readBillingServiceMode(
  db: DbClient,
  organizationId: string,
): Promise<BillingServiceMode | null> {
  return withOrgContext(db, { organizationId, userId: "" }, async (scoped) => {
    const [row] = await (scoped as unknown as WriteTx)
      .select({ mode: SC.billingServiceMode })
      .from(SC)
      .where(eq(SC.organizationId, organizationId))
      .orderBy(desc(SC.createdAt))
      .limit(1);
    return row?.mode ?? null;
  });
}

export function buildContractService(deps: ContractServiceDeps): ContractService {
  const now = deps.now ?? (() => new Date());
  const platformRunner = deps.platformRunner ?? failClosedPlatformRunner;

  return {
    async createForTenant(actor, orgSlug, input) {
      const reason = normalizeReason(input.reason);
      const orderFormRef = normalizeOptionalRef("orderFormRef", input.orderFormRef, ORDER_REF_MAX);
      const audit = requireAuditPort(deps.audit);
      const onboarding = requireOnboardingPort(deps.onboarding);
      if (!deps.outbox) {
        throw new ChartWardenError(
          "OUTBOX_UNBOUND",
          "the subscription event publisher is not bound; refusing to create a subscription without its event",
          503,
        );
      }
      const outbox = deps.outbox;

      // The wizard's strict sequence is judged BEFORE anything is written.
      const step = await onboarding.planContractStep(orgSlug);
      if (!step) throw new NotFoundError("tenant");
      if (step.lockedBy !== null) {
        throw new ChartWardenError(
          "ONBOARDING_STEP_OUT_OF_ORDER",
          `an earlier onboarding step is not finished yet: ${step.lockedBy}. Steps must be completed in order.`,
          409,
          [
            {
              field: "templateKey",
              code: step.lockedBy,
              message: `${step.lockedBy} must be done or skipped first`,
            },
          ],
        );
      }

      const created = await platformRunner(async (tx) => {
        const tenant = await onboarding.enter(tx, orgSlug);
        if (!tenant) throw new NotFoundError("tenant");
        if (!SIGNABLE_TENANT_STATUSES.has(tenant.status)) {
          throw new ChartWardenError(
            "TENANT_NOT_ONBOARDING",
            `a subscription can be created only while the tenant is provisioning or onboarding (it is ${tenant.status})`,
            409,
          );
        }
        const [plan] = await tx.select().from(PL).where(eq(PL.slug, input.planSlug)).limit(1);
        if (!plan || plan.tier !== "census_banded") throw new NotFoundError("plan not found");
        if (plan.publishedAt === null || !plan.isActive) {
          throw new ConflictError(
            "that plan version is not offered; pick a published, current version",
          );
        }

        const [existing] = await tx
          .select({ id: SUB.id, status: SUB.status })
          .from(SUB)
          .where(and(eq(SUB.organizationId, tenant.organizationId), ne(SUB.status, "canceled")))
          .limit(1);
        if (existing) {
          const found = await loadContract(tx, tenant.organizationId);
          const same =
            found !== null &&
            found.contract.subscriptionId === existing.id &&
            found.plan.id === plan.id &&
            found.contract.billingServiceMode === input.billingServiceMode;
          if (!same || !found) {
            throw new ChartWardenError(
              "SUBSCRIPTION_EXISTS",
              "this organization already has a subscription; cancel it before signing a different plan or mode",
              409,
            );
          }
          return {
            tenant,
            view: platformViewOf(found.contract, found.plan, found.bands),
            resumed: true,
          };
        }

        const at = now();
        const [sub] = await tx
          .insert(SUB)
          .values({
            organizationId: tenant.organizationId,
            planId: plan.id,
            status: "active",
            startedAt: at,
          })
          .returning();
        if (!sub)
          throw new ChartWardenError(
            "PERSIST_FAILED",
            "the subscription write returned no row",
            500,
          );
        await tx.insert(SH).values({
          subscriptionId: sub.id,
          organizationId: tenant.organizationId,
          fromStatus: null,
          toStatus: "active",
          transitionedAt: at,
          // NULL, as for every system transition: this row (and its audit copy) is tenant-readable, and the operator behind the
          // contract is named only in the platform-scoped structured audit row written in the same transaction.
          actorMembershipId: null,
          reasonCode: "platform_onboarding_contract",
        });
        const [contract] = await tx
          .insert(SC)
          .values({
            organizationId: tenant.organizationId,
            subscriptionId: sub.id,
            planId: plan.id,
            billingServiceMode: input.billingServiceMode,
            contractStartOn: utcDateOf(at),
            signedByMembershipId: actor.membershipId,
            signedReason: reason,
            orderFormRef,
          })
          .returning();
        if (!contract)
          throw new ChartWardenError("PERSIST_FAILED", "the contract write returned no row", 500);
        await outbox.publish(tx, {
          eventName: "m35.subscription.created",
          payload: {
            subscriptionId: sub.id,
            organizationId: tenant.organizationId,
            planSlug: plan.slug,
            startedAt: at.toISOString(),
          },
          organizationId: tenant.organizationId,
          aggregateKind: "subscription",
          aggregateId: sub.id,
        });
        await audit.record(tx, {
          eventType: "m35.subscription.contract_signed",
          resourceKind: "subscription",
          resourceId: sub.id,
          organizationId: tenant.organizationId,
          operator: { userId: actor.userId, membershipId: actor.membershipId },
          reason,
          detail: {
            planSlug: plan.slug,
            planVersion: plan.version,
            billingServiceMode: input.billingServiceMode,
            tenantStatus: tenant.status,
          },
        });
        const bands = await tx
          .select({ minAdc: PCB.minAdc, monthlyFeeCents: PCB.monthlyFeeCents })
          .from(PCB)
          .where(eq(PCB.planId, plan.id))
          .orderBy(asc(PCB.minAdc));
        return { tenant, view: platformViewOf(contract, plan, bands), resumed: false };
      });

      return {
        contract: created.view,
        resumed: created.resumed,
        planContractStep: await settlePlanContract(
          onboarding,
          orgSlug,
          created.tenant.status,
          step.status,
          created.view,
          actor,
          reason,
          deps.log,
        ),
      };
    },

    async setBillingServiceMode(actor, orgSlug, mode, reasonRaw) {
      const reason = normalizeReason(reasonRaw);
      const audit = requireAuditPort(deps.audit);
      const onboarding = requireOnboardingPort(deps.onboarding);
      return platformRunner(async (tx) => {
        const tenant = await onboarding.enter(tx, orgSlug);
        if (!tenant) throw new NotFoundError("tenant");
        const found = await loadContract(tx, tenant.organizationId);
        if (!found) throw new NotFoundError("this organization has no contracted subscription");
        if (found.contract.billingServiceMode === mode) {
          return platformViewOf(found.contract, found.plan, found.bands);
        }
        const [updated] = await tx
          .update(SC)
          .set({ billingServiceMode: mode, updatedAt: now() })
          .where(eq(SC.id, found.contract.id))
          .returning();
        if (!updated)
          throw new ChartWardenError("PERSIST_FAILED", "the contract update returned no row", 500);
        await audit.record(tx, {
          eventType: "m35.subscription.billing_service_mode_changed",
          resourceKind: "subscription",
          resourceId: updated.subscriptionId,
          organizationId: tenant.organizationId,
          operator: { userId: actor.userId, membershipId: actor.membershipId },
          reason,
          detail: { from: found.contract.billingServiceMode, to: mode },
        });
        return platformViewOf(updated, found.plan, found.bands);
      });
    },

    async platformView(orgSlug) {
      const onboarding = requireOnboardingPort(deps.onboarding);
      return platformRunner(async (tx) => {
        const tenant = await onboarding.enter(tx, orgSlug);
        if (!tenant) throw new NotFoundError("tenant");
        const found = await loadContract(tx, tenant.organizationId);
        if (!found) return { contract: null, statements: [] };
        const rows = await tx
          .select()
          .from(SS)
          .where(eq(SS.organizationId, tenant.organizationId))
          .orderBy(desc(SS.periodYearMonth))
          .limit(STATEMENTS_ON_PLATFORM_VIEW);
        return {
          contract: platformViewOf(found.contract, found.plan, found.bands),
          statements: rows.map((r) => toStatementView(r, found.plan.currencyCode)),
        };
      });
    },

    async tenantView(organizationId, userId) {
      return withOrgContext(deps.db, { organizationId, userId }, async (scoped) => {
        const tx = scoped as unknown as WriteTx;
        const found = await loadContract(tx, organizationId);
        if (!found) return { contract: null, latestStatement: null };
        const [latest] = await tx
          .select()
          .from(SS)
          .where(eq(SS.organizationId, organizationId))
          .orderBy(desc(SS.periodYearMonth))
          .limit(1);
        return {
          // The tenant reads the terms, never the operator behind them (no membership id, reason or order reference).
          contract: contractViewOf(found.contract, found.plan, found.bands),
          latestStatement: latest ? toStatementView(latest, found.plan.currencyCode) : null,
        };
      });
    },

    billingServiceModeForOrg: (organizationId) => readBillingServiceMode(deps.db, organizationId),
  };
}

/** Settle the wizard's `plan_contract` step with the contract as evidence; never throws (the subscription is already committed). */
async function settlePlanContract(
  onboarding: OnboardingPricingPort,
  orgSlug: string,
  tenantStatus: string,
  stepStatus: string,
  view: PlatformContractView,
  actor: M35WriteActor,
  reason: string,
  log: ContractServiceDeps["log"],
): Promise<PlanContractSettlement> {
  if (stepStatus === "done" || stepStatus === "skipped") return { status: "already_settled" };
  if (tenantStatus !== "onboarding") return { status: "pending", reason: "tenant_not_onboarding" };
  const evidenceNote = [
    `Plan ${view.plan.slug} (${view.plan.name}) contracted for ${view.contractTermMonths} months from ${view.contractStartOn}.`,
    `Billing service: ${view.billingServiceMode}.`,
    `Order form: ${view.orderFormRef ?? "not recorded"}.`,
  ].join(" ");
  try {
    // The evidence reference is the plan version, never the subscription id: a uuid can happen to look like an SSN to the wizard's PHI
    // screen, and a step must not fail to settle on a coincidence. The subscription is findable from the tenant.
    await onboarding.attestPlanContract({
      orgSlug,
      operator: { userId: actor.userId, membershipId: actor.membershipId },
      evidenceNote,
      evidenceRef: `plan:${view.plan.slug}`,
      reason,
    });
    return { status: "settled" };
  } catch (error) {
    const code = error instanceof ChartWardenError ? error.code : "INTERNAL_ERROR";
    log?.("m35 plan_contract step could not be settled after the subscription was created", {
      step: PLAN_CONTRACT_STEP_KEY,
      errorCode: code,
    });
    return { status: "pending", reason: code };
  }
}
