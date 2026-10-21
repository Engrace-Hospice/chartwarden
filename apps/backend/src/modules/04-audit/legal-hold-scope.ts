// apps/backend/src/modules/04-audit/legal-hold-scope.ts — M4's published read of which patients an org's ACTIVE
// legal holds cover, for retention jobs in other modules (M10 `hope-retention-scan`, GAP-181). M4 owns
// `legal_hold`; consumers receive the answer through an injected port bound at the composition root rather
// than importing the table.
//
// CONSERVATIVE by construction: a hold whose `criteria.patientIds` is absent/empty is org-wide (it names no
// narrower selector this reader can honour), and an org-wide hold blocks EVERY retention purge in the org. Only
// a hold that names patients scopes down to them. `dateRange`/`resourceKinds` are deliberately ignored — a
// retention job that mis-scoped a hold would destroy held records, so over-blocking is the safe error.
import { isMessagingOnlyCriteria } from "@chartwarden/audit";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";

export interface ActiveLegalHoldScope {
  /** True when at least one active hold covers the whole org (no patient selector). */
  readonly orgWide: boolean;
  /**
   * True when at least one active hold is messaging-only (channelIds/userIds). It does not widen `orgWide`
   * (patient-record retention jobs ignore it) but it MUST still block irreversible tenant-wide destruction
   * (M34 crypto-shred), which reads this flag.
   */
  readonly messagingHeld: boolean;
  /** Patients named by patient-scoped active holds. */
  readonly patientIds: ReadonlySet<string>;
}

/** Pure projection of the active holds' `criteria` jsonb (unit-testable without a database). */
export function legalHoldScopeOf(criteriaRows: readonly unknown[]): ActiveLegalHoldScope {
  let orgWide = false;
  let messagingHeld = false;
  const patientIds = new Set<string>();
  for (const criteria of criteriaRows) {
    // A messaging-only hold (channelIds/userIds, ADR-0086 (proposed)) protects messages, not patient records.
    if (isMessagingOnlyCriteria(criteria)) {
      messagingHeld = true;
      continue;
    }
    const ids =
      criteria && typeof criteria === "object"
        ? (criteria as { patientIds?: unknown }).patientIds
        : undefined;
    if (Array.isArray(ids) && ids.length > 0) {
      for (const id of ids) if (typeof id === "string") patientIds.add(id);
    } else {
      orgWide = true;
    }
  }
  return { orgWide, messagingHeld, patientIds };
}

/** The org's active legal-hold scope, read under the org's RLS context. */
export function activeLegalHoldScopeForOrg(
  db: DbClient,
  organizationId: string,
): Promise<ActiveLegalHoldScope> {
  return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
    const rows = await tx
      .select({ criteria: schema.legalHolds.criteria })
      .from(schema.legalHolds)
      .where(
        and(
          eq(schema.legalHolds.organizationId, organizationId),
          eq(schema.legalHolds.status, "active"),
        ),
      );
    return legalHoldScopeOf(rows.map((r) => r.criteria));
  });
}
