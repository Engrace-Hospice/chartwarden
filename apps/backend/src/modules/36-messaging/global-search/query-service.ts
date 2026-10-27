// WP 2.7b C3 (ADR-0058 decisions 8, 9, 13) - the global search query pipeline. The route has already run the gates (permission,
// rate limit, kill switches, serve gate, role gate) and hands this service the `ServeContext` they produced.
//
//   1. terms (the query tokenised like the index; a patient/contact NAME stays an ordinary term that can match nothing - no index
//      row holds it and the body check ignores it - so it is indistinguishable from an unknown word: no name-existence oracle),
//      then isActiveMessagingUser
//   2. the caller's searchable channels (active membership + announcement, the MAX_QUERY_CHANNELS most recently active) and ONE tag
//      per term PER CHANNEL per live key version (per-channel keys). A channel where every term is a head bucket is skipped; if all
//      are, the head-bucket refusal (refine:true, NO candidate SQL, NO decrypt). Channel cap / head skip => scanCapped:true.
//   3. ROUNDS (at most MAX_PAGES_PER_QUERY per request), each: TRANSACTION 1 coarse SQL prefilter (tags -> messages the caller
//      is a member of, or announcements; distinct messages across key versions; keyset; cap 500) -> AUTHORITY outside any
//      transaction (`authority`, by default `effectivelyVisibleChannels`, the only decider; at most 50 distinct channels per
//      call) -> TRANSACTION 2 re-select of the authorised rows with the same membership join. Only rows that are authorised,
//      still present and not redacted enter the VISIBLE queue.
//   4. Bodies are opened from the visible queue only, in recency order, within the decrypt budget and timeout; each current
//      row is re-verified and the query terms are verified against the plaintext.
//   5. A last transaction re-checks the active user and the membership of the collected rows, hydrates the page once per
//      channel and writes one attributed read per distinct patient (a failed audit write fails the read).
//
// NO RESPONSE FIELD DEPENDS ON A HIDDEN ROW (security review HIGH-1). `nextCursor`, `refine`, `scanCapped`, `scanned` and the
// page content are derived from the VISIBLE rows only. The cursor names the last VISIBLE row examined, never a candidate that
// was dropped for Part 2, a lapsed roster, removal or redaction. The pre-authority caps (500 candidates, 50 channels per call)
// are therefore not shown to the caller: when one is reached the service CONTINUES SCANNING INTERNALLY (next round, from an
// internal position that is never emitted) up to MAX_PAGES_PER_QUERY rounds or the 100-channel budget.
// TRUNCATION IS NEVER SILENT. If a limit (5 rounds, 100 channels) ends the scan while candidates remain and nothing further is
// visible, the response is still WITHOUT a cursor (a cursor would be derived from a hidden position or would expose that more
// raw rows exist) but carries `scanCapped: true` (and `refine: true` when the page is empty), so it never reads as "complete".
// The same applies after a full page whose one extra round found nothing visible. ORACLE DECISION: this flag can be set by
// hidden volume (a caller behind > 5 x 500 hidden candidates or > 100 channels sees "a limit was hit"), but it reveals only
// that a bound was reached, never a count, a channel or a row, and a caller can already provoke it with a broad query; the
// accepted recall cost stands, silent completeness does not.
//
// RESIDUAL TOCTOU WINDOW (security review MED-5): authority is evaluated once per round, outside any transaction. Membership
// and the active-user check are re-read in the last transaction, but a Part 2 consent revocation or a care-team roster change
// that lands after the authority call and before the page is returned is not seen by this request (milliseconds to seconds,
// bounded by the 5 s statement timeout and the 3 s decrypt budget). The next request sees it.
//
// DECRYPT_TIMEOUT_MS counts time spent OPENING bodies only (checked between opens, so it overshoots by at most one open: one
// AES-GCM open, or one key-vault call after WP 2.13). Fill rounds have their own bounds (rounds, statement timeout) and never
// consume it, so hidden-driven slowness cannot turn a visible result into refine / no cursor.
//
// WORST-CASE COST PER REQUEST (L1): at most MAX_PAGES_PER_QUERY (5) rounds; each round is one prefilter statement (<= 501 rows,
// keyset applied before the aggregate on continuation pages), at most ONE authority call over <= 50 channels, and one re-select
// of <= 500 ids; the authority is asked about at most MAX_TOTAL_CHANNELS_PER_REQUEST (100) distinct channels in total (each
// care-team channel costs one Part 2 call and, for an auto member, one roster call), after which scanning stops and the cursor
// from the last visible row reaches the rest. Plus at most 200 body opens (3 s) and one final transaction. A full page costs at
// most ONE extra round, only to decide whether a cursor exists (visible-derived, never hidden-shaped).
//
// SEAM OUTAGES (L5): a Part 2 / roster outage excludes the channel (fail closed, an empty 200: the ADR makes a seam error a silent
// exclusion, not an error response). It is observable: `effectivelyVisibleChannels` logs ids per patient and this service logs
// one warn per authority call with the organisation id and the outage COUNT.
//
// This is the ONLY module of the query path that holds a `BodyReader`, and it opens bodies only after the authority call.
// Fail closed: key derivation, the authority call, the transactions and the audit write all propagate as errors, never as a
// prefilter-only, plaintext-scan or unaudited answer. No tag, term or query text is logged.
import { type AuditContext, auditPhiRead } from "@chartwarden/audit";
import type { DbClient } from "@chartwarden/db";
import {
  CANDIDATE_CAP,
  DECRYPT_BUDGET,
  DECRYPT_TIMEOUT_MS,
  type ExcludedTokens,
  MAX_PAGES_PER_QUERY,
  MAX_QUERY_CHANNELS,
  type ResolvedMessage,
  STATEMENT_TIMEOUT_MS,
  type SearchKeyProvider,
  decodeSearchCursor,
  encodeSearchCursor,
} from "@chartwarden/messaging";
import type { ChannelKind, ChannelMemberSource } from "@chartwarden/messaging";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError } from "@chartwarden/types";
import { sql } from "drizzle-orm";
import { searchTimeoutToError } from "../message-search-service-db";
import { type HydrationContext, hydrateMessages } from "../messaging-message-hydration";
import { effectivelyVisibleChannels, isActiveMessagingUser } from "../messaging-route-service-db";
import type { MessageBodyCipher, Tx } from "../messaging-write-core";
import type { Part2ChannelGate } from "../part2-channel-gate";
import type { NameExclusions } from "./name-exclusion";
import { type BodyReader, type IsRedactedOrPending, neverRedacted } from "./ports";
import {
  type Candidate,
  type KeysetPosition,
  type SurvivorRow,
  reselectSurvivors,
  selectCandidates,
  selectQueryChannels,
} from "./query-sql";
import {
  type VersionQuery,
  bodyMatchesQueryTerms,
  buildVersionQueries,
  parseQueryTerms,
} from "./query-terms";
import type { ServeContext } from "./serve-gate";

