// apps/backend/src/modules/36-messaging/emergency/emergency-service.ts - M36 ADR-0106 (PROPOSED), over Postgres (migration 1300).
//
//  - declare: the AUTHOR of a live message makes it an emergency. The audience (every active member of its channel but the author) is frozen
//    now, in the same transaction, and one `m36.emergency.sent` outbox event per recipient commits with it.
//  - detail / list: the AUTHOR's view of who has and has not acknowledged (anyone else: the uniform 404).
//  - mine / acknowledge: the recipient's own list and their one explicit, idempotent, database-clock acknowledgment.
// Every statement runs under withOrgContext; FORCE RLS and the guard triggers of migration 1300 are the backstop (a forged write is refused).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  ChartWardenError,
  EMERGENCY_FLAG_KEY,
  EMERGENCY_LIST_MAX,
  EMERGENCY_MAX_AUDIENCE,
  type EmergencyAcknowledged,
  type EmergencyCounts,
  type EmergencyCreated,
  type EmergencyDetail,
  type EmergencyMine,
  type EmergencySummary,
  NotFoundError,
} from "@chartwarden/types";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { HintOutboxPort } from "../message-hint-events";
import { publishEmergencySent } from "./emergency-events";

const EM = schema.messageEmergencies;
const RC = schema.messageEmergencyRecipients;
const MSG = schema.messages;
const MEMBER = schema.channelMembers;
const MEMBERSHIP = schema.memberships;
const USER = schema.users;

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const INSERT_CHUNK = 500;
const notFound = (): NotFoundError => new NotFoundError("Not found");
const staffName = (name: string | null): string => name?.trim() || "Staff member";
const num = (v: string | number | null | undefined): number => Number(v ?? 0);

export interface EmergencyFlagReader {
  forOrg(organizationId: string): Promise<Record<string, boolean>>;
}

export interface EmergencyService {
  /** The tenant flag, read on every call (a kill switch lands at once). Absent reader => off. */
  enabled(orgId: string): Promise<boolean>;
  declare(orgId: string, input: { userId: string; messageId: string }): Promise<EmergencyCreated>;
  detail(orgId: string, input: { userId: string; messageId: string }): Promise<EmergencyDetail>;
  list(orgId: string, input: { userId: string }): Promise<readonly EmergencySummary[]>;
  mine(orgId: string, input: { userId: string }): Promise<readonly EmergencyMine[]>;
  acknowledge(
    orgId: string,
    input: { userId: string; emergencyId: string },
  ): Promise<EmergencyAcknowledged>;
}

type EmergencyRow = {
  id: string;
  messageId: string;
  channelId: string;
  createdBy: string;
  createdAt: Date;
  deadlineAt: Date;
};
const COLUMNS = {
  id: EM.id,
  messageId: EM.messageId,
  channelId: EM.channelId,
  createdBy: EM.createdBy,
  createdAt: EM.createdAt,
  deadlineAt: EM.deadlineAt,
};

/** The "past deadline" marker (pure): the deadline passed and somebody still has not acknowledged. */
export function isEmergencyPastDeadline(
  e: { deadlineAt: Date },
  pending: number,
  now: Date,
): boolean {
  return pending > 0 && e.deadlineAt.getTime() <= now.getTime();
}

const toSummary = (e: EmergencyRow, counts: EmergencyCounts): EmergencySummary => ({
  emergencyId: e.id,
  messageId: e.messageId,
  channelId: e.channelId,
  createdAt: e.createdAt.toISOString(),
  deadlineAt: e.deadlineAt.toISOString(),
  counts,
  pastDeadline: isEmergencyPastDeadline(e, counts.pending, new Date()),
});

/** Active members of the channel except the author, each at one row (a person with two memberships is not alarmed twice). */
async function channelAudience(
  tx: Tx,
  orgId: string,
  channelId: string,
  authorUserId: string,
): Promise<string[]> {
  const rows = await tx.execute<{ user_id: string }>(sql`
    SELECT DISTINCT cm.user_id
      FROM ${MEMBER} cm
      JOIN ${USER} u ON u.id = cm.user_id AND u.status = 'active'
     WHERE cm.organization_id = ${orgId}::uuid AND cm.channel_id = ${channelId}::uuid
       AND cm.removed_at IS NULL AND cm.user_id <> ${authorUserId}::uuid
       AND EXISTS (SELECT 1 FROM ${MEMBERSHIP} m
                    WHERE m.organization_id = cm.organization_id AND m.user_id = cm.user_id AND m.status = 'active')
     ORDER BY cm.user_id`);
  return rows.rows.map((r) => r.user_id);
}

