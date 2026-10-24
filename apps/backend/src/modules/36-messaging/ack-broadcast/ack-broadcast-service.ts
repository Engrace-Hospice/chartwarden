// apps/backend/src/modules/36-messaging/ack-broadcast/ack-broadcast-service.ts - M36 WP 6.8 (ADR-0097, PROPOSED) over Postgres.
//
//  - create: the AUTHOR of an announcement requires acknowledgment; the audience (every active member except the author) is frozen now.
//  - detail / list: the supervisor's view. Counts are exact over the whole frozen audience; people are paged (never silently cut).
//  - mine / acknowledge: the recipient's own list and their one explicit, idempotent, database-clock acknowledgment.
// Opening an announcement writes a message_receipt (announcement-receipts.ts) and nothing here: the two facts never mix. Every statement
// runs under withOrgContext (FORCE RLS is the backstop; the guard triggers of migration 1200 refuse a forged write).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  ACK_BROADCAST_FLAG_KEY,
  ACK_BROADCAST_LIST_MAX,
  ACK_BROADCAST_MAX_AUDIENCE,
  type AckBroadcastAcknowledged,
  type AckBroadcastCounts,
  type AckBroadcastCreated,
  type AckBroadcastDetail,
  type AckBroadcastFilter,
  type AckBroadcastMine,
  type AckBroadcastPerson,
  type AckBroadcastState,
  type AckBroadcastSummary,
  ChartWardenError,
  NotFoundError,
} from "@chartwarden/types";
import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";

const BC = schema.messageAckBroadcasts;
const RC = schema.messageAckBroadcastRecipients;
const MSG = schema.messages;
const CH = schema.channels;
const MEMBERSHIP = schema.memberships;
const USER = schema.users;

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const INSERT_CHUNK = 1000;
const staffName = (name: string | null): string => name?.trim() || "Staff member";
const notFound = (): NotFoundError => new NotFoundError("Not found");

export interface AckBroadcastFlagReader {
  forOrg(organizationId: string): Promise<Record<string, boolean>>;
}

export interface AckBroadcastService {
  /** The tenant flag, read on every call (a kill switch lands at once). Absent reader => off. */
  enabled(orgId: string): Promise<boolean>;
  create(orgId: string, input: { userId: string; messageId: string }): Promise<AckBroadcastCreated>;
  detail(
    orgId: string,
    input: {
      userId: string;
      messageId: string;
      filter: AckBroadcastFilter;
      limit: number;
      offset: number;
    },
  ): Promise<AckBroadcastDetail>;
  list(orgId: string, input: { userId: string }): Promise<readonly AckBroadcastSummary[]>;
  mine(orgId: string, input: { userId: string }): Promise<readonly AckBroadcastMine[]>;
  acknowledge(
    orgId: string,
    input: { userId: string; messageId: string },
  ): Promise<AckBroadcastAcknowledged>;
}

/** Per-recipient state (pure; unit-tested). Acknowledged wins; then "no longer an active member"; then whether it was displayed. */
export function classifyRecipient(row: {
  acknowledgedAt: Date | string | null;
  eligible: boolean;
  openedAt: Date | string | null;
}): AckBroadcastState {
  if (row.acknowledgedAt) return "acknowledged";
  if (!row.eligible) return "ineligible";
  return row.openedAt ? "opened" : "not_opened";
}

interface PersonRow extends Record<string, unknown> {
  user_id: string;
  name: string | null;
  acknowledged_at: Date | string | null;
  eligible: boolean;
  opened_at: Date | string | null;
}

const iso = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

