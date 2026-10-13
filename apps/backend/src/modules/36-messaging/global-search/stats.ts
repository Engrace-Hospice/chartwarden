// WP 2.7b C2 (ADR-0058 "Parameter values and the T arithmetic", head-bucket mitigation) - after a rebuild, record per
// (org, key version) the buckets whose row count exceeds HEAD_BUCKET_ROWS (BUCKET NUMBERS ONLY: no plaintext, no token list)
// and the number of distinct stored tag values. A single-term query landing in a head bucket is refused up front (C3).
import type { DbClient } from "@wardenx/db";
import { HEAD_BUCKET_ROWS } from "@wardenx/messaging";
import { withOrgContext } from "@wardenx/tenancy";
import { sql } from "drizzle-orm";

export interface IndexStats {
  readonly distinctTags: number;
  readonly headBuckets: readonly number[];
}

export async function refreshIndexStats(
  db: DbClient,
  organizationId: string,
  keyVersion: string,
): Promise<IndexStats> {
  return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
    const heads = await tx.execute<{ tag: number }>(sql`
      SELECT tag FROM message_search_token
       WHERE organization_id = ${organizationId} AND key_version = ${keyVersion}
       GROUP BY tag HAVING count(*) > ${HEAD_BUCKET_ROWS}
       ORDER BY tag`);
    const distinct = await tx.execute<{ n: number }>(sql`
      SELECT count(DISTINCT tag)::int AS n FROM message_search_token
       WHERE organization_id = ${organizationId} AND key_version = ${keyVersion}`);
    const headBuckets = heads.rows.map((r) => Number(r.tag));
    const distinctTags = Number(distinct.rows[0]?.n ?? 0);
    await tx.execute(sql`
      UPDATE message_search_index_state
         SET distinct_tags = ${distinctTags},
             head_buckets = ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(headBuckets)}::jsonb)::int),
             stats_at = now(), updated_at = now()
       WHERE organization_id = ${organizationId} AND key_version = ${keyVersion}`);
    return { distinctTags, headBuckets };
  });
}
