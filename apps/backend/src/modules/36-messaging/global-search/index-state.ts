// WP 2.7b C2 (ADR-0058 decision 11) - the per-(org, key version) build state: tag width, resumable checkpoint, last
// reconciliation, statistics. `head_buckets` holds bucket numbers only (never a token); it is scrubbed from the audit images.
import { schema } from "@wardenx/db";
import { PADDING_FLOOR, tagBitsForTotalRows } from "@wardenx/messaging";
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../messaging-write-core";

const STATE = schema.messageSearchIndexStates;

export interface IndexState {
  readonly tagBits: number;
  readonly status: "building" | "ready" | "stale";
  /** Postgres text form of `created_at` (microsecond precision survives; a JS Date would truncate it). */
  readonly checkpointCreatedAt: string | null;
  readonly checkpointMessageId: string | null;
  readonly reconciledAt: Date | null;
}

const stateWhere = (organizationId: string, keyVersion: string) =>
  and(eq(STATE.organizationId, organizationId), eq(STATE.keyVersion, keyVersion));

/**
 * The tag width a NEW index is built at (security review H2): the sizing rule applied to the rows the build is expected to write,
 * the tenant's live messages times the padding floor (the mean message pads to the floor). A later growth check on the real row count
 * (`shouldResizeTagBits`) corrects an estimate that was off by 4x or more.
 */
export async function estimateTagBits(tx: Tx, organizationId: string): Promise<number> {
  const result = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::float8 AS n FROM message
     WHERE organization_id = ${organizationId} AND status <> 'deleted'`);
  return tagBitsForTotalRows(Number(result.rows[0]?.n ?? 0) * PADDING_FLOOR);
}

/** Read the state row, creating it ('building', width from the sizing rule) when the org has none for this key version. */
export async function ensureIndexState(
  tx: Tx,
  organizationId: string,
  keyVersion: string,
): Promise<IndexState> {
  const read = () =>
    tx
      .select({
        tagBits: STATE.tagBits,
        status: STATE.status,
        checkpointCreatedAt: STATE.checkpointCreatedAt,
        checkpointMessageId: STATE.checkpointMessageId,
        reconciledAt: STATE.reconciledAt,
      })
      .from(STATE)
      .where(stateWhere(organizationId, keyVersion))
      .limit(1);
  let rows = await read();
  if (rows.length === 0) {
    await tx
      .insert(STATE)
      .values({ organizationId, keyVersion, tagBits: await estimateTagBits(tx, organizationId) })
      .onConflictDoNothing();
    rows = await read();
  }
  const row = rows[0];
  if (!row) throw new Error("message_search_index_state row missing after insert");
  const checkpoint = await tx.execute<{ created_at: string | null }>(
    // The checkpoint timestamp is read back as text so its microseconds are not lost to a JS Date.
    sql`SELECT checkpoint_created_at::text AS created_at
      FROM message_search_index_state
      WHERE organization_id = ${organizationId} AND key_version = ${keyVersion}`,
  );
  return {
    tagBits: row.tagBits,
    status: row.status as IndexState["status"],
    checkpointCreatedAt: checkpoint.rows[0]?.created_at ?? null,
    checkpointMessageId: row.checkpointMessageId,
    reconciledAt: row.reconciledAt,
  };
}

export async function saveCheckpoint(
  tx: Tx,
  organizationId: string,
  keyVersion: string,
  checkpoint: { readonly createdAtText: string; readonly messageId: string } | null,
): Promise<void> {
  await tx.execute(sql`
    UPDATE message_search_index_state
       SET checkpoint_created_at = ${checkpoint?.createdAtText ?? null}::timestamptz,
           checkpoint_message_id = ${checkpoint?.messageId ?? null}::uuid,
           updated_at = now()
     WHERE organization_id = ${organizationId} AND key_version = ${keyVersion}`);
}

export async function setIndexStatus(
  tx: Tx,
  organizationId: string,
  keyVersion: string,
  status: IndexState["status"],
  opts: { readonly reconciledNow?: boolean } = {},
): Promise<void> {
  await tx
    .update(STATE)
    .set({
      status,
      updatedAt: sql`now()`,
      ...(opts.reconciledNow ? { reconciledAt: sql`now()` } : {}),
    })
    .where(stateWhere(organizationId, keyVersion));
}
