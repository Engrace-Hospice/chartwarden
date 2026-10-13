// WP 2.7b C2 (ADR-0058 decisions 11 and "Turning OFF" step 4) - resumable rebuild + reconciliation of one tenant's index.
// It serves the initial backfill, the OFF-then-ON recovery (events missed while OFF are never replayed; the next pass finds
// the messages with no rows) and any drift repair.
//
//   sweep   scans the tenant's messages in (created_at, id) order from the `message_search_index_state` checkpoint, indexes
//           the eligible ones that have no rows under the active key version and deletes the rows of ineligible ones
//           (deleted; redacted/pending through the `isRedactedOrPending` port). The checkpoint is saved after every batch, so
//           a crash or a bounded tick resumes where it stopped.
//   verify  when the sweep reaches the end, an independent anti-join looks for ANY remaining drift. Zero drift sets
//           reconciled_at, status='ready' and refreshes the statistics. Drift (a message sent mid-sweep, a failed write) moves
//           the checkpoint just before the first drifting message so the next tick resumes there, not from the start.
//
// A 'ready' index is trusted only while reconciled_at is newer than BOTH the tenant setting's last change and the platform
// flag row's last update (a flip OFF-then-ON in between invalidates it) and younger than RECHECK_AFTER_MS.
// ponytail: each message is its own tenant transaction through the flag-checking writer (2 extra small reads per message);
// batch the writer if the backfill of a very large tenant is too slow. The verify query prefilters on `status='deleted'`
// only; when the redaction marker lands (WP 5.x) the verify scan must evaluate the port on every row, not only on candidates.
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { sql } from "drizzle-orm";
import type { Tx } from "../messaging-write-core";
import { type IndexState, ensureIndexState, saveCheckpoint, setIndexStatus } from "./index-state";
import type { IndexWriter, IndexWriterDeps } from "./index-writer";
import { isEligibleForIndex, neverRedacted } from "./ports";
import { refreshIndexStats } from "./stats";
import type { TenantSearchSettingStore } from "./tenant-setting-store";

export const RECONCILE_BATCH_SIZE = 200;
export const RECONCILE_MAX_BATCHES_PER_RUN = 25;
export const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;
const VERIFY_PAGE_SIZE = 500;

export interface ReconcileDeps extends IndexWriterDeps {
  readonly writer: IndexWriter;
  readonly settings: TenantSearchSettingStore;
  readonly batchSize?: number;
  readonly maxBatches?: number;
  readonly recheckAfterMs?: number;
}

export interface ReconcileSummary {
  readonly state: "off" | "ready" | "building";
  readonly indexed: number;
  readonly removed: number;
}

interface ScanRow {
  readonly id: string;
  readonly status: string;
  readonly createdAt: string;
  readonly indexed: boolean;
  readonly hasAny: boolean;
}

interface Position {
  readonly createdAtText: string;
  readonly messageId: string;
}

const OFF: ReconcileSummary = { state: "off", indexed: 0, removed: 0 };

/** Rows after `after` in (created_at, id) order; `driftOnly` keeps just the candidates for the verify pass. */
async function scan(
  tx: Tx,
  organizationId: string,
  keyVersion: string,
  after: Position | null,
  limit: number,
  driftOnly: boolean,
): Promise<ScanRow[]> {
  const result = await tx.execute<{
    id: string;
    status: string;
    created_at: string;
    indexed: boolean;
    has_any: boolean;
  }>(sql`
    SELECT id, status, created_at, indexed, has_any FROM (
      SELECT m.id::text AS id, m.status::text AS status, m.created_at::text AS created_at,
             m.created_at AS created_ts, m.id AS id_raw,
             EXISTS (SELECT 1 FROM message_search_token t
                      WHERE t.organization_id = m.organization_id AND t.message_id = m.id
                        AND t.key_version = ${keyVersion}) AS indexed,
             EXISTS (SELECT 1 FROM message_search_token t
                      WHERE t.organization_id = m.organization_id AND t.message_id = m.id) AS has_any
        FROM message m
       WHERE m.organization_id = ${organizationId}
         AND (${after?.createdAtText ?? null}::timestamptz IS NULL
              OR (m.created_at, m.id) > (${after?.createdAtText ?? null}::timestamptz, ${after?.messageId ?? null}::uuid))
    ) s
    WHERE ${driftOnly ? sql`(status <> 'deleted' AND NOT indexed) OR (status = 'deleted' AND has_any)` : sql`true`}
    ORDER BY created_ts, id_raw
    LIMIT ${limit}`);
  return result.rows.map((r) => ({
    id: r.id,
    status: r.status,
    createdAt: r.created_at,
    indexed: r.indexed,
    hasAny: r.has_any,
  }));
}

const positionOf = (row: ScanRow): Position => ({
  createdAtText: row.createdAt,
  messageId: row.id,
});

async function predecessorOf(
  tx: Tx,
  organizationId: string,
  at: Position,
): Promise<Position | null> {
  const result = await tx.execute<{ id: string; created_at: string }>(sql`
    SELECT id::text AS id, created_at::text AS created_at FROM message
     WHERE organization_id = ${organizationId}
       AND (created_at, id) < (${at.createdAtText}::timestamptz, ${at.messageId}::uuid)
     ORDER BY created_at DESC, id DESC LIMIT 1`);
  const row = result.rows[0];
  return row ? { createdAtText: row.created_at, messageId: row.id } : null;
}