/** One row per frozen recipient with the three facts the state is made of. EXISTS keeps a person with two memberships at one row. */
const recipientFacts = (orgId: string, broadcastId: string, messageId: string) => sql`
  SELECT r.user_id, u.name, r.acknowledged_at,
         (u.status = 'active' AND EXISTS (
            SELECT 1 FROM ${MEMBERSHIP} m
             WHERE m.organization_id = r.organization_id AND m.user_id = r.user_id AND m.status = 'active')) AS eligible,
         (SELECT min(mr.read_at) FROM message_receipt mr
           WHERE mr.organization_id = r.organization_id AND mr.message_id = ${messageId}::uuid
             AND mr.user_id = r.user_id AND mr.status = 'read') AS opened_at
    FROM message_ack_broadcast_recipient r
    JOIN "user" u ON u.id = r.user_id
   WHERE r.organization_id = ${orgId}::uuid AND r.broadcast_id = ${broadcastId}::uuid`;

const FILTER_SQL: Record<AckBroadcastFilter, ReturnType<typeof sql>> = {
  all: sql`TRUE`,
  acknowledged: sql`acknowledged_at IS NOT NULL`,
  ineligible: sql`acknowledged_at IS NULL AND NOT eligible`,
  pending: sql`acknowledged_at IS NULL AND eligible`,
};

async function activeRecipientIds(tx: Tx, orgId: string, authorUserId: string): Promise<string[]> {
  const rows = await tx
    .select({ userId: USER.id })
    .from(MEMBERSHIP)
    .innerJoin(USER, eq(USER.id, MEMBERSHIP.userId))
    .where(
      and(
        eq(MEMBERSHIP.organizationId, orgId),
        eq(MEMBERSHIP.status, "active"),
        eq(USER.status, "active"),
        ne(USER.id, authorUserId),
      ),
    )
    .orderBy(asc(USER.id));
  return rows.map((r) => r.userId);
}

type BroadcastRow = { id: string; messageId: string; channelId: string; createdAt: Date };

/** `createdBy` limits to the caller's own broadcasts; `live` drops broadcasts whose announcement was soft-deleted. */
async function broadcastOf(
  tx: Tx,
  orgId: string,
  messageId: string,
  opts: { createdBy?: string; live?: boolean } = {},
): Promise<BroadcastRow | null> {
  const rows = (await tx
    .select({ id: BC.id, messageId: BC.messageId, channelId: BC.channelId, createdAt: BC.createdAt })
    .from(BC)
    .innerJoin(MSG, and(eq(MSG.organizationId, BC.organizationId), eq(MSG.id, BC.messageId)))
    .where(
      and(
        eq(BC.organizationId, orgId),
        eq(BC.messageId, messageId),
        opts.createdBy ? eq(BC.createdBy, opts.createdBy) : undefined,
        opts.live ? isNull(MSG.deletedAt) : undefined,
      ),
    )
    .limit(1)) as BroadcastRow[];
  return rows[0] ?? null;
}

const num = (v: string | number | undefined | null): number => Number(v ?? 0);

interface BatchCountRow extends Record<string, unknown> {
  broadcast_id: string;
  audience: string | number | null;
  acknowledged: string | number | null;
  opened: string | number | null;
  not_opened: string | number | null;
  ineligible: string | number | null;
  outside: string | number;
}

/**
 * Exact counts for every given broadcast in ONE aggregate (no per-broadcast round trips). "Outside the audience" is active staff, but the
 * author, who are not in the frozen audience: joined later, or missed. Said, never silently added.
 */
