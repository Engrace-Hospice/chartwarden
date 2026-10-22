// ChartWarden - crypto context-label rename, RELEASE 3: the shared scan loop of the read-only label verifier.
//
// After release 3 only the ChartWarden label opens a value, so a stored value is "current" (it opens) or "unreadable" (it does
// not: corrupt, tampered, its key gone, or - the case this tool exists to catch - still sealed under the removed legacy label,
// which can no longer be told apart from corruption). The loop only reads: one keyset page per short transaction, no writes. It
// never logs plaintext, keys or ciphertext: it reports counts and the ids of unreadable rows (row ids are not PHI).

import type { DbClient } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";

/** What a row's stored value opens under. "ignore" = nothing to decide (erased, empty, placeholder, nothing indexed). */
export type RowClass = "current" | "unreadable" | "ignore";

export interface Counts {
  readonly scanned: number;
  /** Rows that open under the one remaining label. */
  readonly current: number;
  /** Rows that do not open (corrupt, tampered, key gone - or still sealed under the removed legacy label). */
  readonly unreadable: number;
  readonly ignored: number;
}

export const emptyCounts: Counts = { scanned: 0, current: 0, unreadable: 0, ignored: 0 };

export function addCounts(a: Counts, b: Counts): Counts {
  return {
    scanned: a.scanned + b.scanned,
    current: a.current + b.current,
    unreadable: a.unreadable + b.unreadable,
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
  /** At most MAX_PROBLEM_IDS row ids that were unreadable. */
  readonly problemIds: readonly string[];
  readonly stoppedBy: "exhausted" | "max_rows" | "interrupted";
}

export interface Scan<R> extends ScanLabel {
  /** One keyset page after `after` (ascending id), read in its own short transaction. */
  page(after: string | null, limit: number): Promise<readonly R[]>;
  idOf(row: R): string;
  /** Decrypt probe. Must not throw for a value that merely fails to open; may throw for an infrastructure fault. */
  classify(row: R): Promise<RowClass>;
}

export interface RunOptions {
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

/** Run one read-only scan to exhaustion (or to the row cap / an interrupt). */
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
      else {
        delta = { ...delta, unreadable: 1 };
        problem(scan.idOf(row));
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