async function countsFor(tx: Tx, orgId: string, emergencyId: string): Promise<EmergencyCounts> {
  const res = await tx.execute<{ audience: string | number; acknowledged: string | number }>(sql`
    SELECT count(*) AS audience, count(acknowledged_at) AS acknowledged
      FROM ${RC} WHERE organization_id = ${orgId}::uuid AND emergency_id = ${emergencyId}::uuid`);
  const audience = num(res.rows[0]?.audience);
  const acknowledged = num(res.rows[0]?.acknowledged);
  return { audience, acknowledged, pending: audience - acknowledged };
}

async function emergencyOf(
  tx: Tx,
  orgId: string,
  messageId: string,
  opts: { createdBy?: string } = {},
): Promise<EmergencyRow | null> {
  const rows = (await tx
    .select(COLUMNS)
    .from(EM)
    .innerJoin(MSG, and(eq(MSG.organizationId, EM.organizationId), eq(MSG.id, EM.messageId)))
    .where(
      and(
        eq(EM.organizationId, orgId),
        eq(EM.messageId, messageId),
        isNull(MSG.deletedAt),
        opts.createdBy ? eq(EM.createdBy, opts.createdBy) : undefined,
      ),
    )
    .limit(1)) as EmergencyRow[];
  return rows[0] ?? null;
}

