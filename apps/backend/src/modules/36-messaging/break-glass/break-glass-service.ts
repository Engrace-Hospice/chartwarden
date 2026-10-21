// M36 ADR-0087 (PROPOSED), WP 5.8 - the break-glass service behind /api/v1/messaging/break-glass: request a self-approved, time-limited,
// read-only grant on ONE channel, list and end my grants, and the compliance review queue (list, detail, complete).
//
//   - Every write runs in one tenant transaction with its outbox event (m36.break_glass.*), so an event never announces a write that
//     rolled back. Instants come from the DATABASE clock (`now()`); deadlines are computed against the database's `now()` too.
//   - A grant is created WITH its review row (the table's deferred constraint trigger refuses a grant without one).
//   - The justification and a review note are reviewer-only free text: returned only by the review routes, never put in an event, an alert,
//     a log or a search index.
//   - A refusal to open a grant says nothing about WHY (unknown channel, announcement, excluded role category, Part 2 consent, flag off): the
//     same 404 a random channel id gets. Anything else would disclose a patient's Part 2 status to someone who may not know it.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  BREAK_GLASS_ALREADY_ACTIVE_CODE,
  BREAK_GLASS_DEFAULT_MINUTES,
  BREAK_GLASS_FLAG_KEY,
  BREAK_GLASS_JUSTIFICATION_MAX,
  BREAK_GLASS_JUSTIFICATION_MIN,
  BREAK_GLASS_LIMIT_CODE,
  BREAK_GLASS_MAX_LIVE_PER_USER,
  BREAK_GLASS_MAX_MINUTES,
  BREAK_GLASS_MAX_PER_DAY,
  BREAK_GLASS_MIN_MINUTES,
  BREAK_GLASS_NOTE_MAX,
  BREAK_GLASS_NOT_NEEDED_CODE,
  BREAK_GLASS_REASON_CODES,
  BREAK_GLASS_REVIEW_DONE_CODE,
  BREAK_GLASS_REVIEW_OUTCOMES,
  BREAK_GLASS_STILL_ACTIVE_CODE,
  type BreakGlassGrantDto,
  type BreakGlassGrantStatus,
  type BreakGlassReadDto,
  type BreakGlassReadKind,
  type BreakGlassReasonCode,
  type BreakGlassReviewDetailDto,
  type BreakGlassReviewDto,
  type BreakGlassReviewOutcome,
  ChartWardenError,
  type CompleteBreakGlassReviewRequest,
  type CreateBreakGlassRequest,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@chartwarden/types";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { HintOutboxPort } from "../message-hint-events";
import type { Tx } from "../messaging-write-core";
import { cacheFlagRead } from "../presence/binding";
import { grantEndedAt, isReviewOverdue, reviewDueAt } from "./break-glass-deadline";
import { publishBreakGlassEvent } from "./break-glass-events";
import type { BreakGlassFlagReader, BreakGlassReadAccess } from "./break-glass-read-access";

/** The database's `now()` as a Date. A raw `sql` select bypasses the driver's date mapping (drizzle reads timestamps as text), so map it. */
const dbNow = sql<Date>`now()`.mapWith((value: unknown) => new Date(String(value)));

const G = schema.messageBreakGlassGrants;
const R = schema.messageBreakGlassReviews;
const READ = schema.messageBreakGlassReads;
const CH = schema.channels;
const USER = schema.users;

/** Reads listed on one review (a grant is at most 24 hours; this bounds a very chatty reader). */
export const REVIEW_READS_LIMIT = 500;
export const REVIEW_LIST_DEFAULT_LIMIT = 50;
export const REVIEW_LIST_MAX_LIMIT = 200;
/** A holder's own grants listed (newest first). */
export const MINE_LIST_LIMIT = 20;

export interface BreakGlassActor {
  readonly organizationId: string;
  readonly userId: string;
}

