// apps/backend/src/modules/35-subscription/pricing/contract-service.ts — a tenant's CONTRACT (slice 2, tenant pricing).
//
// ONBOARDING STEP 2 (`plan_contract`). A platform operator signs the tenant onto a published census_banded plan VERSION and picks the
// billing service mode. In ONE platform transaction this takes the shared onboarding lock, checks the tenant is still provisioning or
// onboarding, creates the subscription, its state-history row, the signed `subscription_contract` and its first billing-mode row, the
// `m35.subscription.created` event and a structured audit row (operator, tenant, reason). It then settles the wizard's `plan_contract`
// step THROUGH THE WIZARD (the `OnboardingPricingPort`: the same attest operation, strict sequence and evidence rules every step has).
// Order matters:
//   * BEFORE anything is written the step is read, and a step locked behind an earlier one refuses (409 ONBOARDING_STEP_OUT_OF_ORDER):
//     the sequential wizard stays sequential, and nothing is created that cannot be settled in turn;
//   * AFTER the commit the step is attested with the contract as evidence. If that fails (the tenant moved, a concurrent change) the
//     subscription stays and the response says the step is `pending`: the same POST then RESUMES (an existing subscription on the same
//     plan and mode is reused, never duplicated) and attests again. The step is `either`-attestable by an operator at any time too.
//
// The billing service mode is an effective-dated history (./contract-mode.ts): a change recorded here takes effect from the 1st of the
// NEXT month, and immediately only while the tenant is still onboarding with no statement yet. A statement prices with the mode in force
// for its period, so a closed or running month keeps the mode it started with.
//
// Which contract an org "has" is decided in ONE place (./contract-select.ts), not here.
import { type DbClient, schema } from "@chartwarden/db";
import { mapUniqueViolation } from "@chartwarden/shared/route-kit";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import type { BillingServiceMode } from "@chartwarden/types";
import { ChartWardenError, ConflictError, NotFoundError } from "@chartwarden/types";
import { desc, eq } from "drizzle-orm";
import { refuseForeignAmbientOrg } from "../../../bootstrap/ambient-org-guard";
import { currentSubscriptionOrder } from "../routes/current-subscription";
import type { M35WriteActor } from "../routes/service";
import type { PlatformRunner, WriteOutboxPort, WriteTx } from "../routes/service-drizzle";
import { utcDateOf } from "./census-daily";
import {
  type ModeHistoryRow,
  modeChangeEffectiveOn,
  modeInForceOn,
  nextModeCreatedAt,
  pendingModeAfter,
} from "./contract-mode";
import { type ContractRecord, selectNewestContract } from "./contract-select";
import {
  type PlanRow,
  type PlatformContractView,
  type PlatformPricingView,
  type TenantPricingView,
  contractViewOf,
  loadContract,
  loadSignature,
  lockSubscriptionAndReloadHistory,
  platformViewOf,
} from "./contract-view";
import { SYSTEM_TRIGGER } from "./mode-trigger";
import { loadBands } from "./plan-service";
import {
  type ModeTrigger,
  type OnboardingPricingPort,
  type OnboardingTenantFacts,
  PLAN_CONTRACT_STEP_KEY,
  type PlatformAuditPort,
  failClosedPlatformRunner,
  requireAuditPort,
  requireOnboardingPort,
} from "./ports";
import { toStatementView } from "./statement-view";

export {
  type ContractView,
  type PlatformContractView,
  type PlatformPricingView,
  type TenantPricingView,
  addMonthsIso,
} from "./contract-view";
import { normalizeOptionalRef, normalizeReason } from "./text";

const PL = schema.plan;
const SC = schema.subscriptionContract;
const SCM = schema.subscriptionContractMode;
const SUB = schema.subscriptionRow;
const SH = schema.subscriptionStateHistory;
const SS = schema.subscriptionStatement;