export function createEmergencyService(deps: {
  db: DbClient;
  flags?: EmergencyFlagReader | undefined;
  outbox?: HintOutboxPort | undefined;
}): EmergencyService {
  const { db } = deps;
  const summaryOf = async (tx: Tx, orgId: string, e: EmergencyRow): Promise<EmergencySummary> =>
    toSummary(e, await countsFor(tx, orgId, e.id));

  return {
    async enabled(orgId) {
      if (!deps.flags) return false;
      return (await deps.flags.forOrg(orgId))[EMERGENCY_FLAG_KEY] === true;
    },

    async declare(orgId, input) {
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        const own = (await tx
          .select({ id: MSG.id, channelId: MSG.channelId })
          .from(MSG)
          .where(
            and(
              eq(MSG.organizationId, orgId),
              eq(MSG.id, input.messageId),
              eq(MSG.authorUserId, input.userId),
              isNull(MSG.deletedAt),
            ),
          )
          .limit(1)) as Array<{ id: string; channelId: string }>;
        // One answer for unknown, someone else's and deleted: only the author may declare an emergency.
        if (!own[0]) throw notFound();
        const existing = await emergencyOf(tx, orgId, input.messageId);
        if (existing) return { ...(await summaryOf(tx, orgId, existing)), created: false };

        const audience = await channelAudience(tx, orgId, own[0].channelId, input.userId);
        if (audience.length === 0) {
          throw new ChartWardenError(
            "EMERGENCY_NO_RECIPIENTS",
            "Nobody else is an active member of this channel, so there is no one to alarm.",
            422,
          );
        }
        if (audience.length > EMERGENCY_MAX_AUDIENCE) {
          throw new ChartWardenError(
            "EMERGENCY_AUDIENCE_TOO_LARGE",
            `An emergency message reaches at most ${EMERGENCY_MAX_AUDIENCE} people; this channel has more.`,
            422,
          );
        }
        const inserted = (await tx
          .insert(EM)
          .values({
            organizationId: orgId,
            messageId: input.messageId,
            channelId: input.messageId, // replaced by the guard from the message itself
            createdBy: input.userId,
          })
          .onConflictDoNothing()
          .returning(COLUMNS)) as EmergencyRow[];
        const row = inserted[0];
        if (!row) {
          const raced = await emergencyOf(tx, orgId, input.messageId);
          if (!raced) throw notFound();
          return { ...(await summaryOf(tx, orgId, raced)), created: false };
        }
        for (let i = 0; i < audience.length; i += INSERT_CHUNK) {
          await tx.insert(RC).values(
            audience.slice(i, i + INSERT_CHUNK).map((userId) => ({
              organizationId: orgId,
              emergencyId: row.id,
              userId,
            })),
          );
        }
        for (const recipientUserId of audience) {
          await publishEmergencySent(deps.outbox, tx, {
            orgId,
            emergencyId: row.id,
            channelId: row.channelId,
            messageId: row.messageId,
            authorUserId: input.userId,
            recipientUserId,
            at: row.createdAt,
          });
        }
        return { ...(await summaryOf(tx, orgId, row)), created: true };
      });
    },

    async detail(orgId, input) {
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        // Only the author reads who has not acknowledged; anyone else gets the same 404 as an unknown id (ADR-0106 D6).
        const e = await emergencyOf(tx, orgId, input.messageId, { createdBy: input.userId });
        if (!e) throw notFound();
        const people = await tx
          .select({ userId: RC.userId, name: USER.name, acknowledgedAt: RC.acknowledgedAt })
          .from(RC)
          .innerJoin(USER, eq(USER.id, RC.userId))
          .where(and(eq(RC.organizationId, orgId), eq(RC.emergencyId, e.id)))
          .orderBy(asc(sql`${RC.acknowledgedAt} IS NOT NULL`), asc(USER.name), asc(RC.userId));
        return {
          ...(await summaryOf(tx, orgId, e)),
          people: people.map((p) => ({
            userId: p.userId,
            displayName: staffName(p.name),
            acknowledgedAt: p.acknowledgedAt ? p.acknowledgedAt.toISOString() : null,
          })),
        };
      });
    },

    async list(orgId, input) {
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        const rows = (await tx
          .select(COLUMNS)
          .from(EM)
          .innerJoin(MSG, and(eq(MSG.organizationId, EM.organizationId), eq(MSG.id, EM.messageId)))
          .where(
            and(
              eq(EM.organizationId, orgId),
              eq(EM.createdBy, input.userId),
              isNull(MSG.deletedAt),
            ),
          )
          .orderBy(desc(EM.createdAt), desc(EM.id))
          .limit(EMERGENCY_LIST_MAX)) as EmergencyRow[];
        return Promise.all(rows.map((e) => summaryOf(tx, orgId, e)));
      });
    },

    async mine(orgId, input) {
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        const rows = await tx
          .select({
            emergencyId: EM.id,
            messageId: EM.messageId,
            channelId: EM.channelId,
            createdAt: EM.createdAt,
            deadlineAt: EM.deadlineAt,
            acknowledgedAt: RC.acknowledgedAt,
          })
          .from(RC)
          .innerJoin(EM, and(eq(EM.organizationId, RC.organizationId), eq(EM.id, RC.emergencyId)))
          .innerJoin(MSG, and(eq(MSG.organizationId, EM.organizationId), eq(MSG.id, EM.messageId)))
          .where(
            and(eq(RC.organizationId, orgId), eq(RC.userId, input.userId), isNull(MSG.deletedAt)),
          )
          // Waiting first, then newest: an alarm the person still owes is never buried under finished ones.
          .orderBy(asc(sql`${RC.acknowledgedAt} IS NOT NULL`), desc(EM.createdAt), desc(EM.id))
          .limit(EMERGENCY_LIST_MAX);
        return rows.map((r) => ({
          emergencyId: r.emergencyId,
          messageId: r.messageId,
          channelId: r.channelId,
          createdAt: r.createdAt.toISOString(),
          deadlineAt: r.deadlineAt.toISOString(),
          acknowledgedAt: r.acknowledgedAt ? r.acknowledgedAt.toISOString() : null,
        }));
      });
    },

    async acknowledge(orgId, input) {
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        const mine = (await tx
          .select({ id: RC.id, acknowledgedAt: RC.acknowledgedAt })
          .from(RC)
          .where(
            and(
              eq(RC.organizationId, orgId),
              eq(RC.emergencyId, input.emergencyId),
              eq(RC.userId, input.userId),
            ),
          )
          .limit(1)) as Array<{ id: string; acknowledgedAt: Date | null }>;
        // Not in the frozen audience (the author included) is the same answer as an unknown emergency.
        const row = mine[0];
        if (!row) throw notFound();
        if (row.acknowledgedAt) {
          return {
            emergencyId: input.emergencyId,
            acknowledgedAt: row.acknowledgedAt.toISOString(),
            already: true,
          };
        }
        const moved = (await tx
          .update(RC)
          .set({ acknowledgedAt: sql`now()` })
          .where(and(eq(RC.id, row.id), isNull(RC.acknowledgedAt)))
          .returning({ acknowledgedAt: RC.acknowledgedAt })) as Array<{
          acknowledgedAt: Date | null;
        }>;
        if (moved[0]?.acknowledgedAt) {
          return {
            emergencyId: input.emergencyId,
            acknowledgedAt: moved[0].acknowledgedAt.toISOString(),
            already: false,
          };
        }
        // A concurrent acknowledgment won the race: report the instant it left.
        const after = (await tx
          .select({ acknowledgedAt: RC.acknowledgedAt })
          .from(RC)
          .where(eq(RC.id, row.id))
          .limit(1)) as Array<{ acknowledgedAt: Date | null }>;
        const at = after[0]?.acknowledgedAt;
        if (!at) throw notFound();
        return { emergencyId: input.emergencyId, acknowledgedAt: at.toISOString(), already: true };
      });
    },
  };
}
