// apps/backend/src/modules/35-subscription/addon/addon-service.ts — ADR-0108 the claims-billing add-on service.
//
// PLATFORM-OPS writes (grant / trial / cancel) run ONLY through the injected platform runner (chartwarden_admin): the
// app role holds SELECT and nothing else on `subscription_addon`, so a tenant session can never grant itself the
// add-on (migration 1321). Each write emits its `m35.claims_billing_addon.*` event through the catalog-validating
// publisher on the SAME transaction. The tenant read (`claimsBillingForOrg`) runs on the tenant pool under RLS.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  ChartWardenError,
  type ClaimsBillingDenyReason,
  ConflictError,
  NotFoundError,
  type SubscriptionAddonStatus,
  ValidationError,
} from "@chartwarden/types";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { claimsBillingEnforcementMode } from "../../../bootstrap/claims-billing-gate";
import {
  activePeriodKeyFor,
  countActivePatientsForPeriod,
  latestSubscriptionWindow,
} from "../billing-runtime/census";
import { usageWindowFor } from "../billing-runtime/jobs";
import type { M35WriteActor } from "../routes/actor";
import type { PlatformRunner, WriteOutboxPort, WriteTx } from "../routes/service-drizzle";
import {
  addonIsLive,
  decideClaimsBillingEntitlement,
  latestClaimsBillingAddon,
} from "./entitlement";

export interface AddonView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly entitlementKey: string;
  readonly meterEventType: string;
  readonly unitPriceCents: number | null;
  readonly currencyCode: string;
  readonly isActive: boolean;
}

export interface SubscriptionAddonView {
  readonly id: string;
  readonly organizationId: string;
  readonly subscriptionId: string;
  readonly addonId: string;
  readonly addonSlug: string;
  readonly addonName: string;
  readonly status: SubscriptionAddonStatus;
  readonly live: boolean;
  readonly trialEndsAt: string | null;
  readonly startedAt: string;
  readonly endsAt: string | null;
  readonly canceledAt: string | null;
  readonly grantedByMembershipId: string | null;
  readonly grantReason: string;
}

export interface ClaimsBillingStatusView {
  readonly entitled: boolean;
  readonly status: SubscriptionAddonStatus | "none";
  readonly reason: ClaimsBillingDenyReason | null;
  readonly trialEndsAt: string | null;
  readonly activePatientCount: number | null;
  /** True when the server is in `enforce` mode (a not-entitled org is refused); false in off/shadow. */
  readonly enforced: boolean;
}

export interface GrantAddonArgs {
  readonly addonSlug: string;
  readonly mode: "grant" | "trial";
  readonly trialEndsAt?: string;
  readonly reason: string;
}

export interface AddonService {
  listAddons(): Promise<AddonView[]>;
  listSubscriptionAddons(subscriptionId: string): Promise<SubscriptionAddonView[]>;
  grantAddon(
    actor: M35WriteActor,
    subscriptionId: string,
    args: GrantAddonArgs,
  ): Promise<SubscriptionAddonView>;
  cancelAddon(
    actor: M35WriteActor,
    subscriptionId: string,
    addonId: string,
  ): Promise<SubscriptionAddonView>;
  /** The tenant's own posture (tenant pool, RLS). */
  claimsBillingForOrg(organizationId: string): Promise<ClaimsBillingStatusView>;
  /** The admin usage drill-down's add-on line (platform runner); null when the org never held the add-on. */
  adminAddonUsage(organizationId: string): Promise<AddonUsageView | null>;
}

export interface AddonUsageView {
  readonly addonSlug: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly activePatientCount: number;
  readonly unitPriceCents: number | null;
  readonly computedAt: string | null;
}