const ORDER_REF_MAX = 500;
const STATEMENTS_ON_PLATFORM_VIEW = 12;
/** Tenant statuses in which a subscription may be created for it. */
const SIGNABLE_TENANT_STATUSES: ReadonlySet<string> = new Set(["provisioning", "onboarding"]);

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
  /**
   * An operator's change of the billing service mode. A tenant that bills outside ChartWarden is on `none` and stays there (the
   * invariant the system's outside-means-none sync and sweep rely on): any other mode for it is a 409 BILLING_MODE_REQUIRES_NONE_WHILE_OUTSIDE,
   * so a sweep can never silently undo what an operator set. The one exception is the operator's own switch OUT of outside, which sets
   * the mode first, then the vendor (`opts.leavingOutside`, passed only by that flow).
   */
  setBillingServiceMode(
    actor: M35WriteActor,
    orgSlug: string,
    mode: BillingServiceMode,
    reason: unknown,
    opts?: { readonly leavingOutside?: boolean },
  ): Promise<PlatformContractView>;
  /**
   * Whether the org holds a contract that is not canceled (live or PAUSED), read on the tenant pool. A paused contract is still the
   * tenant's: it bills again on resume, so the billing mode that must follow its clearinghouse choice is judged against it too. Where
   * there is none, no billing mode is ever invented.
   */
  hasContract(organizationId: string): Promise<boolean>;
  /**
   * Slice 5: a tenant that bills outside ChartWarden pays no billing percentage. Sets the org's billing service mode to `none` as a
   * SYSTEM action (no operator), dated like any mode change: at once while the tenant is onboarding with nothing billed, else from
   * the 1st of next month. Idempotent: `changed:false` when there is no contract, or when `none` is already in force or already
   * pending. Audited with the reason and `trigger: clearinghouse_outside`; `trigger` says who set it off (the tenant's own request, a
   * platform operator's, or a sweep) and joins the row to that request's correlation id. The mode is read on the tenant pool first, so
   * a no-op (the common case: every settle asks) never enters the platform runner and never leaves a platform bypass audit row.
   */
  setModeNoneForOutsideBilling(
    organizationId: string,
    trigger?: ModeTrigger,
  ): Promise<{ readonly changed: boolean }>;
  /** A platform operator's read of a tenant's contract and statements; it writes a structured read-audit row naming the operator. */
  platformView(actor: M35WriteActor, orgSlug: string): Promise<PlatformPricingView>;
  tenantView(organizationId: string, userId: string): Promise<TenantPricingView>;
  /** The current live billing-service mode on the tenant pool, or null without a live contract. */
  billingServiceModeForOrg(organizationId: string): Promise<BillingServiceMode | null>;
}

export interface ContractServiceDeps {
  readonly db: DbClient;
  readonly platformRunner?: PlatformRunner;
  readonly outbox?: WriteOutboxPort;
  readonly audit?: PlatformAuditPort;
  readonly onboarding?: OnboardingPricingPort;
  /**
   * Whether the org's clearinghouse is `outside`, read lazily by the composition root over M23's choice. It guards the invariant "outside
   * means billing mode none" (an operator's other mode is refused) and is re-asked INSIDE the write of the system's outside-means-none
   * change, after the lock, so a switch to a vendor that landed meanwhile is never overwritten. Absent = nothing is checked.
   */
  readonly billsOutside?: (organizationId: string) => Promise<boolean>;
  readonly now?: () => Date;
  readonly log?: (message: string, detail: Record<string, unknown>) => void;
}

/** Who a system action is attributed to in the platform audit trail (no person acted). */
const SYSTEM_OPERATOR = { userId: "system", membershipId: "system" } as const;

/** Whether the org has a contract that is not canceled (live or paused), on the given org-scoped or platform transaction. */
export async function orgHasContract(
  tx: WriteTx,
  organizationId: string,
  at: Date = new Date(),
): Promise<boolean> {
  return (await selectNewestContract(tx, "current", at, organizationId)) !== null;
}

/** The billing service mode in force today for the newest live contract, on the tenant pool. */
export async function readBillingServiceMode(
  db: DbClient,
  organizationId: string,
  at: Date = new Date(),
): Promise<BillingServiceMode | null> {
  refuseForeignAmbientOrg(organizationId, "BillingServiceModeReader");
  return withOrgContext(db, { organizationId, userId: "" }, async (scoped) => {
    const loaded = await loadContract(scoped as unknown as WriteTx, "live", at, organizationId);
    return loaded ? modeInForceOn(loaded.history, utcDateOf(at)) : null;
  });
}

async function requirePlan(tx: WriteTx, planSlug: string): Promise<PlanRow> {
  const [plan] = await tx.select().from(PL).where(eq(PL.slug, planSlug)).limit(1);
  // An unknown slug and a non-contracted one answer the same 404: a probe cannot tell the census plans from nothing.
  if (!plan || plan.tier !== "census_banded") throw new NotFoundError("plan not found");
  if (plan.publishedAt === null || !plan.isActive) {
    throw new ConflictError("that plan version is not offered; pick a published, current version");
  }
  return plan;
}