async function countsFor(
  tx: Tx,
  orgId: string,
  bs: readonly BroadcastRow[],
): Promise<Map<string, AckBroadcastCounts>> {
  const out = new Map<string, AckBroadcastCounts>();
  if (bs.length === 0) return out;
  const ids = sql.join(
    bs.map((b) => sql`${b.id}::uuid`),
    sql`, `,
  );
  const res = await tx.execute<BatchCountRow>(sql`
    WITH b AS (
      SELECT bc.id, bc.message_id, msg.author_user_id
        FROM ${BC} bc JOIN ${MSG} msg ON msg.organization_id = bc.organization_id AND msg.id = bc.message_id
       WHERE bc.organization_id = ${orgId}::uuid AND bc.id IN (${ids})),
    rd AS (
      SELECT mr.message_id, mr.user_id, min(mr.read_at) AS read_at
        FROM message_receipt mr
       WHERE mr.organization_id = ${orgId}::uuid AND mr.status = 'read' AND mr.message_id IN (SELECT message_id FROM b)
       GROUP BY mr.message_id, mr.user_id),
    f AS (
      SELECT r.broadcast_id, r.acknowledged_at, rd.read_at AS opened_at,
             (u.status = 'active' AND EXISTS (
                SELECT 1 FROM ${MEMBERSHIP} m
                 WHERE m.organization_id = r.organization_id AND m.user_id = r.user_id AND m.status = 'active')) AS eligible
        FROM message_ack_broadcast_recipient r
        JOIN b ON b.id = r.broadcast_id
        JOIN "user" u ON u.id = r.user_id
        LEFT JOIN rd ON rd.message_id = b.message_id AND rd.user_id = r.user_id
       WHERE r.organization_id = ${orgId}::uuid),
    c AS (
      SELECT broadcast_id,
             count(*) AS audience,
             count(*) FILTER (WHERE acknowledged_at IS NOT NULL) AS acknowledged,
             count(*) FILTER (WHERE acknowledged_at IS NULL AND eligible AND opened_at IS NOT NULL) AS opened,
             count(*) FILTER (WHERE acknowledged_at IS NULL AND eligible AND opened_at IS NULL) AS not_opened,
             count(*) FILTER (WHERE acknowledged_at IS NULL AND NOT eligible) AS ineligible
        FROM f GROUP BY broadcast_id)
    SELECT b.id AS broadcast_id, c.audience, c.acknowledged, c.opened, c.not_opened, c.ineligible,
           (SELECT count(*)
              FROM ${MEMBERSHIP} m JOIN "user" u ON u.id = m.user_id
             WHERE m.organization_id = ${orgId}::uuid AND m.status = 'active' AND u.status = 'active'
               AND (b.author_user_id IS NULL OR m.user_id <> b.author_user_id)
               AND NOT EXISTS (SELECT 1 FROM message_ack_broadcast_recipient r
                                WHERE r.organization_id = m.organization_id AND r.broadcast_id = b.id AND r.user_id = m.user_id)) AS outside
      FROM b LEFT JOIN c ON c.broadcast_id = b.id`);
  for (const row of res.rows) {
    const opened = num(row.opened);
    const notOpened = num(row.not_opened);
    out.set(row.broadcast_id, {
      audience: num(row.audience),
      acknowledged: num(row.acknowledged),
      pending: opened + notOpened,
      opened,
      notOpened,
      ineligible: num(row.ineligible),
      outsideAudience: num(row.outside),
    });
  }
  return out;
}

const EMPTY_COUNTS: AckBroadcastCounts = {
  audience: 0,
  acknowledged: 0,
  pending: 0,
  opened: 0,
  notOpened: 0,
  ineligible: 0,
  outsideAudience: 0,
};

const toSummary = (b: BroadcastRow, counts: AckBroadcastCounts | undefined): AckBroadcastSummary => ({
  messageId: b.messageId,
  channelId: b.channelId,
  createdAt: b.createdAt.toISOString(),
  counts: counts ?? EMPTY_COUNTS,
});

const summaryOf = async (tx: Tx, orgId: string, b: BroadcastRow): Promise<AckBroadcastSummary> =>
  toSummary(b, (await countsFor(tx, orgId, [b])).get(b.id));

