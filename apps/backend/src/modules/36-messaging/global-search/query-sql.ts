// WP 2.7b C3 (ADR-0058 decision 8.3) - the two SQL steps of the query path. Both are only COARSE: membership-or-announcement
// bounds cost; `effectivelyVisibleChannels` (the service) is the only access decider. Tags reach SQL ONLY as bound parameters.
//
//   selectCandidates   transaction 1: tags -> messages. GROUP BY (message_id, key_version) HAVING count(DISTINCT tag) = k, joined to
//                      a live message, its channel and the caller's ACTIVE channel_member row (or an announcement channel), in
//                      recency order by a millisecond keyset (the cursor codec carries milliseconds), capped at CANDIDATE_CAP + 1.
//   reselectSurvivors  transaction 2: the authorised survivors again, by id, with the SAME membership join. A member removed
//                      between the two transactions drops out here (it closes the removal race), and the CURRENT row is what is
//                      opened, so an edit or delete in between is honoured.
import { schema } from "@wardenx/db";
import { CANDIDATE_CAP } from "@wardenx/messaging";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { MESSAGE_ROW_COLUMNS, type MessageRow } from "../messaging-message-hydration";
import type { Tx } from "../messaging-write-core";
import type { VersionQuery } from "./query-terms";

const MSG = schema.messages;
const CH = schema.channels;
const CM = schema.channelMembers;
const USER = schema.users;

export interface Candidate {
  readonly id: string;
  readonly channelId: string;
  readonly status: string;
  /** Millisecond ISO instant: exactly what the cursor codec carries. */
  readonly createdAtIso: string;
  readonly kind: "dm" | "care_team" | "announcement" | string;
  readonly subjectId: string | null;
  readonly isArchived: boolean;
  /** The caller's active membership source; null for an announcement channel read without a membership row. */
  readonly memberSource: string | null;
}

export interface KeysetPosition {
  readonly createdAtIso: string;
  readonly id: string;
}

interface CandidateRow extends Record<string, unknown> {
  id: string;
  channel_id: string;
  status: string;
  created_at_iso: string;
  kind: string;
  subject_id: string | null;
  is_archived: boolean;
  member_source: string | null;
}

const ISO_MS = sql`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

export async function selectCandidates(
  tx: Tx,
  organizationId: string,
  userId: string,
  queries: readonly VersionQuery[],
  after: KeysetPosition | null,
): Promise<Candidate[]> {
  const values = sql.join(
    queries.flatMap((query) =>
      query.tags.map(
        (tag) => sql`(${query.keyVersion}::text, ${tag}::int, ${query.tags.length}::int)`,
      ),
    ),
    sql`, `,
  );
  const result = await tx.execute<CandidateRow>(sql`
    WITH q(key_version, tag, k) AS (VALUES ${values}),
    hits AS (
      SELECT t.message_id, t.key_version
        FROM message_search_token t
        JOIN q ON q.key_version = t.key_version AND q.tag = t.tag
       WHERE t.organization_id = ${organizationId}
       GROUP BY t.message_id, t.key_version, q.k
      HAVING count(DISTINCT t.tag) = q.k
    )
    SELECT m.id::text AS id, m.channel_id::text AS channel_id, m.status::text AS status,
           to_char(date_trunc('milliseconds', m.created_at) AT TIME ZONE 'UTC', ${ISO_MS}) AS created_at_iso,
           c.channel_kind::text AS kind, c.subject_id::text AS subject_id, c.is_archived AS is_archived,
           cm.source::text AS member_source
      FROM hits h
      JOIN message m ON m.organization_id = ${organizationId} AND m.id = h.message_id AND m.status <> 'deleted'
      JOIN channel c ON c.organization_id = m.organization_id AND c.id = m.channel_id
      LEFT JOIN channel_member cm
             ON cm.organization_id = m.organization_id AND cm.channel_id = m.channel_id
            AND cm.user_id = ${userId} AND cm.removed_at IS NULL
     WHERE (cm.user_id IS NOT NULL OR c.channel_kind = 'announcement')
       AND (${after?.createdAtIso ?? null}::timestamptz IS NULL
            OR (date_trunc('milliseconds', m.created_at), m.id)
               < (${after?.createdAtIso ?? null}::timestamptz, ${after?.id ?? null}::uuid))
     ORDER BY date_trunc('milliseconds', m.created_at) DESC, m.id DESC
     LIMIT ${CANDIDATE_CAP + 1}`);

  // A message indexed under two live key versions appears twice; keep the first (recency order is unchanged).
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const row of result.rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    candidates.push({
      id: row.id,
      channelId: row.channel_id,
      status: row.status,
      createdAtIso: row.created_at_iso,
      kind: row.kind,
      subjectId: row.subject_id,
      isArchived: row.is_archived,
      memberSource: row.member_source,
    });
  }
  return candidates;
}

export interface SurvivorRow extends MessageRow {
  readonly bodySha256: string;
  readonly kind: string;
  readonly subjectId: string | null;
  readonly isArchived: boolean;
}

/** The current rows of the authorised survivors, re-checked against live membership (or an announcement channel). */
export async function reselectSurvivors(
  tx: Tx,
  organizationId: string,
  userId: string,
  messageIds: readonly string[],
): Promise<Map<string, SurvivorRow>> {
  if (messageIds.length === 0) return new Map();
  const rows = await tx
    .select({
      ...MESSAGE_ROW_COLUMNS,
      authorDisplayName: USER.name,
      bodySha256: MSG.bodySha256,
      kind: CH.channelKind,
      subjectId: CH.subjectId,
      isArchived: CH.isArchived,
    })
    .from(MSG)
    .innerJoin(CH, and(eq(CH.organizationId, MSG.organizationId), eq(CH.id, MSG.channelId)))
    .leftJoin(
      CM,
      and(
        eq(CM.organizationId, MSG.organizationId),
        eq(CM.channelId, MSG.channelId),
        eq(CM.userId, userId),
        isNull(CM.removedAt),
      ),
    )
    .leftJoin(USER, eq(USER.id, MSG.authorUserId))
    .where(
      and(
        eq(MSG.organizationId, organizationId),
        inArray(MSG.id, [...messageIds]),
        sql`${MSG.status} <> 'deleted'`,
        or(sql`${CM.userId} IS NOT NULL`, sql`${CH.channelKind} = 'announcement'`),
      ),
    );
  return new Map(rows.map((row) => [row.id, row]));
}
