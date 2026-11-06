// apps/backend/src/modules/35-subscription/pricing/plan-service.ts — the PLAN EDITOR for the contracted census_banded model (slice 2).
//
// A plan row is one VERSION. Draft -> published -> archived:
//   draft      editable (create, replace its prices and bands); never offered, never signable
//   published  FROZEN for good (the `plan_census_guard` trigger refuses any change to its prices or bands) and offered to onboarding;
//              this is what makes "a subscription keeps the price it signed" a database fact, not a convention
//   archived   no longer offered (is_active false, deprecated_at); every subscription already on it keeps running at its price
// A price change is a NEW VERSION (`new-version` copies a published or archived row into a draft that supersedes it). Nothing here
// knows a dollar amount: the owner edits plans, and the default band thresholds are only a starting point for a form.
//
// Every write runs on the platform runner, validates with the same pure rules the math uses, takes the operator and a reason, and
// writes one structured audit row beside the row-level audit trigger. The legacy flat-tier routes (`/api/admin/plans`) cannot create
// or publish a census_banded plan, so none of these rules can be bypassed through them.
import { schema } from "@chartwarden/db";
import {
  type CensusBand,
  type PlanPricing,
  type PricingIssue,
  validatePlanPricing,
} from "@chartwarden/subscription-billing";
import {
  ChartWardenError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@chartwarden/types";
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import type { M35WriteActor } from "../routes/actor";
import type { PlatformRunner, WriteTx } from "../routes/service-drizzle";
import { type PlatformAuditPort, failClosedPlatformRunner, requireAuditPort } from "./ports";
import { normalizeOptionalRef, normalizeReason, normalizeRequiredText } from "./text";

const PL = schema.plan;
const PCB = schema.planCensusBand;
const NAME_MAX = 120;
const DESCRIPTION_MAX = 1000;

export interface PricingBandView extends CensusBand {
  /** The last whole patient of the band, or null for the open-ended top band. */
  readonly maxAdc: number | null;
}

export type PricingPlanStatus = "draft" | "published" | "archived";

export interface PricingPlanView {
  readonly id: string;
  readonly familySlug: string;
  readonly version: number;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: PricingPlanStatus;
  /** Offered to onboarding: published and not archived. */
  readonly offered: boolean;
  readonly currencyCode: string;
  readonly perUserPriceCents: number | null;
  readonly bands: readonly PricingBandView[];
  readonly billingSoftwareBps: number | null;
  readonly managedBillingBps: number | null;
  readonly contractTermMonths: number | null;
  readonly implementationFeeCents: number | null;
  readonly minimumMonthlyCents: number | null;
  readonly supersedesPlanId: string | null;
  readonly publishedAt: string | null;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlanPricingInput {
  readonly name: string;
  readonly description?: string | null;
  readonly currencyCode?: string;
  readonly perUserPriceCents: number;
  readonly bands: readonly CensusBand[];
  readonly billingSoftwareBps: number;
  readonly managedBillingBps: number;
  readonly contractTermMonths: number;
  readonly implementationFeeCents: number;
  readonly minimumMonthlyCents: number | null;
}

export interface CreatePricingPlanInput extends PlanPricingInput {
  readonly familySlug: string;
}

export interface PricingPlanService {
  list(): Promise<PricingPlanView[]>;
  get(planId: string): Promise<PricingPlanView>;
  /** Published and still offered: what onboarding may sign. */
  listOffered(): Promise<PricingPlanView[]>;
  create(
    actor: M35WriteActor,
    input: CreatePricingPlanInput,
    reason: unknown,
  ): Promise<PricingPlanView>;
  replaceDraft(
    actor: M35WriteActor,
    planId: string,
    input: PlanPricingInput,
    reason: unknown,
  ): Promise<PricingPlanView>;
  publish(actor: M35WriteActor, planId: string, reason: unknown): Promise<PricingPlanView>;
  newVersion(actor: M35WriteActor, planId: string, reason: unknown): Promise<PricingPlanView>;
  archive(actor: M35WriteActor, planId: string, reason: unknown): Promise<PricingPlanView>;
}

export interface PricingPlanServiceDeps {
  readonly platformRunner?: PlatformRunner;
  readonly audit?: PlatformAuditPort;
  readonly now?: () => Date;
}

type PlanRow = typeof PL.$inferSelect;

const statusOf = (p: PlanRow): PricingPlanStatus =>
  p.deprecatedAt ? "archived" : p.publishedAt ? "published" : "draft";

/** Bands in ascending order, each with the last whole patient it covers (null for the open-ended top band). */
export function bandViews(bands: readonly CensusBand[]): PricingBandView[] {
  const ascending = [...bands].sort((a, b) => a.minAdc - b.minAdc);
  return ascending.map((b, i) => ({
    minAdc: b.minAdc,
    monthlyFeeCents: b.monthlyFeeCents,
    maxAdc: ascending[i + 1] ? (ascending[i + 1] as CensusBand).minAdc - 1 : null,
  }));
}

export function toPricingPlanView(p: PlanRow, bands: readonly CensusBand[]): PricingPlanView {
  return {
    id: p.id,
    familySlug: p.familySlug ?? p.slug,
    version: p.version,
    slug: p.slug,
    name: p.name,
    description: p.description,
    status: statusOf(p),
    offered: p.publishedAt !== null && p.isActive,
    currencyCode: p.currencyCode,
    perUserPriceCents: p.perUserPriceCents,
    bands: bandViews(bands),
    billingSoftwareBps: p.billingSoftwareBps,
    managedBillingBps: p.managedBillingBps,
    contractTermMonths: p.contractTermMonths,
    implementationFeeCents: p.implementationFeeCents,
    minimumMonthlyCents: p.minimumMonthlyCents,
    supersedesPlanId: p.supersedesPlanId,
    publishedAt: p.publishedAt?.toISOString() ?? null,
    archivedAt: p.deprecatedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

/** A write that returned no row: a typed 500 (never a bare Error, which the error envelope would not recognise). */
const persistFailed = (what: string): ChartWardenError =>
  new ChartWardenError("PERSIST_FAILED", what, 500);

const failIssues = (issues: readonly PricingIssue[]): never => {
  throw new ValidationError(
    "the plan's prices are not valid",
    issues.map((i) => ({ field: i.field, code: i.code, message: i.message })),
  );
};

/** The plan's bands, ascending. */
export async function loadBands(tx: WriteTx, planId: string): Promise<CensusBand[]> {
  return tx
    .select({ minAdc: PCB.minAdc, monthlyFeeCents: PCB.monthlyFeeCents })
    .from(PCB)
    .where(eq(PCB.planId, planId))
    .orderBy(asc(PCB.minAdc));
}

async function loadView(tx: WriteTx, planId: string): Promise<PricingPlanView> {
  const [plan] = await tx.select().from(PL).where(eq(PL.id, planId)).limit(1);
  if (!plan || plan.tier !== "census_banded") throw new NotFoundError("plan not found");
  return toPricingPlanView(plan, await loadBands(tx, planId));
}

const asPricing = (
  input: PlanPricingInput,
): PlanPricing & {
  readonly contractTermMonths: number;
  readonly implementationFeeCents: number;
} => ({
  perUserPriceCents: input.perUserPriceCents,
  bands: input.bands,
  billingSoftwareBps: input.billingSoftwareBps,
  managedBillingBps: input.managedBillingBps,
  minimumMonthlyCents: input.minimumMonthlyCents,
  contractTermMonths: input.contractTermMonths,
  implementationFeeCents: input.implementationFeeCents,
});

/** The operator-typed text of a plan, cleaned and screened (a plan name lands in the onboarding evidence note: no patient identifier). */
function planText(input: PlanPricingInput): { name: string; description: string | null } {
  return {
    name: normalizeRequiredText("name", input.name, NAME_MAX),
    description: normalizeOptionalRef("description", input.description, DESCRIPTION_MAX),
  };
}

/** The cheapest band's fee: the plan's "from" price, kept in the legacy `base_price_cents` so the MRR snapshot and plan lists read a floor. */
const floorPriceCents = (bands: readonly CensusBand[]): number =>
  [...bands].sort((a, b) => a.minAdc - b.minAdc)[0]?.monthlyFeeCents ?? 0;

export function buildPricingPlanService(deps: PricingPlanServiceDeps): PricingPlanService {
  const now = deps.now ?? (() => new Date());
  const platformRunner = deps.platformRunner ?? failClosedPlatformRunner;
  const audit = (): PlatformAuditPort => requireAuditPort(deps.audit);

  async function record(
    tx: WriteTx,
    actor: M35WriteActor,
    eventType: string,
    plan: Pick<PricingPlanView, "id" | "slug" | "version">,
    reason: string,
  ): Promise<void> {
    await audit().record(tx, {
      eventType,
      resourceKind: "plan",
      resourceId: plan.id,
      organizationId: null,
      operator: { userId: actor.userId, membershipId: actor.membershipId },
      reason,
      detail: { planSlug: plan.slug, version: plan.version },
    });
  }

  async function replaceBands(
    tx: WriteTx,
    planId: string,
    bands: readonly CensusBand[],
  ): Promise<void> {
    await tx.delete(PCB).where(eq(PCB.planId, planId));
    await tx
      .insert(PCB)
      .values(bands.map((b) => ({ planId, minAdc: b.minAdc, monthlyFeeCents: b.monthlyFeeCents })));
  }

  async function loadDraft(tx: WriteTx, planId: string): Promise<PlanRow> {
    const [plan] = await tx.select().from(PL).where(eq(PL.id, planId)).for("update").limit(1);
    if (!plan || plan.tier !== "census_banded") throw new NotFoundError("plan not found");
    if (statusOf(plan) !== "draft") {
      throw new ConflictError(
        `only a draft can be edited or published; this plan is ${statusOf(plan)}`,
      );
    }
    return plan;
  }

  return {
    async list() {
      return platformRunner(async (tx) => {
        const plans = await tx
          .select()
          .from(PL)
          .where(eq(PL.tier, "census_banded"))
          .orderBy(asc(PL.familySlug), desc(PL.version));
        return Promise.all(plans.map(async (p) => toPricingPlanView(p, await loadBands(tx, p.id))));
      });
    },

    async get(planId) {
      return platformRunner((tx) => loadView(tx, planId));
    },

    async listOffered() {
      return platformRunner(async (tx) => {
        const plans = await tx
          .select()
          .from(PL)
          .where(
            and(eq(PL.tier, "census_banded"), isNotNull(PL.publishedAt), eq(PL.isActive, true)),
          )
          .orderBy(asc(PL.familySlug), desc(PL.version));
        return Promise.all(plans.map(async (p) => toPricingPlanView(p, await loadBands(tx, p.id))));
      });
    },

    async create(actor, input, reasonRaw) {
      const reason = normalizeReason(reasonRaw);
      const text = planText(input);
      const issues = validatePlanPricing(asPricing(input));
      if (issues.length > 0) failIssues(issues);
      return platformRunner(async (tx) => {
        const [taken] = await tx
          .select({ id: PL.id })
          .from(PL)
          .where(eq(PL.familySlug, input.familySlug))
          .limit(1);
        if (taken)
          throw new ConflictError("that plan family exists; create a new version of it instead");
        const [plan] = await tx
          .insert(PL)
          .values({
            slug: `${input.familySlug}-v1`,
            familySlug: input.familySlug,
            version: 1,
            name: text.name,
            description: text.description,
            tier: "census_banded",
            cadence: "monthly",
            basePriceCents: floorPriceCents(input.bands),
            currencyCode: input.currencyCode ?? "USD",
            trialPeriodDays: 0,
            isActive: false,
            perUserPriceCents: input.perUserPriceCents,
            billingSoftwareBps: input.billingSoftwareBps,
            managedBillingBps: input.managedBillingBps,
            contractTermMonths: input.contractTermMonths,
            implementationFeeCents: input.implementationFeeCents,
            minimumMonthlyCents: input.minimumMonthlyCents,
          })
          .returning();
        if (!plan) throw persistFailed("plan insert returned no row");
        await replaceBands(tx, plan.id, input.bands);
        const view = toPricingPlanView(plan, input.bands);
        await record(tx, actor, "m35.plan.draft_created", view, reason);
        return view;
      });
    },

    async replaceDraft(actor, planId, input, reasonRaw) {
      const reason = normalizeReason(reasonRaw);
      const text = planText(input);
      const issues = validatePlanPricing(asPricing(input));
      if (issues.length > 0) failIssues(issues);
      return platformRunner(async (tx) => {
        const draft = await loadDraft(tx, planId);
        const [plan] = await tx
          .update(PL)
          .set({
            name: text.name,
            description: text.description,
            currencyCode: input.currencyCode ?? draft.currencyCode,
            basePriceCents: floorPriceCents(input.bands),
            perUserPriceCents: input.perUserPriceCents,
            billingSoftwareBps: input.billingSoftwareBps,
            managedBillingBps: input.managedBillingBps,
            contractTermMonths: input.contractTermMonths,
            implementationFeeCents: input.implementationFeeCents,
            minimumMonthlyCents: input.minimumMonthlyCents,
            updatedAt: now(),
          })
          .where(eq(PL.id, planId))
          .returning();
        if (!plan) throw persistFailed("plan update returned no row");
        await replaceBands(tx, planId, input.bands);
        const view = toPricingPlanView(plan, input.bands);
        await record(tx, actor, "m35.plan.draft_updated", view, reason);
        return view;
      });
    },

    async publish(actor, planId, reasonRaw) {
      const reason = normalizeReason(reasonRaw);
      return platformRunner(async (tx) => {
        const draft = await loadDraft(tx, planId);
        const bands = await loadBands(tx, planId);
        const issues = validatePlanPricing({
          perUserPriceCents: draft.perUserPriceCents ?? Number.NaN,
          bands,
          billingSoftwareBps: draft.billingSoftwareBps ?? Number.NaN,
          managedBillingBps: draft.managedBillingBps ?? Number.NaN,
          minimumMonthlyCents: draft.minimumMonthlyCents,
          contractTermMonths: draft.contractTermMonths ?? Number.NaN,
          implementationFeeCents: draft.implementationFeeCents ?? Number.NaN,
        });
        if (issues.length > 0) failIssues(issues);
        const at = now();
        const [plan] = await tx
          .update(PL)
          .set({ publishedAt: at, isActive: true, validFrom: at, updatedAt: at })
          .where(eq(PL.id, planId))
          .returning();
        if (!plan) throw persistFailed("plan publish returned no row");
        const view = toPricingPlanView(plan, bands);
        await record(tx, actor, "m35.plan.published", view, reason);
        return view;
      });
    },

    async newVersion(actor, planId, reasonRaw) {
      const reason = normalizeReason(reasonRaw);
      return platformRunner(async (tx) => {
        const [source] = await tx.select().from(PL).where(eq(PL.id, planId)).limit(1);
        if (!source || source.tier !== "census_banded" || !source.familySlug) {
          throw new NotFoundError("plan not found");
        }
        if (statusOf(source) === "draft") {
          throw new ConflictError(
            "a draft is edited in place; only a published or archived plan is versioned",
          );
        }
        const family = await tx
          .select({ id: PL.id, version: PL.version, publishedAt: PL.publishedAt })
          .from(PL)
          .where(eq(PL.familySlug, source.familySlug))
          .for("update");
        if (family.some((f) => f.publishedAt === null)) {
          throw new ConflictError(
            "this plan family already has an unpublished draft version; finish or reuse it",
          );
        }
        const version = Math.max(...family.map((f) => f.version)) + 1;
        const bands = await loadBands(tx, planId);
        const [plan] = await tx
          .insert(PL)
          .values({
            slug: `${source.familySlug}-v${version}`,
            familySlug: source.familySlug,
            version,
            supersedesPlanId: source.id,
            name: source.name,
            description: source.description,
            tier: "census_banded",
            cadence: "monthly",
            basePriceCents: source.basePriceCents,
            currencyCode: source.currencyCode,
            trialPeriodDays: 0,
            isActive: false,
            perUserPriceCents: source.perUserPriceCents,
            billingSoftwareBps: source.billingSoftwareBps,
            managedBillingBps: source.managedBillingBps,
            contractTermMonths: source.contractTermMonths,
            implementationFeeCents: source.implementationFeeCents,
            minimumMonthlyCents: source.minimumMonthlyCents,
          })
          .returning();
        if (!plan) throw persistFailed("plan insert returned no row");
        await replaceBands(tx, plan.id, bands);
        const view = toPricingPlanView(plan, bands);
        await record(tx, actor, "m35.plan.version_created", view, reason);
        return view;
      });
    },

    async archive(actor, planId, reasonRaw) {
      const reason = normalizeReason(reasonRaw);
      return platformRunner(async (tx) => {
        const [plan] = await tx.select().from(PL).where(eq(PL.id, planId)).for("update").limit(1);
        if (!plan || plan.tier !== "census_banded") throw new NotFoundError("plan not found");
        if (statusOf(plan) !== "published") {
          throw new ConflictError(
            `only a published plan can be archived; this plan is ${statusOf(plan)}`,
          );
        }
        const at = now();
        const [archived] = await tx
          .update(PL)
          .set({ isActive: false, deprecatedAt: at, validTo: at, updatedAt: at })
          .where(eq(PL.id, planId))
          .returning();
        if (!archived) throw persistFailed("plan archive returned no row");
        const view = toPricingPlanView(archived, await loadBands(tx, planId));
        await record(tx, actor, "m35.plan.archived", view, reason);
        return view;
      });
    },
  };
}
