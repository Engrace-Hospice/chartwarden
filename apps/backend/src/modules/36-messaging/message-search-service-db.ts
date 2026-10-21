// apps/backend/src/modules/36-messaging/message-search-service-db.ts - WP 2.7a in-conversation search over Drizzle.
//
// DESIGN (02 section 6, option A): bodies are sealed under the tenant DEK, so there is no index. A request walks ONE
// channel newest-first in keyset batches, opens each candidate body, matches the normalised query in memory and
// stops at the page size or at SEARCH_MAX_SCAN_PER_REQUEST bodies, whichever comes first (then it returns a
// continuation cursor). Nothing derived from a body is stored, cached or logged.
//
// ACCESS: the route has run `channel_visibility` on the channel id; this service re-runs it (`canViewChannel`) so it
// is correct without the route, and every statement is scoped to (organization, channel). A non-member, a removed
// member, a Part 2 gated channel, another organisation and an unknown id are all the one 404. SQL pre-filters
// (`status <> 'deleted'`) mean a tombstone is never even opened; the body searched is the CURRENT one (an edit
// replaces the cipher in place). Hydration (reactions, pins, scan-gated attachments) is the shared read path, so a
// result can never show more than the channel history would.
import { type DbClient, schema } from "@chartwarden/db";
import {
  type MessageSearchInput,
  type MessageSearchResult,
  type MessageSearchService,
  type MessagingRouteService,
  SEARCH_MAX_SCAN_PER_REQUEST,
  assertSearchHasCriteria,
  bodyMatchesTerms,
  normalizeSearchText,
  searchPageSize,
} from "@chartwarden/messaging";
import type { MessageBodyKind } from "@chartwarden/messaging";
import { withOrgContext } from "@chartwarden/tenancy";
import { NotFoundError, ChartWardenError } from "@chartwarden/types";
import { type SQL, and, desc, eq, sql } from "drizzle-orm";
import { BodyKeyUnavailableError } from "./body-key-ring";
import { decodeCursor, encodeCursor } from "./message-cursor";
import {
  type HydrationContext,
  MESSAGE_ROW_COLUMNS,
  type MessageRow,
  hydrateMessages,
} from "./messaging-message-hydration";
import type { Tx } from "./messaging-write-core";
import { decodeStoredBody } from "./rich-body-codec";

const CH = schema.channels;
const MSG = schema.messages;
const ATT = schema.messageAttachments;
const USER = schema.users;

/** Rows fetched per round trip; small enough that an early page-full exit wastes little. */
const SCAN_BATCH_SIZE = 500;
const SEARCH_STATEMENT_TIMEOUT_MS = "5000";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MessageSearchDeps {
  readonly db: DbClient;
  readonly canViewChannel: MessagingRouteService["canViewChannel"];
  readonly hydrationContext: (
    orgId: string,
    viewerUserId: string,
    channelKind: string,
  ) => HydrationContext;
}

/** The statement timeout (SQLSTATE 57014, possibly wrapped by the driver) as a typed, retryable 503; anything else as is. */
export function searchTimeoutToError(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    if ((current as { code?: unknown }).code === "57014") {
      return new ChartWardenError(
        "SEARCH_TIMEOUT",
        "the search took too long; narrow it with a filter or try again",
        503,
      );
    }
    current = (current as { cause?: unknown }).cause;
  }
  return error;
}

function badInput(message: string): ChartWardenError {
  return new ChartWardenError("INVALID_SEARCH_QUERY", message, 422);
}

function parseInstant(value: string | undefined, label: string): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw badInput(`${label} is not a valid date`);
  return parsed;
}

interface SearchFilters {
  readonly terms: readonly string[];
  readonly limit: number;
  readonly senderUserId?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly hasAttachment: boolean;
}

function parseFilters(input: MessageSearchInput): SearchFilters {
  const terms = assertSearchHasCriteria(input);
  if (input.senderUserId !== undefined && !UUID.test(input.senderUserId)) {
    throw badInput("sender is not a valid id");
  }
  const from = parseInstant(input.from, "from");
  const to = parseInstant(input.to, "to");
  if (from && to && from >= to) throw badInput("from must be before to");
  return {
    terms,
    limit: searchPageSize(input.limit),
    senderUserId: input.senderUserId,
    from,
    to,
    hasAttachment: input.hasAttachment === true,
  };
}

/** The cheap, indexable part of the search: everything except the body match. */
function candidateWhere(
  orgId: string,
  channelId: string,
  viewerUserId: string,
  filters: SearchFilters,
  after: { createdAt: string; id: string } | null,
): SQL {
  const where: SQL[] = [
    eq(MSG.organizationId, orgId),
    eq(MSG.channelId, channelId),
    sql`${MSG.status} <> 'deleted'`,
  ];
  if (filters.senderUserId) where.push(eq(MSG.authorUserId, filters.senderUserId));
  if (filters.from) where.push(sql`${MSG.createdAt} >= ${filters.from.toISOString()}::timestamptz`);
  if (filters.to) where.push(sql`${MSG.createdAt} < ${filters.to.toISOString()}::timestamptz`);
  if (filters.hasAttachment) {
    // The same visibility rule as loadAttachmentViews: clean for everyone, pending only for its uploader.
    where.push(sql`exists (
      select 1 from ${ATT}
      where ${ATT.organizationId} = ${MSG.organizationId}
        and ${ATT.messageId} = ${MSG.id}
        and (${ATT.scanState} = 'clean'
          or (${ATT.scanState} = 'pending' and ${ATT.uploadedBy} = ${viewerUserId}))
    )`);
  }
  if (after) where.push(sql`(${MSG.createdAt}, ${MSG.id}) < (${after.createdAt}, ${after.id})`);
  return and(...where) as SQL;
}