export interface BreakGlassServiceDeps {
  readonly db: DbClient;
  readonly outbox?: HintOutboxPort | undefined;
  /** The M1 flag reader for `messaging.break_glass`. Absent => the feature is off. */
  readonly flags?: BreakGlassFlagReader | undefined;
  /** The ONE rule set shared with the read path (flag, active user, category, announcement, Part 2). */
  readonly access: BreakGlassReadAccess;
  /** Membership visibility (`canViewChannel`): a member has nothing to request. */
  readonly canViewChannel: (orgId: string, userId: string, channelId: string) => Promise<boolean>;
}

export interface BreakGlassService {
  isEnabled(orgId: string): Promise<boolean>;
  create(actor: BreakGlassActor, body: CreateBreakGlassRequest): Promise<BreakGlassGrantDto>;
  listMine(actor: BreakGlassActor): Promise<BreakGlassGrantDto[]>;
  end(
    actor: BreakGlassActor,
    grantId: string,
    opts: { readonly canEndAny: boolean },
  ): Promise<BreakGlassGrantDto>;
  listReviews(
    actor: BreakGlassActor,
    q: { readonly status: "pending" | "reviewed" | "all"; readonly limit?: number },
  ): Promise<BreakGlassReviewDto[]>;
  reviewDetail(actor: BreakGlassActor, reviewId: string): Promise<BreakGlassReviewDetailDto>;
  completeReview(
    actor: BreakGlassActor,
    reviewId: string,
    body: CompleteBreakGlassReviewRequest,
  ): Promise<BreakGlassReviewDetailDto>;
}

function invalid(field: string, message: string): never {
  throw new ValidationError("request validation failed", [{ field, code: "INVALID", message }]);
}

function validateCreate(body: CreateBreakGlassRequest): {
  readonly channelId: string;
  readonly reasonCode: BreakGlassReasonCode;
  readonly justification: string;
  readonly minutes: number;
} {
  if (!(BREAK_GLASS_REASON_CODES as readonly string[]).includes(body.reasonCode)) {
    invalid("reasonCode", "choose one of the listed reasons");
  }
  const justification = (body.justification ?? "").trim();
  if (
    justification.length < BREAK_GLASS_JUSTIFICATION_MIN ||
    justification.length > BREAK_GLASS_JUSTIFICATION_MAX
  ) {
    invalid(
      "justification",
      `a justification of ${BREAK_GLASS_JUSTIFICATION_MIN} to ${BREAK_GLASS_JUSTIFICATION_MAX} characters is required`,
    );
  }
  const minutes = body.durationMinutes ?? BREAK_GLASS_DEFAULT_MINUTES;
  if (
    !Number.isInteger(minutes) ||
    minutes < BREAK_GLASS_MIN_MINUTES ||
    minutes > BREAK_GLASS_MAX_MINUTES
  ) {
    invalid(
      "durationMinutes",
      `a duration of ${BREAK_GLASS_MIN_MINUTES} to ${BREAK_GLASS_MAX_MINUTES} minutes is required`,
    );
  }
  return { channelId: body.channelId, reasonCode: body.reasonCode, justification, minutes };
}

