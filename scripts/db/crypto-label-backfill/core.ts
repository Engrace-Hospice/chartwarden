// ChartWarden - crypto context-label rename, RELEASE 2: the shared scan loop of the operator-run label backfill.
//
// Nothing in the database records which label generation a stored value was sealed under, so every module's job is the same
// row-by-row cycle: PROBE (decrypt with the NEW label only; if that fails, with the legacy label only), RE-SEAL the rows that
// open only under the legacy label, VERIFY the new value under the NEW label alone before it is written, and write it with a
// compare-and-swap on the exact old value. That makes a run idempotent (a finished row probes "current" and is never touched
// again), resumable (a killed run is simply run again) and safe against a concurrent writer (the swap matches nothing).
//
// Bounded work: one keyset page is read in its own short transaction, then each re-seal is its own small transaction. No
// transaction ever spans the table. The loop never logs plaintext, keys or ciphertext: it reports counts, and the ids of rows
// that could not be re-sealed (row ids are not PHI).

import type { DbClient } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";

export type Mode = "verify" | "dry-run" | "apply";

/** What a row's stored value opens under. "ignore" = nothing to decide (erased, empty, placeholder, nothing indexed). */
export type RowClass = "current" | "legacy" | "unreadable" | "ignore";

/** The outcome of re-sealing one legacy row. "skipped" = a concurrent change or a legal hold; the next run sees the row again. */
export type WriteResult = "resealed" | "skipped" | "failed";

export interface Counts {
  readonly scanned: number;
  /** Rows that already open under the NEW label. */
  readonly current: number;
  /** Rows that open ONLY under the legacy label: the release-3 gate is this number being zero. */
  readonly legacyOnly: number;
  /** Rows re-sealed (apply) by this run. */
  readonly resealed: number;
  /** Rows a dry run would re-seal. */
  readonly wouldReseal: number;
  /** Rows that open under neither label (corrupt, tampered, key gone). Never touched. */
  readonly unreadable: number;
  /** Rows left for the next run (concurrent change, legal hold). */
  readonly skipped: number;
  /** Rows whose re-seal did not verify or could not be written. Never overwritten. */
  readonly failed: number;
  readonly ignored: number;
}

export const emptyCounts: Counts = {
  scanned: 0,
  current: 0,
  legacyOnly: 0,
  resealed: 0,
  wouldReseal: 0,
  unreadable: 0,
  skipped: 0,
  failed: 0,
  ignored: 0,
};

export function addCounts(a: Counts, b: Counts): Counts {
  return {
    scanned: a.scanned + b.scanned,
    current: a.current + b.current,
    legacyOnly: a.legacyOnly + b.legacyOnly,
    resealed: a.resealed + b.resealed,
    wouldReseal: a.wouldReseal + b.wouldReseal,
    unreadable: a.unreadable + b.unreadable,
    skipped: a.skipped + b.skipped,
    failed: a.failed + b.failed,
    ignored: a.ignored + b.ignored,
  };
}

export interface ScanLabel {
  readonly module: string;
  readonly table: string;
  /** Null for a platform-wide table (M35). */
  readonly organizationId: string | null;
}

export interface TableReport extends ScanLabel {
  readonly counts: Counts;
  /** At most MAX_FAILED_IDS row ids that were unreadable or failed to re-seal. */
  readonly problemIds: readonly string[];
  readonly stoppedBy: "exhausted" | "max_rows" | "interrupted";
}

export interface Scan<R> extends ScanLabel {
  /** One keyset page after `after` (ascending id), read in its own short transaction. */
  page(after: string | null, limit: number): Promise<readonly R[]>;
  idOf(row: R): string;
  /** Decrypt probe. Must not throw for a value that merely fails to open; may throw for an infrastructure fault. */
  classify(row: R): Promise<RowClass>;
  /**
   * Re-seal a row that probed "legacy": seal under the WRITE label, open it under the NEW label alone and compare, then write
   * with a compare-and-swap on the old value, in its own transaction. Never writes a value that did not verify.
   */
  reseal(row: R): Promise<WriteResult>;
}

export interface RunOptions {
  readonly mode: Mode;
  readonly batchSize: number;
  readonly pauseMs?: number;
  /** Stop after examining this many rows (the next run resumes by probing again). */
  readonly maxRows?: number;
  /** Polled between rows; true stops the run cleanly (SIGINT). */
  readonly interrupted?: () => boolean;
  /** Counts only. */
  readonly onBatch?: (progress: { label: ScanLabel; counts: Counts }) => void;
}

export const DEFAULT_BATCH_SIZE = 100;
const MAX_PROBLEM_IDS = 20;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Run one scan to exhaustion (or to the row cap / an interrupt). */
export async function runScan<R>(scan: Scan<R>, opts: RunOptions): Promise<TableReport> {
  const batchSize = Math.max(1, opts.batchSize);
  let counts = emptyCounts;
  const problemIds: string[] = [];
  let after: string | null = null;
  let stoppedBy: TableReport["stoppedBy"] = "exhausted";
  const problem = (id: string) => {
    if (problemIds.length < MAX_PROBLEM_IDS) problemIds.push(id);
  };

  scanning: for (;;) {
    const room =
      opts.maxRows === undefined ? batchSize : Math.min(batchSize, opts.maxRows - counts.scanned);
    if (room <= 0) {
      stoppedBy = "max_rows";
      break;
    }
    const rows = await scan.page(after, room);
    if (rows.length === 0) break;
    const last = rows[rows.length - 1] as R;
    after = scan.idOf(last);
    for (const row of rows) {
      if (opts.interrupted?.()) {
        stoppedBy = "interrupted";
        break scanning;
      }
      const klass = await scan.classify(row);
      let delta: Partial<Counts> = { scanned: 1 };
      if (klass === "current") delta = { ...delta, current: 1 };
      else if (klass === "ignore") delta = { ...delta, ignored: 1 };
      else if (klass === "unreadable") {
        delta = { ...delta, unreadable: 1 };
        problem(scan.idOf(row));
      } else if (opts.mode === "verify") {
        delta = { ...delta, legacyOnly: 1 };
      } else if (opts.mode === "dry-run") {
        delta = { ...delta, legacyOnly: 1, wouldReseal: 1 };
      } else {
        const written = await scan.reseal(row);
        // A resealed row is no longer legacy-only; a skipped or failed one still is.
        if (written === "resealed") delta = { ...delta, resealed: 1 };
        else {
          delta = {
            ...delta,
            legacyOnly: 1,
            ...(written === "skipped" ? { skipped: 1 } : { failed: 1 }),
          };
          if (written === "failed") problem(scan.idOf(row));
        }
      }
      counts = addCounts(counts, { ...emptyCounts, ...delta });
    }
    opts.onBatch?.({ label: scan, counts });
    if (opts.pauseMs) await sleep(opts.pauseMs);
  }
  return {
    module: scan.module,
    table: scan.table,
    organizationId: scan.organizationId,
    counts,
    problemIds,
    stoppedBy,
  };
}

/** The rows of a drizzle `execute()` result (node-postgres driver). */
export function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

/** One short tenant transaction as the system actor: RLS-correct (`app.org_id` set), never a request context. */
export function inOrg<T>(
  db: DbClient,
  organizationId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withOrgContext(db, systemOrgContext(organizationId), fn);
}

export type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** Swallow a decrypt failure into `undefined`: the probe asks "does it open?", never "why not". */
export async function tryOpen<T>(open: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await open();
  } catch {
    return undefined;
  }
}