export function createDbMessageSearchService(deps: MessageSearchDeps): MessageSearchService {
  const { db } = deps;

  async function scan(
    tx: Tx,
    orgId: string,
    input: MessageSearchInput,
    channel: { kind: string },
    filters: SearchFilters,
    cursor: { createdAt: string; id: string } | null,
  ) {
    const ctx = deps.hydrationContext(orgId, input.userId, channel.kind);
    const matched: MessageRow[] = [];
    let after = cursor;
    let scanned = 0;
    let lastExamined: { createdAtMicros: string; id: string } | undefined;
    let more = false;
    let done = false;
    while (!done) {
      const take = Math.min(SCAN_BATCH_SIZE, SEARCH_MAX_SCAN_PER_REQUEST - scanned);
      // One extra row tells us whether anything older remains without a second query.
      const rows = await tx
        .select({ ...MESSAGE_ROW_COLUMNS, authorDisplayName: USER.name })
        .from(MSG)
        .leftJoin(USER, eq(USER.id, MSG.authorUserId))
        .where(candidateWhere(orgId, input.channelId, input.userId, filters, after))
        .orderBy(desc(MSG.createdAt), desc(MSG.id))
        .limit(take + 1);
      const batch = rows.slice(0, take);
      const olderRemains = rows.length > take;
      for (const [i, row] of batch.entries()) {
        scanned += 1;
        lastExamined = { createdAtMicros: row.createdAtMicros, id: row.id };
        if (await rowMatches(ctx, orgId, row, filters.terms)) matched.push(row);
        if (matched.length >= filters.limit) {
          more = i < batch.length - 1 || olderRemains;
          done = true;
          break;
        }
      }
      if (done || !olderRemains) break;
      if (scanned >= SEARCH_MAX_SCAN_PER_REQUEST) {
        more = true;
        break;
      }
      const last = batch[batch.length - 1]!;
      after = { createdAt: last.createdAtMicros, id: last.id };
    }
    return { matched, scanned, lastExamined, more, ctx };
  }

  return {
    async searchMessages(orgId, input): Promise<MessageSearchResult> {
      const filters = parseFilters(input);
      const cursor = input.cursor ? decodeCursor(input.cursor) : null;
      if (!(await deps.canViewChannel(orgId, input.userId, input.channelId))) {
        throw new NotFoundError("channel", input.channelId);
      }
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        // No per-route rate limit exists in this repo, so one search cannot hold a connection past this (the scan is
        // already capped per request; this bounds a slow plan or a loaded database).
        await tx.execute(
          sql`SELECT set_config('statement_timeout', ${SEARCH_STATEMENT_TIMEOUT_MS}, true)`,
        );
        const [channel] = await tx
          .select({ kind: CH.channelKind, subjectId: CH.subjectId, isArchived: CH.isArchived })
          .from(CH)
          .where(and(eq(CH.organizationId, orgId), eq(CH.id, input.channelId)))
          .limit(1);
        if (!channel) throw new NotFoundError("channel", input.channelId);
        if (channel.isArchived) {
          throw new ChartWardenError("CHANNEL_ARCHIVED", "channel is archived", 410);
        }
        const found = await scan(tx, orgId, input, { kind: channel.kind }, filters, cursor);
        const hydrated = await hydrateMessages(tx, found.ctx, found.matched, input.channelId);
        // Pre-filter said "has an attachment row this viewer may see"; hydration also drops expired scans, so
        // keep exactly what it shows.
        const results = filters.hasAttachment
          ? hydrated.filter((m) => (m.attachments?.length ?? 0) > 0)
          : hydrated;
        return {
          results,
          ...(found.more && found.lastExamined
            ? {
                nextCursor: encodeCursor(found.lastExamined.createdAtMicros, found.lastExamined.id),
              }
            : {}),
          scanned: found.scanned,
          scanCapped: found.more && found.matched.length < filters.limit,
          patientId: channel.kind === "care_team" ? channel.subjectId : null,
        };
      }).catch((error: unknown) => {
        throw searchTimeoutToError(error);
      });
    },
  };
}

/** Open one body and test it; an unreadable body never matches (and says so by id, never by content). */
async function rowMatches(
  ctx: HydrationContext,
  orgId: string,
  row: MessageRow,
  terms: readonly string[],
): Promise<boolean> {
  if (terms.length === 0) return true;
  let plain: string;
  try {
    plain = decodeStoredBody(
      row.bodyKind as MessageBodyKind,
      await ctx.cipher.open(orgId, row.bodyCipher),
    ).body;
  } catch (err) {
    // A key outage must fail the search (503), not silently drop every hit as "unreadable".
    if (err instanceof BodyKeyUnavailableError) throw err;
    ctx.warn?.("message body could not be opened for search", {
      organizationId: orgId,
      messageId: row.id,
      channelId: row.channelId,
    });
    return false;
  }
  return bodyMatchesTerms(normalizeSearchText(plain), terms);
}