export function createAckBroadcastService(deps: {
  db: DbClient;
  flags?: AckBroadcastFlagReader | undefined;
}): AckBroadcastService {
  const { db } = deps;
  return {
    async enabled(orgId) {
      if (!deps.flags) return false;
      return (await deps.flags.forOrg(orgId))[ACK_BROADCAST_FLAG_KEY] === true;
    },

    async create(orgId, input) {
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        const own = await tx
          .select({ id: MSG.id })
          .from(MSG)
          .innerJoin(CH, and(eq(CH.id, MSG.channelId), eq(CH.organizationId, MSG.organizationId)))
          .where(
            and(
              eq(MSG.organizationId, orgId),
              eq(MSG.id, input.messageId),
              eq(MSG.authorUserId, input.userId),
              eq(CH.channelKind, "announcement"),
              isNull(MSG.deletedAt),
            ),
          )
          .limit(1);
        // One answer for unknown, someone else's, deleted and not-an-announcement: only the author may require acknowledgment.
        if (!own[0]) throw notFound();
        const existing = await broadcastOf(tx, orgId, input.messageId);
        if (existing) return { ...(await summaryOf(tx, orgId, existing)), created: false };

        const audience = await activeRecipientIds(tx, orgId, input.userId);
        if (audience.length > ACK_BROADCAST_MAX_AUDIENCE) {
          throw new ChartWardenError(
            "ACK_BROADCAST_AUDIENCE_TOO_LARGE",
            `This organization has more than ${ACK_BROADCAST_MAX_AUDIENCE} active members; an acknowledgment broadcast needs a complete audience and cannot be created.`,
            422,
          );
        }
        const inserted = (await tx
          .insert(BC)
          .values({
            organizationId: orgId,
            messageId: input.messageId,
            channelId: input.messageId, // replaced by the guard from the message itself
            createdBy: input.userId,
          })
          .onConflictDoNothing()
          .returning({
            id: BC.id,
            messageId: BC.messageId,
            channelId: BC.channelId,
            createdAt: BC.createdAt,
          })) as BroadcastRow[];
        const row = inserted[0];
        if (!row) {
          const raced = await broadcastOf(tx, orgId, input.messageId);
          if (!raced) throw notFound();
          return { ...(await summaryOf(tx, orgId, raced)), created: false };
        }
        for (let i = 0; i < audience.length; i += INSERT_CHUNK) {
          await tx.insert(RC).values(
            audience.slice(i, i + INSERT_CHUNK).map((userId) => ({
              organizationId: orgId,
              broadcastId: row.id,
              userId,
            })),
          );
        }
        return { ...(await summaryOf(tx, orgId, row)), created: true };
      });
    },

    async detail(orgId, input) {
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        // Only the broadcast's creator reads who has not acknowledged; anyone else gets the same 404 as an unknown id (ADR-0097 D5).
        const b = await broadcastOf(tx, orgId, input.messageId, { createdBy: input.userId, live: true });
        if (!b) throw notFound();
        const summary = await summaryOf(tx, orgId, b);
        const res = await tx.execute<PersonRow>(sql`
          WITH f AS (${recipientFacts(orgId, b.id, b.messageId)})
          SELECT * FROM f WHERE ${FILTER_SQL[input.filter]}
           ORDER BY lower(coalesce(name, '')), user_id
           LIMIT ${input.limit + 1} OFFSET ${input.offset}`);
        const page = res.rows.slice(0, input.limit);
        const people: AckBroadcastPerson[] = page.map((r) => ({
          userId: r.user_id,
          displayName: staffName(r.name),
          state: classifyRecipient({
            acknowledgedAt: r.acknowledged_at,
            eligible: r.eligible,
            openedAt: r.opened_at,
          }),
          openedAt: iso(r.opened_at),
          acknowledgedAt: iso(r.acknowledged_at),
        }));
        return {
          ...summary,
          filter: input.filter,
          offset: input.offset,
          hasMore: res.rows.length > input.limit,
          people,
        };
      });
    },

    async list(orgId, input) {
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        const rows = (await tx
          .select({
            id: BC.id,
            messageId: BC.messageId,
            channelId: BC.channelId,
            createdAt: BC.createdAt,
          })
          .from(BC)
          .innerJoin(MSG, and(eq(MSG.organizationId, BC.organizationId), eq(MSG.id, BC.messageId)))
          .where(and(eq(BC.organizationId, orgId), eq(BC.createdBy, input.userId), isNull(MSG.deletedAt)))
          .orderBy(desc(BC.createdAt), desc(BC.id))
          .limit(ACK_BROADCAST_LIST_MAX)) as BroadcastRow[];
        const counts = await countsFor(tx, orgId, rows);
        return rows.map((b) => toSummary(b, counts.get(b.id)));
      });
    },

    async mine(orgId, input) {
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        const rows = await tx
          .select({
            messageId: BC.messageId,
            channelId: BC.channelId,
            createdAt: BC.createdAt,
            acknowledgedAt: RC.acknowledgedAt,
          })
          .from(RC)
          .innerJoin(BC, and(eq(BC.organizationId, RC.organizationId), eq(BC.id, RC.broadcastId)))
          .innerJoin(MSG, and(eq(MSG.organizationId, BC.organizationId), eq(MSG.id, BC.messageId)))
          .where(and(eq(RC.organizationId, orgId), eq(RC.userId, input.userId), isNull(MSG.deletedAt)))
          .orderBy(desc(BC.createdAt), desc(BC.id))
          .limit(ACK_BROADCAST_LIST_MAX);
        return rows.map((r) => ({
          messageId: r.messageId,
          channelId: r.channelId,
          createdAt: r.createdAt.toISOString(),
          acknowledgedAt: r.acknowledgedAt ? r.acknowledgedAt.toISOString() : null,
        }));
      });
    },

    async acknowledge(orgId, input) {
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        const b = await broadcastOf(tx, orgId, input.messageId, { live: true });
        if (!b) throw notFound();
        const mine = (await tx
          .select({ id: RC.id, acknowledgedAt: RC.acknowledgedAt })
          .from(RC)
          .where(
            and(
              eq(RC.organizationId, orgId),
              eq(RC.broadcastId, b.id),
              eq(RC.userId, input.userId),
            ),
          )
          .limit(1)) as Array<{ id: string; acknowledgedAt: Date | null }>;
        // Not in the frozen audience (the author included) is the same answer as an unknown announcement.
        if (!mine[0]) throw notFound();
        if (mine[0].acknowledgedAt) {
          return {
            messageId: b.messageId,
            acknowledgedAt: mine[0].acknowledgedAt.toISOString(),
            already: true,
          };
        }
        const active = await tx.execute<{ ok: boolean }>(sql`
          SELECT (u.status = 'active' AND EXISTS (
                    SELECT 1 FROM ${MEMBERSHIP} m
                     WHERE m.organization_id = ${orgId}::uuid AND m.user_id = u.id AND m.status = 'active')) AS ok
            FROM "user" u WHERE u.id = ${input.userId}::uuid`);
        if (!active.rows[0]?.ok) throw notFound();
        const updated = (await tx
          .update(RC)
          .set({ acknowledgedAt: sql`now()` })
          .where(and(eq(RC.id, mine[0].id), isNull(RC.acknowledgedAt)))
          .returning({ acknowledgedAt: RC.acknowledgedAt })) as Array<{ acknowledgedAt: Date | null }>;
        const at = updated[0]?.acknowledgedAt;
        if (at) return { messageId: b.messageId, acknowledgedAt: at.toISOString(), already: false };
        // A concurrent acknowledgment won the race: the original instant stands.
        const again = (await tx
          .select({ acknowledgedAt: RC.acknowledgedAt })
          .from(RC)
          .where(eq(RC.id, mine[0].id))
          .limit(1)) as Array<{ acknowledgedAt: Date | null }>;
        if (!again[0]?.acknowledgedAt) throw notFound();
        return {
          messageId: b.messageId,
          acknowledgedAt: again[0].acknowledgedAt.toISOString(),
          already: true,
        };
      });
    },
  };
}