interface SignedContract {
  readonly view: PlatformContractView;
  readonly resumed: boolean;
}

/** The org's not-canceled subscription already on this plan and mode is RESUMED; one on anything else is refused; none returns null. */
async function resumeIfSigned(
  tx: WriteTx,
  tenant: OnboardingTenantFacts,
  plan: PlanRow,
  mode: BillingServiceMode,
  at: Date,
): Promise<SignedContract | null> {
  const subs = await tx
    .select()
    .from(SUB)
    .where(eq(SUB.organizationId, tenant.organizationId))
    .orderBy(...currentSubscriptionOrder());
  const open = subs.find((s) => s.status !== "canceled");
  if (!open) return null;
  const found = await loadContract(tx, "live", at, tenant.organizationId);
  const today = utcDateOf(at);
  const same =
    found !== null &&
    found.record.contract.subscriptionId === open.id &&
    found.record.plan.id === plan.id &&
    modeInForceOn(found.history, today) === mode;
  if (!found || !same) throw subscriptionExists();
  const signature = await loadSignature(tx, found.record.contract.id);
  return {
    view: platformViewOf(found.record, found.bands, found.history, today, signature),
    resumed: true,
  };
}

interface SignContext {
  readonly actor: M35WriteActor;
  readonly tenant: OnboardingTenantFacts;
  readonly plan: PlanRow;
  readonly mode: BillingServiceMode;
  readonly orderFormRef: string | null;
  readonly reason: string;
  readonly at: Date;
  readonly outbox: WriteOutboxPort;
  readonly audit: PlatformAuditPort;
}

/** Create the subscription, its history row, the signed contract and its first billing mode. */
async function insertContractRows(tx: WriteTx, ctx: SignContext) {
  const { actor, tenant, plan, at } = ctx;
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
    throw new ChartWardenError("PERSIST_FAILED", "the subscription write returned no row", 500);
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
      contractStartOn: utcDateOf(at),
      signedByMembershipId: actor.membershipId,
      signedReason: ctx.reason,
      orderFormRef: ctx.orderFormRef,
    })
    .returning();
  if (!contract)
    throw new ChartWardenError("PERSIST_FAILED", "the contract write returned no row", 500);
  const [first] = await tx
    .insert(SCM)
    .values({
      organizationId: tenant.organizationId,
      contractId: contract.id,
      billingServiceMode: ctx.mode,
      effectiveFrom: utcDateOf(at),
    })
    .returning();
  if (!first) throw new ChartWardenError("PERSIST_FAILED", "the mode write returned no row", 500);
  return { sub, contract, first };
}

/** The event and the structured audit row of a signing, in the signing's own transaction. */
async function recordSigning(tx: WriteTx, ctx: SignContext, subscriptionId: string): Promise<void> {
  const { actor, tenant, plan } = ctx;
  await ctx.outbox.publish(tx, {
    eventName: "m35.subscription.created",
    payload: {
      subscriptionId,
      organizationId: tenant.organizationId,
      planSlug: plan.slug,
      startedAt: ctx.at.toISOString(),
    },
    organizationId: tenant.organizationId,
    aggregateKind: "subscription",
    aggregateId: subscriptionId,
  });
  await ctx.audit.record(tx, {
    eventType: "m35.subscription.contract_signed",
    resourceKind: "subscription",
    resourceId: subscriptionId,
    organizationId: tenant.organizationId,
    operator: { userId: actor.userId, membershipId: actor.membershipId },
    reason: ctx.reason,
    detail: {
      planSlug: plan.slug,
      planVersion: plan.version,
      billingServiceMode: ctx.mode,
      tenantStatus: tenant.status,
    },
  });
}

/** Sign a tenant onto a plan: subscription, history, contract, first mode, event and audit row, all in the caller's transaction. */
async function signContract(tx: WriteTx, ctx: SignContext): Promise<SignedContract> {
  const { sub, contract, first } = await insertContractRows(tx, ctx);
  await recordSigning(tx, ctx, sub.id);
  const history: ModeHistoryRow[] = [
    {
      id: first.id,
      billingServiceMode: first.billingServiceMode,
      effectiveFrom: first.effectiveFrom,
      createdAt: first.createdAt,
    },
  ];
  const view = platformViewOf(
    { contract, sub, plan: ctx.plan },
    await loadBands(tx, ctx.plan.id),
    history,
    utcDateOf(ctx.at),
    contract, // the row just inserted on the carrier carries its signature columns
  );
  return { view, resumed: false };
}

