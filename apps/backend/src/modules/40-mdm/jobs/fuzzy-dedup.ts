// apps/backend/src/modules/40-mdm/jobs/fuzzy-dedup.ts — M40 §4.3 `mdm.fuzzy_dedup_scan` cron body (GAP-173).
// Daily: pg_trgm similarity over blocked candidate pairs → `merge_request` rows (`proposed_by='fuzzy_job'`,
// `status='pending'`). The scoring + insert live in the migration-0473 SECURITY DEFINER function
// `mdm_canonical_writer_scan_fuzzy_duplicates` (the canonical tables are org-less and `merge_request` has no
// app-role grant at all, so a definer function is the only legitimate door — the 0202/0205 pattern). The pair
// index makes a re-scan a no-op, so only NEW proposals are counted and announced.
// Per spec §4.4 a new candidate raises `mdm.duplicate_suspected` to PLATFORM-OPS: the merge queue
// (`GET /admin/mdm/merge-requests`) is the worklist, and a digest notice goes through the org-less platform-ops
// path (`./platform-ops.ts`) — never a tenant alert, because the pair is canonical, not tenant data.
import { sql } from "drizzle-orm";
import { type PlatformOpsDeps, notifyPlatformOps } from "./platform-ops";

/** Kinds the 0473 function can score (physician by name within last name; facility by name within prefix). */
export const FUZZY_DEDUP_KINDS = ["physician", "facility"] as const;
export type FuzzyDedupKind = (typeof FUZZY_DEDUP_KINDS)[number];

/** Minimum pg_trgm similarity for a pair to be proposed (the function clamps to [0.5, 1.0]). */
export const FUZZY_DEDUP_THRESHOLD = 0.85;
/** Max proposals per kind per run, so a first run on a dirty directory cannot flood the queue. */
export const FUZZY_DEDUP_RUN_LIMIT = 200;

export interface FuzzyDedupDeps extends PlatformOpsDeps {
  readonly now?: () => Date;
}

export type FuzzyDedupSummary = Readonly<Record<FuzzyDedupKind, number>>;

/** Run the scan for every supported kind; notify platform-ops once if anything NEW was proposed. */
export async function runFuzzyDedupScan(deps: FuzzyDedupDeps): Promise<FuzzyDedupSummary> {
  const proposed: Record<FuzzyDedupKind, number> = { physician: 0, facility: 0 };
  for (const kind of FUZZY_DEDUP_KINDS) {
    const result = await deps.db.execute(
      sql`SELECT mdm_canonical_writer_scan_fuzzy_duplicates(${kind}, ${FUZZY_DEDUP_THRESHOLD}::real, ${FUZZY_DEDUP_RUN_LIMIT}) AS inserted`,
    );
    proposed[kind] = Number(
      (result as unknown as { rows?: Array<{ inserted?: number | string }> }).rows?.[0]?.inserted ??
        0,
    );
  }
  const total = proposed.physician + proposed.facility;
  if (total > 0) {
    const day = (deps.now ?? (() => new Date()))().toISOString().slice(0, 10);
    await notifyPlatformOps(deps, {
      kind: "mdm.duplicate_suspected",
      summary: `${total} new suspected duplicate canonical entit${total === 1 ? "y" : "ies"} queued for merge review (physician ${proposed.physician}, facility ${proposed.facility})`,
      details: { proposed },
      correlationId: `m40-duplicate-suspected:${day}`,
    });
  }
  return proposed;
}
