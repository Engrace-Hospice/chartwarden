// apps/backend/src/modules/21-supplies/seams/non-covered-dme-supplies.ts — COP27 workstream B
// (42 CFR 418.24(c)).
//
// The M21-owned answer to "which equipment / supplies did the hospice determine are NOT covered for this
// admission?" — the ITEM rows of the "Patient Notification of Hospice Non-Covered Items, Services, and
// Drugs" addendum M6 composes. Registered as the `NonCoveredDmeSuppliesReader` seam
// (`registerSuppliesSeams`) so M6 reads it without importing M21's schema (architecture §25.15).
//
// ORG-EXPLICIT: the caller passes the org and the read runs under `withOrgContext` (correct from a relay
// tick / worker; RLS still scopes by `app.org_id`).
//
// "Active" = every status except `cancelled` (never happened), `cancellation_pending` (being withdrawn) and
// `returned` (equipment left the home). `completed` STAYS listed: a delivered rental bed is still in the
// home and still not covered. Only the `dme` / `supply` kinds can be not covered (CHECK
// `m21_supply_request_coverage_kind`), so no kind filter is needed beyond the coverage predicate.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { NonCoveredItemSnapshot, NonCoveredItemsReader } from "@chartwarden/types";
import { and, asc, eq, inArray, ne, notInArray } from "drizzle-orm";

const REQUEST = schema.supplyRequest;
const ITEM = schema.supplyItem;
const TENANT_ITEM = schema.tenantSupplyItemExtension;

/** The statuses whose requests no longer put an item in the patient's home. */
export const NON_COVERED_EXCLUDED_SUPPLY_STATUSES = [
  "cancelled",
  "cancellation_pending",
  "returned",
] as const;

type NonCoveredSupplyRow = {
  readonly id: string;
  readonly kind: string;
  readonly data: unknown;
  readonly coverageReason: string | null;
  readonly coverageDeterminedAt: Date | null;
  readonly coverageDeterminedByMembershipId: string | null;
  readonly updatedAt: Date;
};

const fieldOf = (data: unknown, key: string): string | null => {
  if (data === null || typeof data !== "object") return null;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/** The catalog `skuId` a dme/supply payload names (D1 per-kind TypeBox), or null. */
export const skuIdOfRequestData = (data: unknown): string | null => fieldOf(data, "skuId");

/** Pure projection of one not-covered request row to the addendum snapshot. */
export function supplySnapshotOf(
  row: NonCoveredSupplyRow,
  itemName: string | null,
): NonCoveredItemSnapshot {
  const hcpcs = fieldOf(row.data, "hcpcs");
  const label = row.kind === "dme" ? "Durable medical equipment" : "Medical supply";
  const description = itemName ?? (hcpcs ? `${label} (HCPCS ${hcpcs})` : label);
  return {
    source: row.kind === "dme" ? "dme" : "supply",
    sourceId: row.id,
    category: "item",
    description,
    // The CHECK guarantees a non-blank reason + instant on every not-covered row.
    reason: row.coverageReason ?? "",
    determinedAt: (row.coverageDeterminedAt ?? row.updatedAt).toISOString(),
    determinedByUserId: row.coverageDeterminedByMembershipId,
  };
}

/** Every active dme/supply request on `admissionId` determined NOT hospice-covered, oldest first. */
export async function listNonCoveredDmeSuppliesForAdmission(
  db: DbClient,
  organizationId: string,
  admissionId: string,
): Promise<NonCoveredItemSnapshot[]> {
  return withOrgContext(db, { organizationId, userId: "" }, async (txRaw) => {
    const tx = txRaw as unknown as DbClient;
    const rows = await tx
      .select({
        id: REQUEST.id,
        kind: REQUEST.kind,
        data: REQUEST.data,
        coverageReason: REQUEST.coverageReason,
        coverageDeterminedAt: REQUEST.coverageDeterminedAt,
        coverageDeterminedByMembershipId: REQUEST.coverageDeterminedByMembershipId,
        updatedAt: REQUEST.updatedAt,
      })
      .from(REQUEST)
      .where(
        and(
          eq(REQUEST.organizationId, organizationId),
          eq(REQUEST.admissionId, admissionId),
          ne(REQUEST.hospiceCoverage, "covered_related"),
          notInArray(REQUEST.status, [...NON_COVERED_EXCLUDED_SUPPLY_STATUSES]),
        ),
      )
      .orderBy(asc(REQUEST.coverageDeterminedAt), asc(REQUEST.id));
    if (rows.length === 0) return [];
    const skuIds = [
      ...new Set(rows.map((r) => skuIdOfRequestData(r.data)).filter((id): id is string => !!id)),
    ];
    const names = new Map<string, string>();
    if (skuIds.length > 0) {
      // The platform catalog first, then the tenant overlay (RLS-scoped) — a skuId names one or the other.
      for (const r of await tx
        .select({ id: ITEM.id, name: ITEM.name })
        .from(ITEM)
        .where(inArray(ITEM.id, skuIds)))
        names.set(r.id, r.name);
      for (const r of await tx
        .select({ id: TENANT_ITEM.id, name: TENANT_ITEM.name })
        .from(TENANT_ITEM)
        .where(inArray(TENANT_ITEM.id, skuIds)))
        names.set(r.id, r.name);
    }
    return rows.map((r) => {
      const skuId = skuIdOfRequestData(r.data);
      return supplySnapshotOf(r, skuId ? (names.get(skuId) ?? null) : null);
    });
  });
}

/** The `NonCoveredDmeSuppliesReader` seam implementation over the production DB client. */
export function createNonCoveredDmeSuppliesReader(db: DbClient): NonCoveredItemsReader {
  return {
    listForAdmission: (orgId, admissionId) =>
      listNonCoveredDmeSuppliesForAdmission(db, orgId, admissionId),
  };
}