/** Record a mode change as a new dated row: today while onboarding with no statement yet, else the 1st of the next month. */
async function insertModeChange(
  tx: WriteTx,
  tenant: OnboardingTenantFacts,
  record: ContractRecord,
  mode: BillingServiceMode,
  at: Date,
  createdAt: Date,
) {
  const [statement] = await tx
    .select({ id: SS.id })
    .from(SS)
    .where(eq(SS.subscriptionId, record.sub.id))
    .limit(1);
  const effectiveOn = modeChangeEffectiveOn(at, {
    tenantIsLive: !SIGNABLE_TENANT_STATUSES.has(tenant.status),
    hasStatement: statement !== undefined,
  });
  const [row] = await tx
    .insert(SCM)
    .values({
      organizationId: tenant.organizationId,
      contractId: record.contract.id,
      billingServiceMode: mode,
      effectiveFrom: effectiveOn,
      createdAt,
    })
    .returning();
  if (!row) throw new ChartWardenError("PERSIST_FAILED", "the mode write returned no row", 500);
  return { row, effectiveOn };
}

const subscriptionExists = (): ChartWardenError =>
  new ChartWardenError(
    "SUBSCRIPTION_EXISTS",
    "this organization already has a subscription; cancel it before signing a different plan or mode",
    409,
  );

/** A subscription can be created only while the tenant is provisioning or onboarding. */
function refuseUnsignableTenant(tenant: OnboardingTenantFacts): void {
  if (SIGNABLE_TENANT_STATUSES.has(tenant.status)) return;
  throw new ChartWardenError(
    "TENANT_NOT_ONBOARDING",
    `a subscription can be created only while the tenant is provisioning or onboarding (it is ${tenant.status})`,
    409,
  );
}

/** Refuse before anything is written when the wizard's strict sequence has not reached the step. */
function refuseLockedStep(lockedBy: string | null): void {
  if (lockedBy === null) return;
  throw new ChartWardenError(
    "ONBOARDING_STEP_OUT_OF_ORDER",
    `an earlier onboarding step is not finished yet: ${lockedBy}. Steps must be completed in order.`,
    409,
    [
      {
        field: "templateKey",
        code: lockedBy,
        message: `${lockedBy} must be done or skipped first`,
      },
    ],
  );
}

