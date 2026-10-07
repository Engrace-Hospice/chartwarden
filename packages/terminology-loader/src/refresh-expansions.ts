// @wardenx/terminology-loader — `terminology.refresh_expansions` (M38 §3.1 `refresh-expansions.ts`, §4.3, §7.5).
//
// The materialisation engine is `runRefreshExpansions` in @wardenx/terminology (pure over ports). This wrapper
// adds what a worker needs: failure isolation per value set (one bad set must not stop the rest), a staleness
// measurement for the §7.5 "within 2 minutes" target, and a content-free result.
import {
  type CodeSystemId,
  type ExpansionRow,
  type RefreshExpansionsPorts,
  runRefreshExpansions,
} from "@wardenx/terminology";
import type { LoaderLogger } from "./ports";

/** What the production port must be able to do beyond the pure engine's two methods: write ONE value set. */
export interface ExpansionWriterPort {
  loadMembersForSystem: RefreshExpansionsPorts["loadMembersForSystem"];
  /** Replace the stored expansion of exactly one value set (idempotent). */
  replaceExpansion(valueSetId: string, rows: readonly ExpansionRow[]): Promise<void>;
  /** Ledger one `expanded` entry (counts only). */
  logExpanded(system: CodeSystemId, valueSetCount: number, rowCount: number): Promise<void>;
}

export interface RefreshExpansionsRun {
  readonly valueSetIds: readonly string[];
  readonly rowsWritten: number;
  readonly failedValueSets: readonly string[];
  readonly lagMs: number;
}

/** Recompute every value set that includes `system`. Throws after trying ALL sets if any failed (so the job retries). */
export async function refreshExpansionsForSystem(
  system: CodeSystemId,
  port: ExpansionWriterPort,
  log: LoaderLogger,
  clock: () => number = Date.now,
): Promise<RefreshExpansionsRun> {
  const started = clock();
  const failed: string[] = [];
  const bySet = new Map<string, ExpansionRow[]>();
  const result = await runRefreshExpansions(system, {
    loadMembersForSystem: port.loadMembersForSystem,
    writeExpansion: async (rows) => {
      for (const row of rows) {
        const list = bySet.get(row.valueSetId) ?? [];
        list.push(row);
        bySet.set(row.valueSetId, list);
      }
    },
  });
  for (const [valueSetId, rows] of bySet) {
    try {
      await port.replaceExpansion(valueSetId, rows);
    } catch (err) {
      failed.push(valueSetId);
      log.error(
        { system, valueSetId, reason: err instanceof Error ? err.message : String(err) },
        "value-set expansion refresh failed",
      );
    }
  }
  await port.logExpanded(system, bySet.size - failed.length, result.rowsWritten);
  const run = { ...result, failedValueSets: failed.sort(), lagMs: clock() - started };
  if (failed.length > 0)
    throw new Error(
      `refresh_expansions: ${failed.length} value set(s) failed: ${failed.join(", ")}`,
    );
  return run;
}