/** Distinct channels authorised per authority call (ADR "bounded seam cost"); further channels are reached by a later round. */
export const MAX_CHANNELS_PER_REQUEST = 50;
/** ... and across all rounds of one request (cost amplification bound; later channels are reached by the cursor). */
export const MAX_TOTAL_CHANNELS_PER_REQUEST = 100;
export const GLOBAL_SEARCH_DEFAULT_LIMIT = 20;
export const GLOBAL_SEARCH_MAX_LIMIT = 50;

export interface GlobalSearchLimits {
  readonly decryptBudget: number;
  readonly decryptTimeoutMs: number;
  readonly maxChannels: number;
  /** Distinct channels sent to the authority across ALL rounds of one request. */
  readonly maxTotalChannels: number;
}

export interface AuthorityCandidate {
  readonly channelId: string;
  readonly kind: ChannelKind;
  readonly subjectId: string | null;
  readonly memberSource: ChannelMemberSource | null;
}

/** The access decider. Production: `effectivelyVisibleChannels`. Injectable so the "authority cannot run" path is testable. */
export type ChannelAuthority = (
  orgId: string,
  userId: string,
  candidates: readonly AuthorityCandidate[],
  part2Gate: Part2ChannelGate,
  warn?: (message: string, context: Record<string, string>) => void,
  onSeamUnavailable?: () => void,
) => Promise<readonly AuthorityCandidate[]>;

export interface GlobalSearchDeps {
  readonly db: DbClient;
  readonly bodies: BodyReader;
  readonly keys: SearchKeyProvider;
  /** The excluded patient/contact name tokens (ADR-0058 name exclusion). Explicit: there is no default that would match names. */
  readonly exclusions: NameExclusions;
  readonly part2Gate: Part2ChannelGate;
  /** Hydration of the returned page only (the shared history read path), so a result never shows more than the channel does. */
  readonly cipher: MessageBodyCipher;
  readonly authority?: ChannelAuthority;
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
  new ChartWardenError("GLOBAL_SEARCH_UNAVAILABLE", "global search is unavailable", 503);

const REFINE: GlobalSearchResult = { results: [], scanned: 0, scanCapped: true, refine: true };
const EMPTY: GlobalSearchResult = { results: [], scanned: 0, scanCapped: false, refine: false };

const setStatementTimeout = (tx: Tx) =>
  tx.execute(sql`SELECT set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true)`);

function pageSize(requested: number | undefined): number {
  if (requested === undefined) return GLOBAL_SEARCH_DEFAULT_LIMIT;
  return Math.min(GLOBAL_SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(requested)));
}

