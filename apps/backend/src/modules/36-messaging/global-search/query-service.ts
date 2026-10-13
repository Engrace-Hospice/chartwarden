// WP 2.7b C3 (ADR-0058 decisions 8, 9, 13) - the global search query pipeline. The route has already run the gates (permission,
// rate limit, kill switches, serve gate, role gate) and hands this service the `ServeContext` they produced.
//
//   1. terms + tags (the query tokenised like the index; one tag per term per live key version)     [no I/O but keys]
//   2. head-bucket refusal: a query whose every term is a head bucket returns refine:true with NO candidate SQL, NO decrypt
//   3. isActiveMessagingUser, once                                                                   [short tx]
//   4. TRANSACTION 1: coarse SQL prefilter (tags -> messages the caller is a member of, or announcements), keyset, cap 500
//   5. AUTHORITY, outside any transaction: channels deduped, at most MAX_CHANNELS_PER_REQUEST, and ONE call of
//      `effectivelyVisibleChannels`, the only decider. Candidates in channels it does not return are dropped.
//   6. TRANSACTION 2: re-select the survivors with the same membership join, open bodies in recency order within the decrypt
//      budget and timeout, re-verify each CURRENT row and verify the query terms against the plaintext, hydrate the page,
//      and write one attributed read per distinct patient on it (a failed audit write fails the read).
// This is the ONLY module of the query path that holds a `BodyReader`, and it opens bodies only after step 5.
// Fail closed: key derivation, the authority call, the transactions and the audit write all propagate as errors, never as a
// prefilter-only, plaintext-scan or unaudited answer. No tag, term or query text is logged.
import { type AuditContext, auditPhiRead } from "@wardenx/audit";
import type { DbClient } from "@wardenx/db";
import {
  CANDIDATE_CAP,
  DECRYPT_BUDGET,
  DECRYPT_TIMEOUT_MS,
  MAX_PAGES_PER_QUERY,
  type ResolvedMessage,
  STATEMENT_TIMEOUT_MS,
  type SearchKeyProvider,
  decodeSearchCursor,
  encodeSearchCursor,
} from "@wardenx/messaging";
import type { ChannelKind, ChannelMemberSource } from "@wardenx/messaging";
import { withOrgContext } from "@wardenx/tenancy";
import { WardenXError } from "@wardenx/types";
import { sql } from "drizzle-orm";
import { searchTimeoutToError } from "../message-search-service-db";
import { type HydrationContext, hydrateMessages } from "../messaging-message-hydration";
import { effectivelyVisibleChannels, isActiveMessagingUser } from "../messaging-route-service-db";
import type { MessageBodyCipher, Tx } from "../messaging-write-core";
import type { Part2ChannelGate } from "../part2-channel-gate";
import { type BodyReader, type IsRedactedOrPending, neverRedacted } from "./ports";
import {
  type Candidate,
  type SurvivorRow,
  reselectSurvivors,
  selectCandidates,
} from "./query-sql";
import {
  bodyMatchesQueryTerms,
  buildVersionQueries,
  isHeadBucketQuery,
  parseQueryTerms,
} from "./query-terms";
import type { ServeContext } from "./serve-gate";

/** Distinct channels authorised per request (ADR "bounded seam cost"); candidates beyond them continue through the cursor. */
export const MAX_CHANNELS_PER_REQUEST = 50;
export const GLOBAL_SEARCH_DEFAULT_LIMIT = 20;
export const GLOBAL_SEARCH_MAX_LIMIT = 50;

export interface GlobalSearchLimits {
  readonly decryptBudget: number;
  readonly decryptTimeoutMs: number;
  readonly maxChannels: number;
}

export interface GlobalSearchDeps {
  readonly db: DbClient;
  readonly bodies: BodyReader;
  readonly keys: SearchKeyProvider;
  readonly part2Gate: Part2ChannelGate;
  /** Hydration of the returned page only (the shared history read path), so a result never shows more than the channel does. */
  readonly cipher: MessageBodyCipher;
  readonly isRedactedOrPending?: IsRedactedOrPending;
  /** Ids only: never a query, a term, a tag or a body. */
  readonly warn?: (message: string, context: Record<string, string>) => void;
  readonly limits?: Partial<GlobalSearchLimits>;
  /** Monotonic milliseconds; injectable for the timeout test. */
  readonly clock?: () => number;
}

export interface GlobalSearchInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly query: string;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  readonly serve: ServeContext;
  readonly audit: AuditContext;
}

export type GlobalSearchHit = ResolvedMessage & { readonly archived: boolean };

export interface GlobalSearchResult {
  /** FIRST property on purpose: the read-audit hook counts the first array property of the response. */
  readonly results: GlobalSearchHit[];
  readonly nextCursor?: string;
  /** Bodies opened by this request. */
  readonly scanned: number;
  readonly scanCapped: boolean;
  /** Too many possible matches: the client asks the user to add a word. Never paired with a nextCursor. */
  readonly refine: boolean;
}

