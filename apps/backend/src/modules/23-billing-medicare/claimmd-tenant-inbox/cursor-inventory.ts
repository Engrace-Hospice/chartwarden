import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";

export type TenantClaimMdCursorCutoverClass =
  | "legacy_only"
  | "repository_ready"
  | "cutover_assessment_required"
  | "cutover_blocked"
  | "qualified_for_controlled_transition";

/** A historical poll coordinate is deliberately not equated to an account-level ResponseID cursor. */
export interface LegacyTenantClaimMdCursorCoordinate {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly vendorCoordinate: "claimmd@tenant";
  readonly usage: "test" | "production";
  readonly acknowledgmentKind: "ack_999" | "ack_277ca";
  readonly cursor: string | null;
  readonly version: number;
  /** Timestamp of the last cursor commit; the legacy table has no independent poll-success heartbeat. */
  readonly lastUpdatedAt: Date;
  readonly lastSuccessfulProcessingAt: null;
  readonly currentPollerOwner: "runTransportAckPull";
  readonly comparableWithOtherLegacyCoordinates: false;
  readonly accountIdentityId: null;
  readonly classification: TenantClaimMdCursorCutoverClass;
}

export function classifyLegacyTenantClaimMdCursor(input: {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly vendor: string;
  readonly usage: string;
  readonly kind: string;
  readonly cursor: string | null;
  readonly version: number;
  readonly updatedAt: Date;
}): LegacyTenantClaimMdCursorCoordinate | null {
  if (
    input.vendor !== "claimmd@tenant" ||
    (input.usage !== "test" && input.usage !== "production") ||
    (input.kind !== "ack_999" && input.kind !== "ack_277ca")
  )
    return null;
  return {
    organizationId: input.organizationId,
    providerEntityId: input.providerEntityId,
    vendorCoordinate: "claimmd@tenant",
    usage: input.usage,
    acknowledgmentKind: input.kind,
    cursor: input.cursor,
    version: input.version,
    lastUpdatedAt: input.updatedAt,
    comparableWithOtherLegacyCoordinates: false,
    accountIdentityId: null,
    lastSuccessfulProcessingAt: null,
    currentPollerOwner: "runTransportAckPull",
    classification: "legacy_only",
  };
}

/** Read-only, RLS-scoped inventory. Never advances, resets, or combines historical cursors. */
export async function inventoryTenantClaimMdLegacyCursors(input: {
  readonly db: DbClient;
  readonly organizationId: string;
}): Promise<readonly LegacyTenantClaimMdCursorCoordinate[]> {
  const C = schema.clearinghouseAckCursor;
  const rows = await withOrgContext(
    input.db,
    { organizationId: input.organizationId, userId: "" },
    (tx) =>
      tx
        .select({
          organizationId: C.organizationId,
          providerEntityId: C.providerEntityId,
          vendor: C.vendor,
          usage: C.usage,
          kind: C.kind,
          cursor: C.cursor,
          version: C.version,
          updatedAt: C.updatedAt,
        })
        .from(C)
        .where(and(eq(C.organizationId, input.organizationId), eq(C.vendor, "claimmd@tenant"))),
  );
  return rows.flatMap((row) => {
    const coordinate = classifyLegacyTenantClaimMdCursor(row);
    return coordinate ? [coordinate] : [];
  });
}
