// WP 2.7b C3 (ADR-0058 decision 8.3) - the two SQL steps of the query path. Both are only COARSE: membership-or-announcement
// bounds cost; `effectivelyVisibleChannels` (the service) is the only access decider. Tags reach SQL ONLY as bound parameters.
//
//   selectQueryChannels  the channels one query searches: the caller's ACTIVE membership channels plus announcement channels, most
//                      recently active first, at most MAX_QUERY_CHANNELS (+1, so the caller can tell the cap was hit). Per-channel
//                      keys make this list the unit of work: every channel costs one tag per term.
//   selectCandidates   transaction 1: (channel, tag) pairs -> messages. GROUP BY (message_id, key_version) HAVING count(DISTINCT tag) = k, joined to
//                      a live message, its channel and the caller's ACTIVE channel_member row (or an announcement channel), in
//                      recency order by a millisecond keyset (the cursor codec carries milliseconds), capped at CANDIDATE_CAP + 1.
//   reselectSurvivors  transaction 2: the authorised survivors again, by id, with the SAME membership join. A member removed
//                      between the two transactions drops out here (it closes the removal race), and the CURRENT row is what is
//                      opened, so an edit or delete in between is honoured.
import { schema } from "@chartwarden/db";
import { CANDIDATE_CAP, MAX_QUERY_CHANNELS } from "@chartwarden/messaging";
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

/**
 * The caller's searchable channels, most recently active first (a channel with no message last, ties by id). Coarse on purpose:
 * `effectivelyVisibleChannels` still decides access per candidate channel. Returns up to MAX_QUERY_CHANNELS + 1 ids.
 */
export async function selectQueryChannels(
  tx: Tx,
  organizationId: string,
  userId: string,
): Promise<string[]> {
  const result = await tx.execute<{ id: string }>(sql`
    SELECT c.id::text AS id
      FROM channel c
      LEFT JOIN channel_member cm
             ON cm.organization_id = c.organization_id AND cm.channel_id = c.id
            AND cm.user_id = ${userId} AND cm.removed_at IS NULL
      LEFT JOIN LATERAL (
            SELECT max(m.created_at) AS last_at FROM message m
             WHERE m.organization_id = c.organization_id AND m.channel_id = c.id) l ON true
     WHERE c.organization_id = ${organizationId}
       AND (cm.user_id IS NOT NULL OR c.channel_kind = 'announcement')
     ORDER BY l.last_at DESC NULLS LAST, c.id
     LIMIT ${MAX_QUERY_CHANNELS + 1}`);
  return result.rows.map((row) => row.id);
}

const ISO_MS = sql`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

export async function selectCandidates(
  tx: Tx,
  organizationId: string,
  userId: string,
  queries: readonly VersionQuery[],
  after: KeysetPosition | null,
): Promise<Candidate[]> {
  if (queries.every((query) => query.channels.length === 0)) return [];
  const values = sql.join(
    queries.flatMap((query) =>
      query.channels.flatMap((channel) =>
        // A message must carry ALL of the channel's distinct tags.
        channel.tags.map(
          (tag) =>
            sql`(${query.keyVersion}::text, ${channel.channelId}::uuid, ${tag}::int, ${channel.tags.length}::int)`,
        ),
      ),
    ),
    sql`, `,
  );
  // On a continuation page the keyset (and the tombstone test) is applied BEFORE the aggregate, so rows already served are not
  // grouped again. Equivalent to filtering afterwards: both predicates depend on the message only, and every token row of a
  // message shares it, so a message is kept or dropped as a whole and `count(DISTINCT tag)` per message is unchanged.
  const early = after
    ? sql`JOIN message m0 ON m0.organization_id = t.organization_id AND m0.id = t.message_id
                AND m0.status <> 'deleted'
                AND (date_trunc('milliseconds', m0.created_at), m0.id)
                    < (${after.createdAtIso}::timestamptz, ${after.id}::uuid)`
    : sql``;
  const result = await tx.execute<CandidateRow>(sql`
    WITH q(key_version, channel_id, tag, k) AS (VALUES ${values}),
    hits AS (
      SELECT t.message_id, t.key_version
        FROM message_search_token t
        JOIN q ON q.key_version = t.key_version AND q.channel_id = t.channel_id AND q.tag = t.tag
        ${early}
       WHERE t.organization_id = ${organizationId}
       GROUP BY t.message_id, t.key_version, q.k
      HAVING count(DISTINCT t.tag) = q.k
    ),
    -- ONE row per message BEFORE the LIMIT: a message indexed under two live key versions must not take two of the 501 slots.
    hit_messages AS (SELECT DISTINCT message_id FROM hits)
    SELECT m.id::text AS id, m.channel_id::text AS channel_id, m.status::text AS status,
           to_char(date_trunc('milliseconds', m.created_at) AT TIME ZONE 'UTC', ${ISO_MS}) AS created_at_iso,
           c.channel_kind::text AS kind, c.subject_id::text AS subject_id, c.is_archived AS is_archived,
           cm.source::text AS member_source
      FROM hit_messages h
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

  // Defensive only: the SQL already yields one row per message.
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