export interface GlobalSearchService {
  search(input: GlobalSearchInput): Promise<GlobalSearchResult>;
}

const unavailable = () =>
  new WardenXError("GLOBAL_SEARCH_UNAVAILABLE", "global search is unavailable", 503);

const REFINE: GlobalSearchResult = { results: [], scanned: 0, scanCapped: true, refine: true };
const EMPTY: GlobalSearchResult = { results: [], scanned: 0, scanCapped: false, refine: false };

const setStatementTimeout = (tx: Tx) =>
  tx.execute(sql`SELECT set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true)`);

function pageSize(requested: number | undefined): number {
  if (requested === undefined) return GLOBAL_SEARCH_DEFAULT_LIMIT;
  return Math.min(GLOBAL_SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(requested)));
}

/** The first `maxChannels` distinct channels in recency order, and the candidates up to the first one outside them. */
function boundChannels(
  candidates: readonly Candidate[],
  maxChannels: number,
): { list: readonly Candidate[]; channels: readonly Candidate[]; cut: boolean } {
  const first = new Map<string, Candidate>();
  let cutAt = candidates.length;
  for (const [i, candidate] of candidates.entries()) {
    if (!first.has(candidate.channelId)) {
      if (first.size >= maxChannels) {
        cutAt = i;
        break;
      }
      first.set(candidate.channelId, candidate);
    }
  }
  return { list: candidates.slice(0, cutAt), channels: [...first.values()], cut: cutAt < candidates.length };
}