export function buildContractService(deps: ContractServiceDeps): ContractService {
  const now = deps.now ?? (() => new Date());
  const platformRunner = deps.platformRunner ?? failClosedPlatformRunner;

  /** The audit and outbox ports, or a refusal: a signing that cannot be audited or announced is refused. */
  function requireSigningPorts(): { audit: PlatformAuditPort; outbox: WriteOutboxPort } {
    const audit = requireAuditPort(deps.audit);
    if (!deps.outbox) {
      throw new ChartWardenError(
        "OUTBOX_UNBOUND",
        "the subscription event publisher is not bound; refusing to create a subscription without its event",
        503,
      );
    }
    return { audit, outbox: deps.outbox };
  }

  return {
    async createForTenant(actor, orgSlug, input) {
      const reason = normalizeReason(input.reason);
      const orderFormRef = normalizeOptionalRef("orderFormRef", input.orderFormRef, ORDER_REF_MAX);
      const { audit, outbox } = requireSigningPorts();
      const onboarding = requireOnboardingPort(deps.onboarding);

      // The wizard's strict sequence is judged BEFORE anything is written.
      const step = await onboarding.planContractStep(orgSlug);
      if (!step) throw new NotFoundError("tenant");
      refuseLockedStep(step.lockedBy);

      const created = await platformRunner(async (tx) => {
        const tenant = await onboarding.enter(tx, orgSlug);
        if (!tenant) throw new NotFoundError("tenant");
        refuseUnsignableTenant(tenant);
        const plan = await requirePlan(tx, input.planSlug);
        const at = now();
        const signed =
          (await resumeIfSigned(tx, tenant, plan, input.billingServiceMode, at)) ??
          (await signContract(tx, {
            actor,
            tenant,
            plan,
            mode: input.billingServiceMode,
            orderFormRef,
            reason,
            at,
            outbox,
            audit,
          }));
        return { tenant, ...signed };
      }).catch((error: unknown) => {
        // a subscription written by another path (the tenant's own, which holds no onboarding lock) between the read above and the insert
        throw mapUniqueViolation(error, {
          subscription_org_active_uq: subscriptionExists,
          subscription_contract_subscription_uq: subscriptionExists,
        });
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

    async setBillingServiceMode(actor, orgSlug, mode, reasonRaw, opts = {}) {
      const reason = normalizeReason(reasonRaw);
      const audit = requireAuditPort(deps.audit);
      const onboarding = requireOnboardingPort(deps.onboarding);
      return platformRunner(async (tx) => {
        const tenant = await onboarding.enter(tx, orgSlug);
        if (!tenant) throw new NotFoundError("tenant");
        const at = now();
        const today = utcDateOf(at);
        // The switch out of outside names the mode for a PAUSED contract too (it is the tenant's, and bills again on resume); the
        // ordinary mode route stays on a live one.
        const loaded = await loadContract(
          tx,
          opts.leavingOutside ? "current" : "live",
          at,
          tenant.organizationId,
        );
        if (!loaded) throw new NotFoundError("this organization has no contracted subscription");
        const found = await lockSubscriptionAndReloadHistory(tx, loaded);
        const { record } = found;
        // "Outside means none" is the invariant: a billing mode on a tenant that bills outside would be undone by the next sync or sweep.
        if (
          mode !== "none" &&
          !opts.leavingOutside &&
          (await deps.billsOutside?.(tenant.organizationId))
        ) {
          throw new ChartWardenError(
            "BILLING_MODE_REQUIRES_NONE_WHILE_OUTSIDE",
            "this tenant bills outside ChartWarden, so its billing service mode is none; switch its clearinghouse to a vendor first (the operator sets the mode in that same step)",
            409,
          );
        }
        const current = modeInForceOn(found.history, today);
        const pending = pendingModeAfter(found.history, today);
        // A request for the mode that will be in force anyway is a no-op; anything else is a new dated row (it supersedes a pending one).
        const signature = await loadSignature(tx, record.contract.id);
        if (mode === (pending?.billingServiceMode ?? current)) {
          return platformViewOf(record, found.bands, found.history, today, signature);
        }
        const { row, effectiveOn } = await insertModeChange(
          tx,
          tenant,
          record,
          mode,
          at,
          nextModeCreatedAt(at, found.history),
        );
        await audit.record(tx, {
          eventType: "m35.subscription.billing_service_mode_changed",
          resourceKind: "subscription",
          resourceId: record.sub.id,
          organizationId: tenant.organizationId,
          operator: { userId: actor.userId, membershipId: actor.membershipId },
          reason,
          detail: { from: current, to: mode, effectiveOn },
        });
        const history: ModeHistoryRow[] = [
          ...found.history,
          {
            id: row.id,
            billingServiceMode: row.billingServiceMode,
            effectiveFrom: row.effectiveFrom,
            createdAt: row.createdAt,
          },
        ];
        return platformViewOf(record, found.bands, history, today, signature);
      });
    },

    async setModeNoneForOutsideBilling(organizationId, trigger = SYSTEM_TRIGGER) {
      const audit = requireAuditPort(deps.audit);
      const onboarding = requireOnboardingPort(deps.onboarding);
      // Most calls change nothing (every clearinghouse settle asks): decide that on the tenant pool, where no platform bypass is recorded.
      const at0 = now();
      const needsChange = await withOrgContext(
        deps.db,
        systemOrgContext(organizationId),
        async (scoped) => {
          const seen = await loadContract(
            scoped as unknown as WriteTx,
            "current",
            at0,
            organizationId,
          );
          if (!seen) return false;
          const today0 = utcDateOf(at0);
          return (
            (pendingModeAfter(seen.history, today0)?.billingServiceMode ??
              modeInForceOn(seen.history, today0)) !== "none"
          );
        },
      );
      if (!needsChange) return { changed: false };
      return platformRunner(async (tx) => {
        const tenant = await onboarding.enterByOrg(tx, organizationId);
        if (!tenant) return { changed: false };
        const at = now();
        const today = utcDateOf(at);
        const loaded = await loadContract(tx, "current", at, tenant.organizationId);
        if (!loaded) return { changed: false }; // a mode is never invented for a tenant that has no contract
        const found = await lockSubscriptionAndReloadHistory(tx, loaded);
        // Asked AGAIN here, after the lock: a switch to a vendor (with the operator's mode) that landed since the caller decided must
        // never be overwritten with none.
        if (deps.billsOutside && !(await deps.billsOutside(organizationId)))
          return { changed: false };
        const current = modeInForceOn(found.history, today);
        const pending = pendingModeAfter(found.history, today);
        if ((pending?.billingServiceMode ?? current) === "none") return { changed: false };
        const { effectiveOn } = await insertModeChange(
          tx,
          tenant,
          found.record,
          "none",
          at,
          nextModeCreatedAt(at, found.history),
        );
        await audit.record(tx, {
          eventType: "m35.subscription.billing_service_mode_changed",
          resourceKind: "subscription",
          resourceId: found.record.sub.id,
          organizationId: tenant.organizationId,
          operator: SYSTEM_OPERATOR,
          reason: "the tenant bills outside ChartWarden, so it pays no billing percentage",
          detail: {
            from: current,
            to: "none",
            effectiveOn,
            trigger: "clearinghouse_outside",
            triggeredBy: trigger.kind,
            triggeredByUserId: trigger.userId,
            triggeredByMembershipId: trigger.membershipId,
          },
          ...(trigger.correlationId ? { correlationId: trigger.correlationId } : {}),
        });
        return { changed: true };
      });
    },

    async hasContract(organizationId) {
      const at = now();
      return withOrgContext(deps.db, systemOrgContext(organizationId), (scoped) =>
        orgHasContract(scoped as unknown as WriteTx, organizationId, at),
      );
    },

    async platformView(actor, orgSlug) {
      const onboarding = requireOnboardingPort(deps.onboarding);
      const audit = requireAuditPort(deps.audit);
      return platformRunner(async (tx) => {
        const tenant = await onboarding.enter(tx, orgSlug);
        if (!tenant) throw new NotFoundError("tenant");
        const at = now();
        const found = await loadContract(tx, "latest", at, tenant.organizationId);
        // FAIL-CLOSED read audit, in the read's own transaction: an operator reading a tenant's contract and bills is on the record
        // (operator, tenant) or does not read at all. The row carries ids only, never a figure.
        await audit.record(tx, {
          eventType: "m35.subscription.platform_viewed",
          resourceKind: "subscription",
          resourceId: found?.record.sub.id ?? tenant.organizationId,
          organizationId: tenant.organizationId,
          operator: { userId: actor.userId, membershipId: actor.membershipId },
          reason: "platform read of a tenant's pricing",
          detail: { hasContract: found !== null },
        });
        if (!found) return { contract: null, statements: [] };
        const rows = await tx
          .select()
          .from(SS)
          .where(eq(SS.organizationId, tenant.organizationId))
          .orderBy(desc(SS.periodYearMonth))
          .limit(STATEMENTS_ON_PLATFORM_VIEW);
        return {
          contract: platformViewOf(
            found.record,
            found.bands,
            found.history,
            utcDateOf(at),
            await loadSignature(tx, found.record.contract.id),
          ),
          statements: rows.map((r) => toStatementView(r, found.record.plan.currencyCode)),
        };
      });
    },

    async tenantView(organizationId, userId) {
      return withOrgContext(deps.db, { organizationId, userId }, async (scoped) => {
        const tx = scoped as unknown as WriteTx;
        const at = now();
        const found = await loadContract(tx, "latest", at, organizationId);
        if (!found) return { contract: null, latestStatement: null };
        const [latest] = await tx
          .select()
          .from(SS)
          .where(eq(SS.organizationId, organizationId))
          .orderBy(desc(SS.periodYearMonth))
          .limit(1);
        return {
          // The tenant reads the terms, never the operator behind them (no membership id, reason or order reference).
          contract: contractViewOf(found.record, found.bands, found.history, utcDateOf(at)),
          latestStatement: latest ? toStatementView(latest, found.record.plan.currencyCode) : null,
        };
      });
    },

    billingServiceModeForOrg: (organizationId) =>
      readBillingServiceMode(deps.db, organizationId, now()),
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
  // The wizard's evidence note is TENANT-READABLE (the onboarding view), so it carries the plan and the term but never the order-form
  // reference: that, like who signed and why, is for the platform alone.
  const evidenceNote = [
    `Plan ${view.plan.slug} (${view.plan.name}) contracted for ${view.contractTermMonths} months from ${view.contractStartOn}.`,
    `Billing service: ${view.billingServiceMode}.`,
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
