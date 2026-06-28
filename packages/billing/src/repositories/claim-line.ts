// @wardenx/billing · repositories — `claim_line` (child line table of `claim`, §3.3). INTERNAL-WRITE-ONLY:
// ONLY the claim-assembly service writes lines, and only as a batch under the parent claim's transaction;
// there is NO external line-mutation route and this repo offers NO update/delete surface (spec §3.1 — the
// routes expose lines read-only once a claim leaves DRAFT). Re-assembly replaces the line set wholesale by
// deleting the parent's drafts and re-inserting; that delete is the assembly service's concern, not a
// public method here.
//
// ENUM BOUNDARY: `level_of_care` is the DB abbreviation (`RHC`/`CHC`/`IRC`/`GIP`); this repo maps it
// through `levelOfCareCodec` on read + write so the assembly service speaks the long-form domain
// `LevelOfCare`. `revenue_code` / `q_code` are DB-native code enums with no domain divergence and pass
// through unchanged. No PHI (D13).
import * as schema from "@wardenx/db/schema";
import { asc, eq } from "drizzle-orm";
import type { LevelOfCare } from "../contracts";
import { type BillingDb, levelOfCareCodec } from "./db";

const L = schema.claimLine;

/** The domain-cased `claim_line` row: `level_of_care` mapped to the long-form domain `LevelOfCare`. */
export interface ClaimLineRecord extends Omit<schema.ClaimLine, "levelOfCare"> {
  readonly levelOfCare: LevelOfCare;
}

/** Insert input: the Drizzle insert shape with `levelOfCare` as the long-form domain `LevelOfCare`. */
export type NewClaimLineInput = Omit<schema.NewClaimLine, "levelOfCare"> & {
  readonly levelOfCare: LevelOfCare;
};

/** Map a DB row to the domain-cased record (the single read-boundary case translation). */
function toClaimLineRecord(row: schema.ClaimLine): ClaimLineRecord {
  return { ...row, levelOfCare: levelOfCareCodec.fromDb(row.levelOfCare) };
}

/** Data port for `claim_line` (INTERNAL-WRITE-ONLY: batch insert + read; no update/delete surface). */
export class ClaimLineRepository {
  constructor(private readonly db: BillingDb) {}

  /**
   * Insert a claim's assembled lines in one statement (the assembly service's only write path). Maps each
   * input's domain `levelOfCare` to the DB abbreviation. Returns the domain-cased inserted records.
   */
  async insertBatch(inputs: readonly NewClaimLineInput[]): Promise<readonly ClaimLineRecord[]> {
    if (inputs.length === 0) return [];
    const values: schema.NewClaimLine[] = inputs.map(({ levelOfCare, ...rest }) => ({
      ...rest,
      levelOfCare: levelOfCareCodec.toDb(levelOfCare),
    }));
    const rows = await this.db.insert(L).values(values).returning();
    return rows.map(toClaimLineRecord);
  }

  /** A claim's lines in `line_number` order (the read-only line view). */
  async listForClaim(claimId: string): Promise<readonly ClaimLineRecord[]> {
    const rows = await this.db
      .select()
      .from(L)
      .where(eq(L.claimId, claimId))
      .orderBy(asc(L.lineNumber));
    return rows.map(toClaimLineRecord);
  }
}