/** The candidates up to the first one whose (not yet decided) channel would exceed `allowance`, and those channels' first rows. */
function boundChannels(
  candidates: readonly Candidate[],
  decided: ReadonlyMap<string, boolean>,
  allowance: number,
): { list: readonly Candidate[]; fresh: readonly Candidate[]; cut: boolean } {
  const fresh = new Map<string, Candidate>();
  let cutAt = candidates.length;
  for (const [i, candidate] of candidates.entries()) {
    if (decided.has(candidate.channelId) || fresh.has(candidate.channelId)) continue;
    if (fresh.size >= allowance) {
      cutAt = i;
      break;
    }
    fresh.set(candidate.channelId, candidate);
  }
  return {
    list: candidates.slice(0, cutAt),
    fresh: [...fresh.values()],
    cut: cutAt < candidates.length,
  };
}

interface VisibleRow {
  readonly candidate: Candidate;
  readonly row: SurvivorRow;
}

/** The per-request scan: an INTERNAL raw position (never emitted), the channel verdicts and the queue of visible rows. */
interface Scan {
  position: KeysetPosition | null;
  exhausted: boolean;
  rounds: number;
  /** The 100-channel budget ended the scan with candidates left (not exhausted, cannot continue). */
  stopped: boolean;
  readonly decided: Map<string, boolean>;
  readonly queue: VisibleRow[];
}

