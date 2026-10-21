// apps/backend/src/modules/08-encounters/seams/bereavement-encounter-reader.ts — the Drizzle reader backing
// M8's `BereavementEncounterReader` seam (GAP-049): the leaf facts M16 needs to verify the
// `sourceEncounterId` of a completed in-person bereavement visit (D15) — which patient the encounter
// documents, whether it is a `bereavement_contact` encounter, and whether it has been signed.
// Not a request: it opens its OWN org-scoped `withOrgContext` envelope (empty acting user, the seam-read
// convention) with an explicit `organization_id` predicate behind RLS. An unknown or cross-tenant id is
// `null`, never a throw.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { BereavementEncounterReader } from "@chartwarden/types";
import { and, eq } from "drizzle-orm";

const E = schema.encounters;

/** Statuses that mean the author has signed (a voided or draft/finalized-only row has not). */
const SIGNED_STATUSES: ReadonlySet<string> = new Set(["signed", "cosign_pending", "cosigned"]);

/** Same empty-acting-user sentinel the other M8 seam readers use (the audit trigger maps "" to NULL). */
const SYSTEM_USER_ID = "";

export function createBereavementEncounterReader(db: DbClient): BereavementEncounterReader {
  return {
    getBereavementEncounterFacts({ organizationId, encounterId }) {
      return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
        const [row] = await (tx as unknown as DbClient)
          .select({
            id: E.id,
            patientId: E.patientId,
            encounterType: E.encounterType,
            status: E.status,
            voidedAt: E.voidedAt,
          })
          .from(E)
          .where(and(eq(E.organizationId, organizationId), eq(E.id, encounterId)))
          .limit(1);
        if (!row) return null;
        return {
          encounterId: row.id,
          patientId: row.patientId,
          isBereavementContact: row.encounterType === "bereavement_contact",
          isSigned: SIGNED_STATUSES.has(row.status) && row.voidedAt === null,
        };
      });
    },
  };
}