export interface AddonServiceDeps {
  readonly platformRunner?: PlatformRunner;
  readonly outbox?: WriteOutboxPort;
  readonly now?: () => Date;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const LIVE_STATUSES = ["trialing", "active"] as const;

type AddonRowT = typeof schema.addonRow.$inferSelect;
type SubAddonRowT = typeof schema.subscriptionAddon.$inferSelect;

function addonView(a: AddonRowT): AddonView {
  return {
    id: a.id,
    slug: a.slug,
    name: a.name,
    description: a.description,
    entitlementKey: a.entitlementKey,
    meterEventType: a.meterEventType,
    unitPriceCents: a.unitPriceCents,
    currencyCode: a.currencyCode,
    isActive: a.isActive,
  };
}

function subscriptionAddonView(
  r: SubAddonRowT,
  addon: Pick<AddonRowT, "slug" | "name">,
  now: Date,
): SubscriptionAddonView {
  return {
    id: r.id,
    organizationId: r.organizationId,
    subscriptionId: r.subscriptionId,
    addonId: r.addonId,
    addonSlug: addon.slug,
    addonName: addon.name,
    status: r.status,
    live: addonIsLive(r, now),
    trialEndsAt: iso(r.trialEndsAt),
    startedAt: r.startedAt.toISOString(),
    endsAt: iso(r.endsAt),
    canceledAt: iso(r.canceledAt),
    grantedByMembershipId: r.grantedByMembershipId,
    grantReason: r.grantReason,
  };
}

const failClosedPlatformRunner: PlatformRunner = async () => {
  throw new ChartWardenError(
    "PLATFORM_CONTEXT_UNAVAILABLE",
    "the platform-ops billing surface requires a bound platform credential",
    503,
  );
};

export function buildDrizzleAddonService(db: DbClient, deps: AddonServiceDeps = {}): AddonService {
  const platform = deps.platformRunner ?? failClosedPlatformRunner;
  const now = deps.now ?? (() => new Date());
  const A = schema.addonRow;
  const SA = schema.subscriptionAddon;
  const S = schema.subscriptionRow;

  async function emit(
    tx: WriteTx,
    eventName: "m35.claims_billing_addon.granted" | "m35.claims_billing_addon.canceled",
    row: SubAddonRowT,
    effectiveAt: Date,
  ): Promise<void> {
    if (!deps.outbox) {
      // The grant/cancel is an operator act a downstream reader may audit; never record it half-published.
      throw new ChartWardenError(
        "OUTBOX_UNBOUND",
        "the add-on event publisher is not bound; refusing to change the add-on without its event",
        503,
      );
    }
    await deps.outbox.publish(tx, {
      eventName,
      payload: {
        subscriptionAddonId: row.id,
        subscriptionId: row.subscriptionId,
        organizationId: row.organizationId,
        status: row.status,
        effectiveAt: effectiveAt.toISOString(),
      },
      organizationId: row.organizationId,
      aggregateKind: "subscription_addon",
      aggregateId: row.id,
    });
  }

  async function loadSubscription(tx: WriteTx, subscriptionId: string) {
    const [sub] = await tx.select().from(S).where(eq(S.id, subscriptionId)).limit(1);
    if (!sub) throw new NotFoundError("subscription not found");
    return sub;
  }

  /** Close a DB-live row whose trial / scheduled end has passed, so the one-live unique index admits a new one. */
  async function closeExpired(tx: WriteTx, row: SubAddonRowT, at: Date): Promise<void> {
    const endedAt = row.endsAt ?? row.trialEndsAt ?? at;
    const [closed] = await tx
      .update(SA)
      .set({ status: "canceled", canceledAt: endedAt, endsAt: endedAt, updatedAt: at })
      .where(eq(SA.id, row.id))
      .returning();
    if (closed) await emit(tx, "m35.claims_billing_addon.canceled", closed, endedAt);
  }

  return {
    async listAddons() {
      return platform(async (tx) => {
        const rows = await tx.select().from(A).orderBy(asc(A.slug));
        return rows.map(addonView);
      });
    },

    async listSubscriptionAddons(subscriptionId) {
      return platform(async (tx) => {
        await loadSubscription(tx, subscriptionId);
        const rows = await tx
          .select({ r: SA, slug: A.slug, name: A.name })
          .from(SA)
          .innerJoin(A, eq(A.id, SA.addonId))
          .where(eq(SA.subscriptionId, subscriptionId))
          .orderBy(desc(SA.startedAt));
        const at = now();
        return rows.map(({ r, slug, name }) => subscriptionAddonView(r, { slug, name }, at));
      });
    },

    async grantAddon(actor, subscriptionId, args) {
      const at = now();
      let trialEndsAt: Date | null = null;
      if (args.mode === "trial") {
        trialEndsAt = args.trialEndsAt ? new Date(args.trialEndsAt) : null;
        if (!trialEndsAt || Number.isNaN(trialEndsAt.getTime()) || trialEndsAt <= at) {
          throw new ValidationError("a trial needs a future trialEndsAt", [
            { field: "trialEndsAt", code: "INVALID", message: "must be a future instant" },
          ]);
        }
      } else if (args.trialEndsAt !== undefined) {
        throw new ValidationError("trialEndsAt is only accepted with mode=trial", [
          { field: "trialEndsAt", code: "INVALID", message: "only for mode=trial" },
        ]);
      }
      return platform(async (tx) => {
        const sub = await loadSubscription(tx, subscriptionId);
        if (sub.status === "canceled") {
          throw new ConflictError("a canceled subscription cannot take an add-on");
        }
        const [addon] = await tx.select().from(A).where(eq(A.slug, args.addonSlug)).limit(1);
        if (!addon) throw new NotFoundError("add-on not found");
        if (!addon.isActive || (addon.validTo && addon.validTo <= at)) {
          throw new ConflictError("the add-on is not currently offered");
        }
        const live = await tx
          .select()
          .from(SA)
          .where(
            and(
              eq(SA.organizationId, sub.organizationId),
              eq(SA.addonId, addon.id),
              inArray(SA.status, [...LIVE_STATUSES]),
            ),
          )
          .for("update");
        for (const row of live) {
          if (addonIsLive(row, at)) {
            throw new ConflictError("the organization already holds this add-on");
          }
          await closeExpired(tx, row, at);
        }
        const [row] = await tx
          .insert(SA)
          .values({
            organizationId: sub.organizationId,
            subscriptionId: sub.id,
            addonId: addon.id,
            status: args.mode === "trial" ? "trialing" : "active",
            trialEndsAt,
            startedAt: at,
            grantedByMembershipId: actor.membershipId,
            grantReason: args.reason.trim(),
            createdAt: at,
            updatedAt: at,
          })
          .returning();
        if (!row) throw new ChartWardenError("INTERNAL_ERROR", "add-on grant returned no row", 500);
        await emit(tx, "m35.claims_billing_addon.granted", row, at);
        return subscriptionAddonView(row, addon, at);
      });
    },

    async cancelAddon(actor, subscriptionId, addonId) {
      const at = now();
      return platform(async (tx) => {
        const sub = await loadSubscription(tx, subscriptionId);
        const [addon] = await tx.select().from(A).where(eq(A.id, addonId)).limit(1);
        if (!addon) throw new NotFoundError("add-on not found");
        const [live] = await tx
          .select()
          .from(SA)
          .where(
            and(
              eq(SA.subscriptionId, sub.id),
              eq(SA.addonId, addon.id),
              inArray(SA.status, [...LIVE_STATUSES]),
            ),
          )
          .for("update")
          .limit(1);
        if (!live) throw new NotFoundError("no live add-on on this subscription");
        const [row] = await tx
          .update(SA)
          .set({
            status: "canceled",
            canceledAt: at,
            endsAt: at,
            canceledByMembershipId: actor.membershipId,
            updatedAt: at,
          })
          .where(eq(SA.id, live.id))
          .returning();
        if (!row)
          throw new ChartWardenError("INTERNAL_ERROR", "add-on cancel returned no row", 500);
        await emit(tx, "m35.claims_billing_addon.canceled", row, at);
        return subscriptionAddonView(row, addon, at);
      });
    },

    async claimsBillingForOrg(organizationId) {
      const at = now();
      const { latest, activePatientCount } = await withOrgContext(
        db,
        { organizationId, userId: "" },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          const row = await latestClaimsBillingAddon(tx, organizationId);
          if (!row) return { latest: null, activePatientCount: null };
          const key = activePeriodKeyFor(await latestSubscriptionWindow(tx, organizationId), at);
          return {
            latest: row,
            activePatientCount: await countActivePatientsForPeriod(tx, organizationId, key),
          };
        },
      );
      const decision = decideClaimsBillingEntitlement(latest, at);
      return {
        entitled: decision.entitled,
        status: latest?.status ?? "none",
        reason: decision.entitled ? null : decision.reason,
        trialEndsAt: iso(latest?.trialEndsAt),
        activePatientCount,
        enforced: claimsBillingEnforcementMode() === "enforce",
      };
    },

    async adminAddonUsage(organizationId) {
      const at = now();
      return platform(async (tx) => {
        const latest = await latestClaimsBillingAddon(tx, organizationId);
        if (!latest) return null;
        const [row] = await tx
          .select({
            subscriptionId: S.id,
            currentPeriodStart: S.currentPeriodStart,
            currentPeriodEnd: S.currentPeriodEnd,
            slug: A.slug,
            unitPriceCents: A.unitPriceCents,
          })
          .from(SA)
          .innerJoin(S, eq(S.id, SA.subscriptionId))
          .innerJoin(A, eq(A.id, SA.addonId))
          .where(eq(SA.id, latest.id))
          .limit(1);
        if (!row) return null;
        const window = usageWindowFor(row, at);
        const AGG = schema.usagePeriodAggregate;
        const [agg] = await tx
          .select({ computedAt: AGG.computedAt })
          .from(AGG)
          .where(
            and(
              eq(AGG.subscriptionId, row.subscriptionId),
              eq(AGG.eventType, "billing_addon_patient"),
              eq(AGG.periodStart, window.start),
            ),
          )
          .limit(1);
        return {
          addonSlug: row.slug,
          periodStart: window.start.toISOString(),
          periodEnd: window.end.toISOString(),
          activePatientCount: await countActivePatientsForPeriod(
            tx,
            organizationId,
            activePeriodKeyFor(row, at),
          ),
          unitPriceCents: row.unitPriceCents,
          computedAt: iso(agg?.computedAt),
        };
      });
    },
  };
}
