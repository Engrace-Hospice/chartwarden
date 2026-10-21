// apps/backend/src/modules/35-subscription/routes/promo-redemption.ts — M35 (§3.3 `promo_code`, GAP-099).
//
// The one place a promo is redeemed, shared by the tenant and platform-ops apply paths. Both used to check
// only `is_active`, so `valid_from` / `valid_to` / `max_redemptions` were dead columns and
// `redemption_count` never moved. The promo row is locked FOR UPDATE for the whole transaction, so two
// concurrent redemptions of a one-use code serialise on the lock and the second sees the incremented count.
//
// The caller MUST run this on the PLATFORM tx: `wardenx_app` holds SELECT only on `promo_code` (a catalog
// shared across tenants — migration 0143), so neither the row lock nor the count increment can run under
// a tenant connection. The tenant method therefore derives its subscription server-side from the verified
// actor org and redeems here under the platform runner.
//
// Order is lock → validate → insert application → increment. The application insert goes before the
// increment so the duplicate-application unique index (`promo_code_application_sub_active_uq`) fails the
// transaction before the count is touched; the throw rolls the whole transaction back regardless.
import { type DbClient, schema } from "@chartwarden/db";
import { ConflictError, NotFoundError, ChartWardenError } from "@chartwarden/types";
import { eq, sql } from "drizzle-orm";

const PROMO = schema.promoCode;
const PAPP = schema.promoCodeApplication;

const UNPROCESSABLE = 422;
const CONFLICT = 409;

/** The promo columns the redemption rules read. */
export interface RedeemablePromo {
  readonly isActive: boolean;
  readonly validFrom: Date | null;
  readonly validTo: Date | null;
  readonly maxRedemptions: number | null;
  readonly redemptionCount: number;
}

/** Validity window and redemption cap, evaluated against the transaction's own `now`. Throws a 4xx. */
export function assertPromoRedeemable(promo: RedeemablePromo, now: Date): void {
  if (promo.validFrom && now.getTime() < promo.validFrom.getTime()) {
    throw new ChartWardenError("PROMO_NOT_YET_VALID", "promo code is not yet valid", UNPROCESSABLE);
  }
  if (promo.validTo && now.getTime() >= promo.validTo.getTime()) {
    throw new ChartWardenError("PROMO_EXPIRED", "promo code has expired", UNPROCESSABLE);
  }
  if (promo.maxRedemptions !== null && promo.redemptionCount >= promo.maxRedemptions) {
    throw new ChartWardenError(
      "PROMO_REDEMPTION_CAP_REACHED",
      "promo code has reached its redemption limit",
      CONFLICT,
    );
  }
}

/** Postgres unique-violation, direct or wrapped by Drizzle (`cause`). */
const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return (e?.code ?? e?.cause?.code) === "23505";
};

export interface RedeemPromoArgs {
  readonly code: string;
  readonly organizationId: string;
  readonly subscriptionId: string;
  readonly appliedByMembershipId: string;
  readonly now: Date;
}

/**
 * Lock the promo by code, enforce active + window + cap, insert the application and bump
 * `redemption_count` — all on the caller's transaction. Returns the application row and the promo code.
 */
export async function redeemPromoInTx(
  tx: DbClient, // the same handle service-drizzle aliases as WriteTx (imported directly: no import cycle)
  args: RedeemPromoArgs,
): Promise<{ application: typeof PAPP.$inferSelect; promoCode: string }> {
  const [promo] = await tx
    .select()
    .from(PROMO)
    .where(eq(PROMO.code, args.code))
    .limit(1)
    .for("update");
  if (!promo || !promo.isActive) throw new NotFoundError("promo code not found or inactive");
  assertPromoRedeemable(promo, args.now);

  let application: typeof PAPP.$inferSelect | undefined;
  try {
    [application] = await tx
      .insert(PAPP)
      .values({
        organizationId: args.organizationId,
        subscriptionId: args.subscriptionId,
        promoCodeId: promo.id,
        appliedByMembershipId: args.appliedByMembershipId,
        startedAt: args.now,
      })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError("promo code is already applied to this subscription");
    }
    throw err;
  }
  if (!application) throw new ChartWardenError("PERSIST_FAILED", "the write returned no row", 500);

  await tx
    .update(PROMO)
    .set({ redemptionCount: sql`${PROMO.redemptionCount} + 1` })
    .where(eq(PROMO.id, promo.id));
  return { application, promoCode: promo.code };
}
