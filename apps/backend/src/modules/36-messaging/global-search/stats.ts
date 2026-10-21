// WP 2.7b C2 (ADR-0058 "Parameter values and the T arithmetic", head-bucket mitigation) - after a rebuild, record per
// (org, key version) the (channel, tag) buckets whose row count exceeds HEAD_BUCKET_ROWS (CHANNEL ID AND BUCKET NUMBER ONLY: no
// plaintext, no token list), the number of distinct stored (channel, tag) values and the total stored rows (the input of the T sizing
// rule, security review H2). With per-channel keys a bucket belongs to one channel, so a head bucket is a (channel, tag) pair; a channel
// whose query lands entirely in head buckets is skipped up front (C3), and the response says the scan was capped.
import type { DbClient } from "@chartwarden/db";
import { HEAD_BUCKET_ROWS, MAX_HEAD_PAIRS } from "@chartwarden/messaging";
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";

export interface IndexStats {
  readonly distinctTags: number;
  readonly totalRows: number;
  /** '<channel uuid>:<tag>' pairs, largest buckets first, at most MAX_HEAD_PAIRS. */
  readonly headBuckets: readonly string[];
}

export const headPairKey = (channelId: string, tag: number): string => `${channelId}:${tag}`;

export async function refreshIndexStats(
  db: DbClient,
  organizationId: string,
  keyVersion: string,
): Promise<IndexStats> {
  return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
    const heads = await tx.execute<{ channel_id: string; tag: number }>(sql`
      SELECT channel_id::text AS channel_id, tag FROM message_search_token
       WHERE organization_id = ${organizationId} AND key_version = ${keyVersion}
       GROUP BY channel_id, tag HAVING count(*) > ${HEAD_BUCKET_ROWS}
       ORDER BY count(*) DESC, channel_id, tag
       LIMIT ${MAX_HEAD_PAIRS}`);
    const totals = await tx.execute<{ distinct_tags: number; total_rows: number }>(sql`
      SELECT count(*)::float8 AS total_rows,
             (SELECT count(*)::float8 FROM (SELECT DISTINCT channel_id, tag FROM message_search_token
                WHERE organization_id = ${organizationId} AND key_version = ${keyVersion}) d) AS distinct_tags
        FROM message_search_token
       WHERE organization_id = ${organizationId} AND key_version = ${keyVersion}`);
    const headBuckets = heads.rows.map((r) => headPairKey(r.channel_id, Number(r.tag)));
    const distinctTags = Math.trunc(Number(totals.rows[0]?.distinct_tags ?? 0));
    const totalRows = Math.trunc(Number(totals.rows[0]?.total_rows ?? 0));
    await tx.execute(sql`
      UPDATE message_search_index_state
         SET distinct_tags = ${distinctTags},
             head_buckets = ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(headBuckets)}::jsonb)),
             stats_at = now(), updated_at = now()
       WHERE organization_id = ${organizationId} AND key_version = ${keyVersion}`);
    return { distinctTags, totalRows, headBuckets };
  });
}
