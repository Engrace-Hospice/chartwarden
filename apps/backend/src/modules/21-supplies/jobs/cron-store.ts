// apps/backend/src/modules/21-supplies/jobs/cron-store.ts — M21 §4.6 cron reads (GAP-062).
//
// The caller owns the `withOrgContext` transaction; nothing here opens its own tenancy envelope, and every
// table read is RLS-scoped by it.
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, inArray, lte, notInArray } from "drizzle-orm";

const PAR = schema.parStock;
const ITEM = schema.supplyItem;
const TENANT_ITEM = schema.tenantSupplyItemExtension;
const RETURN = schema.comfortKitReturn;
const DISPATCHED = schema.comfortKitDispatchedContent;
const REQUEST = schema.supplyRequest;

export interface ParCronRow {
  readonly parStockId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
  readonly supplyItemId: string | null;
  readonly tenantSupplyItemExtensionId: string | null;
  readonly supplyItemName: string;
  readonly currentQuantity: string;
  readonly reorderPoint: string;
  readonly minSafetyStock: string;
  readonly reorderQuantity: string;
  readonly unit: string;
  readonly isActive: boolean;
}

/** Every ACTIVE par row of the org with its SKU display name (Location zones resolve via an M1 port). */
export async function activeParRowsForOrg(tx: DbClient): Promise<readonly ParCronRow[]> {
  const rows = await tx
    .select({
      par: PAR,
      platformName: ITEM.name,
      tenantName: TENANT_ITEM.name,
    })
    .from(PAR)
    .leftJoin(ITEM, eq(ITEM.id, PAR.skuId))
    .leftJoin(TENANT_ITEM, eq(TENANT_ITEM.id, PAR.tenantSkuExtensionId))
    .where(eq(PAR.isActive, true));
  return rows.map((r) => ({
    parStockId: r.par.id,
    providerEntityId: r.par.providerEntityId,
    locationId: r.par.locationId,
    supplyItemId: r.par.skuId ?? null,
    tenantSupplyItemExtensionId: r.par.tenantSkuExtensionId ?? null,
    supplyItemName: r.platformName ?? r.tenantName ?? "",
    currentQuantity: r.par.currentQuantity,
    reorderPoint: r.par.reorderPoint,
    minSafetyStock: r.par.minSafetyStock,
    reorderQuantity: r.par.reorderQuantity,
    unit: r.par.unit,
    isActive: r.par.isActive,
  }));
}

/** The return states with work still outstanding (everything but the two terminals). */
const TERMINAL_RETURN_STATES = ["reconciled", "unreturnable"] as const;

export interface OpenReturnCronRow {
  readonly returnId: string;
}

/** Ids of the org's non-terminal returns whose `return_required_at` is at or before `cutoff`. */
export async function openReturnsRequiredBefore(
  tx: DbClient,
  cutoff: Date,
): Promise<readonly OpenReturnCronRow[]> {
  const rows = await tx
    .select({ returnId: RETURN.id })
    .from(RETURN)
    .where(
      and(
        notInArray(RETURN.state, [...TERMINAL_RETURN_STATES]),
        lte(RETURN.returnRequiredAt, cutoff),
      ),
    );
  return rows;
}

/** True when the dispatch held at least one scheduled (CII-CV) line. */
export async function dispatchHasControlledContent(
  tx: DbClient,
  dispatchId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: DISPATCHED.id })
    .from(DISPATCHED)
    .where(and(eq(DISPATCHED.dispatchId, dispatchId), eq(DISPATCHED.isControlledSubstance, true)))
    .limit(1);
  return rows.length > 0;
}

/** The in-flight statuses the §2.10 monitor evaluates. */
const MONITORED_REQUEST_STATUSES = ["ordered", "in_transit", "delivered"] as const;

/** Ids of the org's requests in a monitored status (the pure detector decides which actually trip). */
export async function monitoredSupplyRequestIds(tx: DbClient): Promise<readonly string[]> {
  const rows = await tx
    .select({ id: REQUEST.id })
    .from(REQUEST)
    .where(inArray(REQUEST.status, [...MONITORED_REQUEST_STATUSES]));
  return rows.map((r) => r.id);
}