/** The first message whose index state disagrees with its eligibility, or null for zero drift. */
async function findFirstDrift(
  deps: ReconcileDeps,
  organizationId: string,
  keyVersion: string,
): Promise<Position | null> {
  const isRedactedOrPending = deps.isRedactedOrPending ?? neverRedacted;
  let after: Position | null = null;
  for (;;) {
    const page: ScanRow[] = await withOrgContext(deps.db, { organizationId, userId: "" }, (tx) =>
      scan(tx, organizationId, keyVersion, after, VERIFY_PAGE_SIZE, true),
    );
    for (const row of page) {
      const eligible = isEligibleForIndex(row, isRedactedOrPending);
      if ((eligible && !row.indexed) || (!eligible && row.hasAny)) return positionOf(row);
    }
    const last = page[page.length - 1];
    if (!last || page.length < VERIFY_PAGE_SIZE) return null;
    after = positionOf(last);
  }
}

async function inTenantTx<T>(
  db: DbClient,
  organizationId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withOrgContext(db, { organizationId, userId: "" }, fn);
}

function stillValid(
  state: IndexState,
  since: readonly (Date | null)[],
  now: number,
  recheckAfterMs: number,
): boolean {
  if (state.status !== "ready" || !state.reconciledAt) return false;
  const reconciled = state.reconciledAt.getTime();
  if (now - reconciled >= recheckAfterMs) return false;
  return since.every((s) => s === null || reconciled >= s.getTime());
}

export async function reconcileOrg(
  deps: ReconcileDeps,
  organizationId: string,
): Promise<ReconcileSummary> {
  const batchSize = deps.batchSize ?? RECONCILE_BATCH_SIZE;
  const maxBatches = deps.maxBatches ?? RECONCILE_MAX_BATCHES_PER_RUN;
  const isRedactedOrPending = deps.isRedactedOrPending ?? neverRedacted;

  // Tenant flag first: it defaults OFF, so an inert tenant costs one small read and never touches the platform row.
  const setting = await deps.settings.read(organizationId);
  if (!setting.enabled) return OFF;
  const platform = await deps.platformFlag.read(organizationId);
  if (!platform.enabled) return OFF;

  const keyVersion = await deps.keys.activeVersion(organizationId);
  let state = await inTenantTx(deps.db, organizationId, (tx) =>
    ensureIndexState(tx, organizationId, keyVersion),
  );
  if (
    stillValid(
      state,
      [setting.changedAt, platform.updatedAt],
      Date.now(),
      deps.recheckAfterMs ?? RECHECK_AFTER_MS,
    )
  ) {
    return { state: "ready", indexed: 0, removed: 0 };
  }
  if (state.status !== "building") {
    // A previously trusted (or stale) index must be re-proved: restart the sweep from the beginning.
    await inTenantTx(deps.db, organizationId, async (tx) => {
      await setIndexStatus(tx, organizationId, keyVersion, "building");
      await saveCheckpoint(tx, organizationId, keyVersion, null);
    });
    state = { ...state, status: "building", checkpointCreatedAt: null, checkpointMessageId: null };
  }

  let after: Position | null =
    state.checkpointCreatedAt && state.checkpointMessageId
      ? { createdAtText: state.checkpointCreatedAt, messageId: state.checkpointMessageId }
      : null;
  let indexed = 0;
  let removed = 0;
  let reachedEnd = false;

  for (let batch = 0; batch < maxBatches && !reachedEnd; batch += 1) {
    const rows: ScanRow[] = await inTenantTx(deps.db, organizationId, (tx) =>
      scan(tx, organizationId, keyVersion, after, batchSize, false),
    );
    for (const row of rows) {
      const eligible = isEligibleForIndex(row, isRedactedOrPending);
      if (eligible && !row.indexed) {
        const outcome = await deps.writer.indexMessage(organizationId, row.id);
        if (outcome === "skipped_off") return OFF;
        if (outcome === "indexed") indexed += 1;
      } else if (!eligible && row.hasAny) {
        if ((await deps.writer.removeMessage(organizationId, row.id)) > 0) removed += 1;
      }
    }
    const last = rows[rows.length - 1];
    if (last) {
      after = positionOf(last);
      const checkpoint = after;
      await inTenantTx(deps.db, organizationId, (tx) =>
        saveCheckpoint(tx, organizationId, keyVersion, checkpoint),
      );
    }
    reachedEnd = rows.length < batchSize;
  }
  if (!reachedEnd) return { state: "building", indexed, removed };

  const drift = await findFirstDrift(deps, organizationId, keyVersion);
  if (drift) {
    await inTenantTx(deps.db, organizationId, async (tx) =>
      saveCheckpoint(
        tx,
        organizationId,
        keyVersion,
        await predecessorOf(tx, organizationId, drift),
      ),
    );
    return { state: "building", indexed, removed };
  }
  await inTenantTx(deps.db, organizationId, (tx) =>
    setIndexStatus(tx, organizationId, keyVersion, "ready", { reconciledNow: true }),
  );
  await refreshIndexStats(deps.db, organizationId, keyVersion);
  return { state: "ready", indexed, removed };
}
