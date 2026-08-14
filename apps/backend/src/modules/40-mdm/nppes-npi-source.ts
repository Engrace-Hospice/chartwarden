// apps/backend/src/modules/40-mdm/nppes-npi-source.ts — the distinct NPIs the platform references
// (GAP-045). M40 owns `external_physician`, so the read lives HERE and the consumer gets a value, not a
// table (`arch:tables` enforces exactly that: M29's first draft read the canonical directly and the
// ownership gate refused it).
//
// M29's D11 platform NPPES sync defines its input as "the distinct NPIs every tenant references" (§7).
// The canonical physician registry is where those NPIs are: org-less platform master data, read-all under
// the `USING (true)` policy from migration 0019, so this needs no org context and no platform credential.
//
// A `merged` canonical is EXCLUDED. Its NPI, if it has one, belongs to the survivor it points at, and the
// survivor is in the list on its own account — fetching both would spend two rate-limited CMS requests to
// learn the same registry fact. Provisional rows carry a null NPI and drop out for free.
import { type DbClient, schema } from "@wardenx/db";
import { and, isNotNull, ne } from "drizzle-orm";

const PHYSICIAN = schema.externalPhysicians;

/** The narrow read M29's `NppesNpiSourcePort` is bound to at the composition root. */
export interface NppesNpiSource {
  distinctReferencedNpis(): Promise<readonly string[]>;
}

export function createDbNppesNpiSource(db: DbClient): NppesNpiSource {
  return {
    async distinctReferencedNpis() {
      const rows = await db
        .selectDistinct({ npi: PHYSICIAN.npi })
        .from(PHYSICIAN)
        .where(and(isNotNull(PHYSICIAN.npi), ne(PHYSICIAN.status, "merged")))
        .orderBy(PHYSICIAN.npi);
      return rows.flatMap((r) => (r.npi === null ? [] : [r.npi]));
    },
  };
}