export function createGlobalSearchService(deps: GlobalSearchDeps): GlobalSearchService {
  const isRedacted = deps.isRedactedOrPending ?? neverRedacted;
  const limits: GlobalSearchLimits = {
    decryptBudget: deps.limits?.decryptBudget ?? DECRYPT_BUDGET,
    decryptTimeoutMs: deps.limits?.decryptTimeoutMs ?? DECRYPT_TIMEOUT_MS,
    maxChannels: deps.limits?.maxChannels ?? MAX_CHANNELS_PER_REQUEST,
  };
  const clock = deps.clock ?? (() => performance.now());

  /** Step 5. ONE call, the only access decider; a failure to run it at all is a 503, never a prefilter-only answer. */
  async function authorisedChannelIds(
    input: GlobalSearchInput,
    channels: readonly Candidate[],
  ): Promise<ReadonlySet<string>> {
    if (channels.length === 0) return new Set();
    try {
      const visible = await effectivelyVisibleChannels(
        input.organizationId,
        input.userId,
        channels.map((c) => ({
          channelId: c.channelId,
          kind: c.kind as ChannelKind,
          subjectId: c.subjectId,
          memberSource: c.memberSource as ChannelMemberSource | null,
        })),
        deps.part2Gate,
        deps.warn,
      );
      return new Set(visible.map((c) => c.channelId));
    } catch (error) {
      deps.warn?.("global search authority check could not run", {
        organizationId: input.organizationId,
        reason: error instanceof Error ? error.name : "unknown",
      });
      throw unavailable();
    }
  }

  interface Verified {
    readonly rows: SurvivorRow[];
    readonly opened: number;
    readonly lastExamined: Candidate | null;
    /** Candidates remain that this request did not examine. */
    readonly remaining: boolean;
  }

  /** Step 6 core: recency-ordered opens within the budget and timeout. Authorisation was decided before this is called. */
  async function openAndVerify(
    input: GlobalSearchInput,
    terms: readonly string[],
    list: readonly Candidate[],
    authorised: ReadonlySet<string>,
    current: ReadonlyMap<string, SurvivorRow>,
    limit: number,
  ): Promise<Verified> {
    const started = clock();
    const rows: SurvivorRow[] = [];
    let opened = 0;
    let lastExamined: Candidate | null = null;
    let index = 0;
    for (; index < list.length; index += 1) {
      const candidate = list[index] as Candidate;
      const row = authorised.has(candidate.channelId) ? current.get(candidate.id) : undefined;
      if (!row || isRedacted(row)) {
        lastExamined = candidate;
        continue;
      }
      if (opened >= limits.decryptBudget || clock() - started >= limits.decryptTimeoutMs) break;
      opened += 1;
      lastExamined = candidate;
      try {
        const body = await deps.bodies.read(input.organizationId, row);
        if (body.sha256 !== row.bodySha256) {
          deps.warn?.("global search skipped a body whose digest does not match", {
            organizationId: input.organizationId,
            messageId: row.id,
          });
          continue;
        }
        if (!bodyMatchesQueryTerms(body.text, terms)) continue;
      } catch {
        deps.warn?.("global search could not open a body", {
          organizationId: input.organizationId,
          messageId: row.id,
        });
        continue;
      }
      rows.push(row);
      if (rows.length >= limit) {
        index += 1;
        break;
      }
    }
    return { rows, opened, lastExamined, remaining: index < list.length };
  }

  /** Hydrate the page once per channel and attribute each care-team patient on it; both inside the caller's tx. */
  async function hydrateAndAudit(
    tx: Tx,
    input: GlobalSearchInput,
    rows: readonly SurvivorRow[],
  ): Promise<GlobalSearchHit[]> {
    const byChannel = new Map<string, SurvivorRow[]>();
    for (const row of rows) byChannel.set(row.channelId, [...(byChannel.get(row.channelId) ?? []), row]);
    const hydrated = new Map<string, ResolvedMessage>();
    for (const [channelId, channelRows] of byChannel) {
      const ctx: HydrationContext = {
        orgId: input.organizationId,
        viewerUserId: input.userId,
        channelKind: (channelRows[0] as SurvivorRow).kind,
        cipher: deps.cipher,
        warn: deps.warn,
      };
      for (const message of await hydrateMessages(tx, ctx, channelRows, channelId)) {
        hydrated.set(message.messageId, message);
      }
    }
    const patients = new Set(
      rows.flatMap((row) => (row.kind === "care_team" && row.subjectId ? [row.subjectId] : [])),
    );
    for (const patientId of patients) {
      await auditPhiRead(tx, input.audit, {
        resourceKind: "message",
        resourceId: patientId,
        patientId,
      });
    }
    return rows.flatMap((row) => {
      const message = hydrated.get(row.id);
      return message ? [{ ...message, archived: row.isArchived }] : [];
    });
  }

  return {
    async search(input) {
      const terms = parseQueryTerms(input.query);
      const cursor = input.cursor ? decodeSearchCursor(input.cursor) : null;
      if (input.cursor && !cursor) {
        throw new WardenXError("INVALID_SEARCH_QUERY", "the continuation cursor is not valid", 422);
      }
      const limit = pageSize(input.limit);
      const page = cursor?.page ?? 0;
      const active = input.serve.versions[0];
      if (!active) throw unavailable();

      let queries: Awaited<ReturnType<typeof buildVersionQueries>>;
      try {
        queries = await buildVersionQueries(
          deps.keys,
          input.organizationId,
          input.serve.versions,
          terms,
        );
      } catch (error) {
        deps.warn?.("global search key derivation failed", {
          organizationId: input.organizationId,
          reason: error instanceof Error ? error.name : "unknown",
        });
        throw unavailable();
      }
      const activeQuery = queries[0];
      if (!activeQuery) throw unavailable();
      if (isHeadBucketQuery(activeQuery.termTags, active.headBuckets)) return REFINE;

      const ctx = { organizationId: input.organizationId, userId: input.userId };
      const isActive = await withOrgContext(deps.db, ctx, (tx) =>
        isActiveMessagingUser(tx, input.organizationId, input.userId),
      );
      if (!isActive) return EMPTY;

      try {
        const after = cursor ? { createdAtIso: cursor.createdAt, id: cursor.messageId } : null;
        const raw = await withOrgContext(deps.db, ctx, async (tx) => {
          await setStatementTimeout(tx);
          return selectCandidates(tx, input.organizationId, input.userId, queries, after);
        });
        const overflow = raw.length > CANDIDATE_CAP;
        const { list, channels, cut } = boundChannels(raw.slice(0, CANDIDATE_CAP), limits.maxChannels);

        const authorised = await authorisedChannelIds(input, channels);
        const survivors = list.filter((c) => authorised.has(c.channelId) && !isRedacted(c));

        const outcome = await withOrgContext(deps.db, ctx, async (tx) => {
          await setStatementTimeout(tx);
          const current = await reselectSurvivors(
            tx,
            input.organizationId,
            input.userId,
            survivors.map((c) => c.id),
          );
          const verified = await openAndVerify(input, terms, list, authorised, current, limit);
          return { verified, hits: await hydrateAndAudit(tx, input, verified.rows) };
        });

        const { verified } = outcome;
        const more = verified.remaining || cut || overflow;
        const lastPage = page >= MAX_PAGES_PER_QUERY - 1;
        const next =
          more && !lastPage && verified.lastExamined
            ? encodeSearchCursor({
                createdAt: verified.lastExamined.createdAtIso,
                messageId: verified.lastExamined.id,
                page: page + 1,
              })
            : undefined;
        // A full page is complete; a short page that stopped on a cap is scanCapped. When the chain cannot continue (the last
        // allowed page, or nothing was examined) the client is told to refine instead of being handed a dead cursor.
        const refine = more && next === undefined;
        return {
          results: outcome.hits,
          ...(next ? { nextCursor: next } : {}),
          scanned: verified.opened,
          scanCapped: refine || (more && outcome.hits.length < limit),
          refine,
        };
      } catch (error) {
        throw searchTimeoutToError(error);
      }
    },
  };
}