/** The error text of a thrown driver/ORM error and its causes, for constraint-name matching. */
function errorText(error: unknown): string {
  const parts: string[] = [];
  let cursor: unknown = error;
  for (let depth = 0; depth < 4 && cursor instanceof Error; depth += 1) {
    parts.push(cursor.message);
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

const iso = (d: Date): string => d.toISOString();

function statusOf(
  row: { revokedAt: Date | null; expiresAt: Date },
  now: Date,
): BreakGlassGrantStatus {
  if (row.revokedAt) return "revoked";
  return row.expiresAt.getTime() > now.getTime() ? "active" : "expired";
}

interface GrantRow {
  readonly id: string;
  readonly channelId: string;
  readonly channelKind: string;
  readonly reasonCode: string;
  readonly grantedAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

function toGrantDto(row: GrantRow, now: Date): BreakGlassGrantDto {
  return {
    id: row.id,
    channelId: row.channelId,
    channelKind: row.channelKind,
    reasonCode: row.reasonCode as BreakGlassReasonCode,
    grantedAt: iso(row.grantedAt),
    expiresAt: iso(row.expiresAt),
    revokedAt: row.revokedAt ? iso(row.revokedAt) : null,
    status: statusOf(row, now),
  };
}

interface ReviewRow {
  readonly reviewId: string;
  readonly grantId: string;
  readonly granteeUserId: string;
  readonly granteeName: string | null;
  readonly channelId: string;
  readonly channelKind: string;
  readonly channelTitle: string | null;
  readonly subjectId: string | null;
  readonly reasonCode: string;
  readonly justification: string;
  readonly grantedAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly reviewedAt: Date | null;
  readonly reviewerUserId: string | null;
  readonly outcome: string | null;
  readonly note: string | null;
  readonly readCount: number;
  readonly dbNow: Date;
}

function toReviewDto(row: ReviewRow): BreakGlassReviewDto {
  const endedAt = grantEndedAt(row.expiresAt, row.revokedAt);
  // A care-team or bereavement channel is about ONE patient: its title can name them, so show no title and identify the subject by id.
  const careTeam = row.channelKind === "care_team" || row.channelKind === "bereavement";
  return {
    reviewId: row.reviewId,
    grantId: row.grantId,
    granteeUserId: row.granteeUserId,
    granteeName: row.granteeName?.trim() || null,
    channelId: row.channelId,
    channelKind: row.channelKind,
    channelTitle: careTeam ? null : row.channelTitle,
    patientId: careTeam ? row.subjectId : null,
    reasonCode: row.reasonCode as BreakGlassReasonCode,
    justification: row.justification,
    grantedAt: iso(row.grantedAt),
    endedAt: iso(endedAt),
    stillActive: !row.revokedAt && row.expiresAt.getTime() > row.dbNow.getTime(),
    readCount: Number(row.readCount),
    status: row.reviewedAt ? "reviewed" : "pending",
    outcome: (row.outcome as BreakGlassReviewOutcome | null) ?? null,
    reviewedAt: row.reviewedAt ? iso(row.reviewedAt) : null,
    reviewerUserId: row.reviewerUserId,
    note: row.note,
    dueAt: iso(reviewDueAt(endedAt)),
    overdue: isReviewOverdue({ completed: !!row.reviewedAt, endedAt }, row.dbNow),
  };
}

const REVIEW_COLUMNS = {
  reviewId: R.id,
  grantId: G.id,
  granteeUserId: G.granteeUserId,
  granteeName: USER.name,
  channelId: G.channelId,
  channelKind: CH.channelKind,
  channelTitle: CH.title,
  subjectId: CH.subjectId,
  reasonCode: G.reasonCode,
  justification: G.justification,
  grantedAt: G.grantedAt,
  expiresAt: G.expiresAt,
  revokedAt: G.revokedAt,
  reviewedAt: R.reviewedAt,
  reviewerUserId: R.reviewerUserId,
  outcome: R.outcome,
  note: R.note,
  readCount: sql<number>`(SELECT count(*)::int FROM message_break_glass_read r WHERE r.organization_id = ${R.organizationId} AND r.grant_id = ${G.id})`,
  dbNow,
} as const;

const reviewQuery = (tx: Tx) =>
  tx
    .select(REVIEW_COLUMNS)
    .from(R)
    .innerJoin(G, and(eq(G.organizationId, R.organizationId), eq(G.id, R.grantId)))
    .innerJoin(CH, and(eq(CH.organizationId, G.organizationId), eq(CH.id, G.channelId)))
    .leftJoin(USER, eq(USER.id, G.granteeUserId));

async function readsOf(
  tx: Tx,
  orgId: string,
  grantId: string,
): Promise<{ reads: BreakGlassReadDto[]; truncated: boolean }> {
  const rows = await tx
    .select({
      readKind: READ.readKind,
      resourceId: READ.resourceId,
      itemCount: READ.itemCount,
      readAt: READ.readAt,
    })
    .from(READ)
    .where(and(eq(READ.organizationId, orgId), eq(READ.grantId, grantId)))
    .orderBy(asc(READ.readAt), asc(READ.id))
    .limit(REVIEW_READS_LIMIT + 1);
  const reads = rows.slice(0, REVIEW_READS_LIMIT).map((r) => ({
    readKind: r.readKind as BreakGlassReadKind,
    resourceId: r.resourceId,
    itemCount: r.itemCount,
    readAt: iso(r.readAt),
  }));
  return { reads, truncated: rows.length > REVIEW_READS_LIMIT };
}

async function detailOf(
  tx: Tx,
  orgId: string,
  reviewId: string,
): Promise<BreakGlassReviewDetailDto> {
  const [row] = await reviewQuery(tx)
    .where(and(eq(R.organizationId, orgId), eq(R.id, reviewId)))
    .limit(1);
  if (!row) throw new NotFoundError("break-glass review", reviewId);
  const { reads, truncated } = await readsOf(tx, orgId, row.grantId);
  return { ...toReviewDto(row), reads, readsTruncated: truncated };
}

const grantSelect = (tx: Tx, orgId: string, grantId: string) =>
  tx
    .select({
      id: G.id,
      channelId: G.channelId,
      channelKind: CH.channelKind,
      granteeUserId: G.granteeUserId,
      reasonCode: G.reasonCode,
      grantedAt: G.grantedAt,
      expiresAt: G.expiresAt,
      revokedAt: G.revokedAt,
      dbNow,
    })
    .from(G)
    .innerJoin(CH, and(eq(CH.organizationId, G.organizationId), eq(CH.id, G.channelId)))
    .where(and(eq(G.organizationId, orgId), eq(G.id, grantId)))
    .limit(1);

export function createBreakGlassService(deps: BreakGlassServiceDeps): BreakGlassService {
  const { db } = deps;
  const isEnabled = cacheFlagRead(async (organizationId) =>
    deps.flags ? (await deps.flags.forOrg(organizationId))[BREAK_GLASS_FLAG_KEY] === true : false,
  );

  return {
    isEnabled,

    async create(actor, body) {
      const input = validateCreate(body);
      const { organizationId: orgId, userId } = actor;
      // The compliance alert rides on the outbox event: with no outbox a grant would exist unannounced. Fail closed.
      if (!deps.outbox) throw new Error("break-glass requires the transactional outbox");
      // A member already reads the channel: nothing to request (they know they are a member, so this discloses nothing).
      if (await deps.canViewChannel(orgId, userId, input.channelId)) {
        throw new ChartWardenError(
          BREAK_GLASS_NOT_NEEDED_CODE,
          "you can already read this conversation",
          409,
        );
      }
      // Every other refusal - flag, inactive user, excluded role category, announcement, Part 2, unknown or foreign channel - is the same 404.
      if (!(await deps.access.canHold(orgId, userId, input.channelId))) {
        throw new NotFoundError("channel", input.channelId);
      }
      return withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        const [channel] = await tx
          .select({ kind: CH.channelKind })
          .from(CH)
          .where(and(eq(CH.organizationId, orgId), eq(CH.id, input.channelId)))
          .limit(1);
        if (!channel) throw new NotFoundError("channel", input.channelId);
        // One fresh step-up must not buy unlimited grants (and alerts): bound the live ones and a rolling day's worth.
        const [counts] = await tx
          .select({
            live: sql<number>`count(*) FILTER (WHERE ${G.revokedAt} IS NULL AND ${G.expiresAt} > now())::int`,
            day: sql<number>`count(*) FILTER (WHERE ${G.grantedAt} > now() - interval '1 day')::int`,
          })
          .from(G)
          .where(and(eq(G.organizationId, orgId), eq(G.granteeUserId, userId)));
        if (
          Number(counts?.live ?? 0) >= BREAK_GLASS_MAX_LIVE_PER_USER ||
          Number(counts?.day ?? 0) >= BREAK_GLASS_MAX_PER_DAY
        ) {
          throw new ChartWardenError(
            BREAK_GLASS_LIMIT_CODE,
            "too many break-glass requests; ask a colleague or a reviewer",
            429,
          );
        }
        // An expired but never-revoked grant still occupies the one-open slot; end it first (renewal is a NEW justified request).
        await tx
          .update(G)
          .set({ revokedAt: sql`now()` })
          .where(
            and(
              eq(G.organizationId, orgId),
              eq(G.channelId, input.channelId),
              eq(G.granteeUserId, userId),
              isNull(G.revokedAt),
              sql`${G.expiresAt} <= now()`,
            ),
          );
        try {
          const [grant] = await tx
            .insert(G)
            .values({
              organizationId: orgId,
              channelId: input.channelId,
              granteeUserId: userId,
              reasonCode: input.reasonCode,
              justification: input.justification,
              expiresAt: sql`now() + make_interval(mins => ${input.minutes})`,
            })
            .returning({ id: G.id, grantedAt: G.grantedAt, expiresAt: G.expiresAt });
          if (!grant) throw new Error("break-glass grant insert returned no row");
          await tx.insert(R).values({ organizationId: orgId, grantId: grant.id });
          await publishBreakGlassEvent(deps.outbox, tx, {
            kind: "granted",
            orgId,
            grantId: grant.id,
            channelId: input.channelId,
            granteeUserId: userId,
            reasonCode: input.reasonCode,
            grantedAt: grant.grantedAt,
            expiresAt: grant.expiresAt,
          });
          return toGrantDto(
            {
              id: grant.id,
              channelId: input.channelId,
              channelKind: String(channel.kind),
              reasonCode: input.reasonCode,
              grantedAt: grant.grantedAt,
              expiresAt: grant.expiresAt,
              revokedAt: null,
            },
            grant.grantedAt,
          );
        } catch (error) {
          if (errorText(error).includes("message_break_glass_grant_one_open")) {
            throw new ChartWardenError(
              BREAK_GLASS_ALREADY_ACTIVE_CODE,
              "you already hold access to this conversation",
              409,
            );
          }
          throw error;
        }
      });
    },

    async listMine(actor) {
      const { organizationId: orgId, userId } = actor;
      return withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        const rows = await tx
          .select({
            id: G.id,
            channelId: G.channelId,
            channelKind: CH.channelKind,
            reasonCode: G.reasonCode,
            grantedAt: G.grantedAt,
            expiresAt: G.expiresAt,
            revokedAt: G.revokedAt,
            dbNow,
          })
          .from(G)
          .innerJoin(CH, and(eq(CH.organizationId, G.organizationId), eq(CH.id, G.channelId)))
          .where(and(eq(G.organizationId, orgId), eq(G.granteeUserId, userId)))
          .orderBy(desc(G.grantedAt), desc(G.id))
          .limit(MINE_LIST_LIMIT);
        return rows.map((r) => toGrantDto({ ...r, channelKind: String(r.channelKind) }, r.dbNow));
      });
    },

    async end(actor, grantId, opts) {
      const { organizationId: orgId, userId } = actor;
      return withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        const [grant] = await grantSelect(tx, orgId, grantId);
        // Someone else's grant is the 404 a random id gets, unless the caller may end any (a reviewer).
        if (!grant || (grant.granteeUserId !== userId && !opts.canEndAny)) {
          throw new NotFoundError("break-glass grant", grantId);
        }
        const dto = (g: NonNullable<typeof grant>) =>
          toGrantDto({ ...g, channelKind: String(g.channelKind) }, g.dbNow);
        if (grant.revokedAt || grant.expiresAt.getTime() <= grant.dbNow.getTime())
          return dto(grant);
        const ended = await tx
          .update(G)
          .set({ revokedAt: sql`now()` })
          .where(and(eq(G.organizationId, orgId), eq(G.id, grantId), isNull(G.revokedAt)))
          .returning({ id: G.id });
        const [after] = await grantSelect(tx, orgId, grantId);
        if (!after) throw new NotFoundError("break-glass grant", grantId);
        if (ended.length > 0 && after.revokedAt) {
          await publishBreakGlassEvent(deps.outbox, tx, {
            kind: "revoked",
            orgId,
            grantId,
            channelId: after.channelId,
            granteeUserId: after.granteeUserId,
            revokedByUserId: userId,
            at: after.revokedAt,
          });
        }
        return dto(after);
      });
    },

    async listReviews(actor, q) {
      const { organizationId: orgId, userId } = actor;
      const limit = Math.min(
        Math.max(q.limit ?? REVIEW_LIST_DEFAULT_LIMIT, 1),
        REVIEW_LIST_MAX_LIMIT,
      );
      return withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        const where = and(
          eq(R.organizationId, orgId),
          q.status === "pending"
            ? isNull(R.reviewedAt)
            : q.status === "reviewed"
              ? isNotNull(R.reviewedAt)
              : undefined,
        );
        // The queue is worked oldest first; the history newest first.
        const order =
          q.status === "pending" ? [asc(R.createdAt), asc(R.id)] : [desc(G.grantedAt), desc(R.id)];
        const rows = await reviewQuery(tx)
          .where(where)
          .orderBy(...order)
          .limit(limit);
        return rows.map(toReviewDto);
      });
    },

    async reviewDetail(actor, reviewId) {
      const { organizationId: orgId, userId } = actor;
      return withOrgContext(db, { organizationId: orgId, userId }, (tx) =>
        detailOf(tx, orgId, reviewId),
      );
    },

    async completeReview(actor, reviewId, body) {
      const { organizationId: orgId, userId } = actor;
      if (!(BREAK_GLASS_REVIEW_OUTCOMES as readonly string[]).includes(body.outcome)) {
        invalid("outcome", "choose reviewed or concern");
      }
      const note = body.note?.trim() ? body.note.trim() : null;
      if (note !== null && note.length > BREAK_GLASS_NOTE_MAX) {
        invalid("note", `a note of at most ${BREAK_GLASS_NOTE_MAX} characters`);
      }
      if (body.outcome === "concern" && note === null) {
        invalid("note", "a concern needs a note saying what it is");
      }
      return withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        const current = await detailOf(tx, orgId, reviewId);
        // Never one's own grant (the table's guard refuses it too).
        if (current.granteeUserId === userId) {
          throw new ForbiddenError("the person who held the grant cannot review it");
        }
        if (current.status === "reviewed") {
          throw new ChartWardenError(
            BREAK_GLASS_REVIEW_DONE_CODE,
            "this review is already complete",
            409,
          );
        }
        if (current.stillActive) {
          throw new ChartWardenError(
            BREAK_GLASS_STILL_ACTIVE_CODE,
            "the grant has not ended yet; end it first or wait for it to expire",
            409,
          );
        }
        let done: { id: string }[];
        try {
          done = await tx
            .update(R)
            .set({ reviewerUserId: userId, reviewedAt: sql`now()`, outcome: body.outcome, note })
            .where(and(eq(R.organizationId, orgId), eq(R.id, reviewId), isNull(R.reviewedAt)))
            .returning({ id: R.id });
        } catch (error) {
          const text = errorText(error);
          if (text.includes("message_break_glass_review_self")) {
            throw new ForbiddenError("the person who held the grant cannot review it");
          }
          if (text.includes("message_break_glass_review_open")) {
            throw new ChartWardenError(
              BREAK_GLASS_STILL_ACTIVE_CODE,
              "the grant has not ended yet",
              409,
            );
          }
          throw error;
        }
        if (done.length === 0) {
          throw new ChartWardenError(
            BREAK_GLASS_REVIEW_DONE_CODE,
            "this review is already complete",
            409,
          );
        }
        const after = await detailOf(tx, orgId, reviewId);
        await publishBreakGlassEvent(deps.outbox, tx, {
          kind: "reviewed",
          orgId,
          grantId: after.grantId,
          reviewId,
          reviewerUserId: userId,
          outcome: body.outcome,
          at: after.reviewedAt ? new Date(after.reviewedAt) : new Date(),
        });
        return after;
      });
    },
  };
}