export function createGlobalSearchService(deps: GlobalSearchDeps): GlobalSearchService {
  const isRedacted = deps.isRedactedOrPending ?? neverRedacted;
  const authority: ChannelAuthority = deps.authority ?? effectivelyVisibleChannels;
  const limits: GlobalSearchLimits = {
    decryptBudget: deps.limits?.decryptBudget ?? DECRYPT_BUDGET,
    decryptTimeoutMs: deps.limits?.decryptTimeoutMs ?? DECRYPT_TIMEOUT_MS,
    maxChannels: deps.limits?.maxChannels ?? MAX_CHANNELS_PER_REQUEST,
    maxTotalChannels: deps.limits?.maxTotalChannels ?? MAX_TOTAL_CHANNELS_PER_REQUEST,
  };
  const clock = deps.clock ?? (() => performance.now());
  const inTenantTx = <T>(input: GlobalSearchInput, fn: (tx: Tx) => Promise<T>) =>
    withOrgContext(
      deps.db,
      { organizationId: input.organizationId, userId: input.userId },
      async (tx) => {
        await setStatementTimeout(tx);
        return fn(tx);
      },
    );

  /** Ask the authority about the channels of this round that have no verdict yet. A failure to run it at all is a 503. */
  async function decide(input: GlobalSearchInput, scan: Scan, fresh: readonly Candidate[]) {
    if (fresh.length === 0) return;
    let allowed: readonly AuthorityCandidate[];
    let seamOutages = 0;
    try {
      allowed = await authority(
        input.organizationId,
        input.userId,
        fresh.map((c) => ({
          channelId: c.channelId,
          kind: c.kind as ChannelKind,
          subjectId: c.subjectId,
          memberSource: c.memberSource as ChannelMemberSource | null,
        })),
        deps.part2Gate,
        deps.warn,
        () => {
          seamOutages += 1;
        },
      );
    } catch (error) {
      deps.warn?.("global search authority check could not run", {
        organizationId: input.organizationId,
        reason: error instanceof Error ? error.name : "unknown",
      });
      throw unavailable();
    }
    if (seamOutages > 0) {
      // L5: a consent/roster outage is observable per request (ids and a count only). The channel stays excluded (fail closed,
      // an empty 200): the ADR makes a seam error a silent exclusion, not an error response.
      deps.warn?.("global search excluded channels because a visibility seam was unavailable", {
        organizationId: input.organizationId,
        outages: String(seamOutages),
      });
    }
    const ok = new Set(allowed.map((c) => c.channelId));
    for (const c of fresh) scan.decided.set(c.channelId, ok.has(c.channelId));
  }

  /** One round: prefilter -> authority -> re-select; appends the visible rows to the queue. The raw position stays internal. */
  async function fillRound(
    input: GlobalSearchInput,
    queries: readonly VersionQuery[],
    scan: Scan,
  ): Promise<void> {
    const raw = await inTenantTx(input, (tx) =>
      selectCandidates(tx, input.organizationId, input.userId, queries, scan.position),
    );
    const covered = raw.slice(0, CANDIDATE_CAP);
    const remaining = limits.maxTotalChannels - scan.decided.size;
    const allowance = Math.min(limits.maxChannels, remaining);
    const { list, fresh, cut } = boundChannels(covered, scan.decided, allowance);
    await decide(input, scan, fresh);
    scan.rounds += 1;
    // Out of the per-request channel budget: stop scanning (LOW-1: no further rounds); the response flags the truncation.
    scan.stopped = cut && scan.decided.size >= limits.maxTotalChannels;
    scan.exhausted = raw.length <= CANDIDATE_CAP && !cut;
    const last = list[list.length - 1];
    if (last) scan.position = { createdAtIso: last.createdAtIso, id: last.id };
    const survivors = list.filter((c) => scan.decided.get(c.channelId) === true && !isRedacted(c));
    const current = await inTenantTx(input, (tx) =>
      reselectSurvivors(
        tx,
        input.organizationId,
        input.userId,
        survivors.map((c) => c.id),
      ),
    );
    for (const candidate of survivors) {
      const row = current.get(candidate.id);
      if (row && row.channelId === candidate.channelId && !isRedacted(row)) {
        scan.queue.push({ candidate, row });
      }
    }
  }

  const canFill = (scan: Scan) =>
    !scan.exhausted && !scan.stopped && scan.rounds < MAX_PAGES_PER_QUERY;

  /** Open and verify visible rows in recency order; stops at the page size, the budget or the end of what is visible. */
  async function drain(
    input: GlobalSearchInput,
    queries: readonly VersionQuery[],
    terms: readonly string[],
    excluded: ExcludedTokens,
    scan: Scan,
    limit: number,
  ) {
    // The decrypt timer counts time spent OPENING bodies only: (hidden-driven) fill rounds must not shape the answer.
    let decryptMs = 0;
    const rows: SurvivorRow[] = [];
    let opened = 0;
    let lastExamined: Candidate | null = null;
    for (;;) {
      const full = rows.length >= limit;
      // L2: a full page needs ONE extra round at most, only to decide whether a cursor exists.
      if (scan.queue.length === 0 && canFill(scan)) {
        await fillRound(input, queries, scan);
        if (!full) continue;
      }
      const next = scan.queue[0];
      if (!next || full) break;
      if (opened >= limits.decryptBudget) break;
      if (decryptMs >= limits.decryptTimeoutMs) break;
      scan.queue.shift();
      opened += 1;
      lastExamined = next.candidate;
      const openedAt = clock();
      const matched = await matches(input, terms, excluded, next.row);
      decryptMs += clock() - openedAt;
      if (matched) rows.push(next.row);
    }
    // Nothing visible is left to open, yet the raw scan did not reach its end (round or channel limit): not a complete answer.
    const truncated = scan.queue.length === 0 && !scan.exhausted;
    return { rows, opened, lastExamined, more: scan.queue.length > 0, truncated };
  }

  async function matches(
    input: GlobalSearchInput,
    terms: readonly string[],
    excluded: ExcludedTokens,
    row: SurvivorRow,
  ): Promise<boolean> {
    try {
      const body = await deps.bodies.read(input.organizationId, row);
      if (body.sha256 !== row.bodySha256) {
        deps.warn?.("global search skipped a body whose digest does not match", {
          organizationId: input.organizationId,
          messageId: row.id,
        });
        return false;
      }
      return bodyMatchesQueryTerms(body.text, terms, excluded);
    } catch {
      deps.warn?.("global search could not open a body", {
        organizationId: input.organizationId,
        messageId: row.id,
      });
      return false;
    }
  }

  /**
   * The last transaction: the user must still be active and each collected row still readable by membership (and unchanged);
   * then hydrate once per channel and attribute each care-team patient on the page.
   */
  function finish(input: GlobalSearchInput, collected: readonly SurvivorRow[]) {
    return inTenantTx(input, async (tx): Promise<GlobalSearchHit[]> => {
      if (collected.length === 0) return [];
      if (!(await isActiveMessagingUser(tx, input.organizationId, input.userId))) return [];
      const current = await reselectSurvivors(
        tx,
        input.organizationId,
        input.userId,
        collected.map((r) => r.id),
      );
      const rows = collected.flatMap((r) => {
        const now = current.get(r.id);
        return now && now.bodySha256 === r.bodySha256 && !isRedacted(now) ? [now] : [];
      });
      return hydrateAndAudit(tx, input, rows);
    });
  }

  async function hydrateAndAudit(
    tx: Tx,
    input: GlobalSearchInput,
    rows: readonly SurvivorRow[],
  ): Promise<GlobalSearchHit[]> {
    const byChannel = new Map<string, SurvivorRow[]>();
    for (const row of rows) {
      byChannel.set(row.channelId, [...(byChannel.get(row.channelId) ?? []), row]);
    }
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
      rows.flatMap((row) =>
        (row.kind === "care_team" || row.kind === "family") && row.subjectId ? [row.subjectId] : [],
      ),
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

  /** The terms (names dropped like stop words) and the cursor; no channel or key work yet. */
  async function parse(input: GlobalSearchInput) {
    const active = input.serve.versions[0];
    if (!active) throw unavailable();
    let excluded: ExcludedTokens;
    try {
      excluded = await deps.exclusions.currentReadOnly(input.organizationId, active.keyVersion);
    } catch (error) {
      deps.warn?.("global search name exclusion is unavailable", {
        organizationId: input.organizationId,
        reason: error instanceof Error ? error.name : "unknown",
      });
      throw unavailable();
    }
    const terms = parseQueryTerms(input.query);
    const cursor = input.cursor ? decodeSearchCursor(input.cursor) : null;
    if (input.cursor && !cursor) {
      throw new ChartWardenError(
        "INVALID_SEARCH_QUERY",
        "the continuation cursor is not valid",
        422,
      );
    }
    return { terms, cursor, excluded };
  }

  /**
   * The per-channel tags of the caller's searchable channels (membership or announcement; the most recently active
   * MAX_QUERY_CHANNELS of them). `partial` is true when the channel cap or the head-bucket skip left channels out: the response is
   * then flagged scanCapped (never silent), and it reveals only that a bound was reached, never a channel or a count.
   */
  async function prepare(input: GlobalSearchInput, terms: readonly string[]) {
    const found = await inTenantTx(input, (tx) =>
      selectQueryChannels(tx, input.organizationId, input.userId),
    );
    const channelIds = found.slice(0, MAX_QUERY_CHANNELS);
    try {
      const built = await buildVersionQueries(
        deps.keys,
        input.organizationId,
        input.serve.versions,
        terms,
        channelIds,
      );
      const searchable = built.queries.reduce((sum, query) => sum + query.channels.length, 0);
      return {
        queries: built.queries,
        searchable,
        partial: found.length > MAX_QUERY_CHANNELS || built.headSkipped > 0,
        onlyHeads: searchable === 0 && built.headSkipped > 0,
      };
    } catch (error) {
      deps.warn?.("global search key derivation failed", {
        organizationId: input.organizationId,
        reason: error instanceof Error ? error.name : "unknown",
      });
      throw unavailable();
    }
  }

  return {
    async search(input) {
      const { terms, cursor, excluded } = await parse(input);
      const isActive = await withOrgContext(
        deps.db,
        { organizationId: input.organizationId, userId: input.userId },
        (tx) => isActiveMessagingUser(tx, input.organizationId, input.userId),
      );
      if (!isActive) return EMPTY;
      const { queries, searchable, partial, onlyHeads } = await prepare(input, terms);
      // Every searched channel is a head bucket for this query: refused up front, no candidate SQL, no decrypt.
      if (onlyHeads) return REFINE;
      if (searchable === 0) return EMPTY;

      const limit = pageSize(input.limit);
      const page = cursor?.page ?? 0;
      const scan: Scan = {
        position: cursor ? { createdAtIso: cursor.createdAt, id: cursor.messageId } : null,
        exhausted: false,
        rounds: 0,
        stopped: false,
        decided: new Map(),
        queue: [],
      };
      try {
        const drained = await drain(input, queries, terms, excluded, scan, limit);
        const hits = await finish(input, drained.rows);
        const next =
          drained.more && page < MAX_PAGES_PER_QUERY - 1 && drained.lastExamined
            ? encodeSearchCursor({
                createdAt: drained.lastExamined.createdAtIso,
                messageId: drained.lastExamined.id,
                page: page + 1,
              })
            : undefined;
        // Everything below derives from VISIBLE rows only. When the chain cannot continue (last allowed page) the client is
        // told to refine instead of being handed a dead cursor.
        const refine = drained.more && next === undefined;
        return {
          results: hits,
          ...(next ? { nextCursor: next } : {}),
          scanned: drained.opened,
          scanCapped:
            partial || refine || drained.truncated || (drained.more && hits.length < limit),
          refine: refine || (drained.truncated && hits.length === 0),
        };
      } catch (error) {
        throw searchTimeoutToError(error);
      }
    },
  };
}
