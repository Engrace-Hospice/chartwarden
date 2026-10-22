// ADR-0058 name exclusion (product-owner decision 2026-10-13) - tokens equal to a name part of a patient, of a patient's caregiver or of
// an emergency contact are never indexed and never matched; they behave exactly like stop words.
//
// WHY: the leakage experiment recovered the surname's bucket as the top concentration-lift bucket of the patient's own channel for
// about 93% of patients at any T, with or without dummies. The signal is structural (a name is frequent in one channel and rare
// elsewhere), so only removing the name from the index defends against it.
//
// WHERE THE NAMES COME FROM: the `PatientNameSource` port, backed by M5's `patientNameFragmentsPageForOrg` (injected at the composition
// root; M36 reads no M5 table). Fragments are free text: each is tokenised with the production tokenizer, every token is replaced by a
// KEYED DIGEST (`nameTokenDigest`, HMAC under K_search, 8 bytes) and the text is dropped. No name is stored, cached or logged by M36:
// the durable form is `message_search_index_state.excluded_name_digests`, meaningless without the tenant's key ring (and destroyed with
// it). The in-process form is a Set of digests; `has(token)` recomputes the HMAC of the candidate token.
//
// WHEN IT CHANGES: `sync` runs at the start of every reconcile tick (every 5 minutes for an enabled tenant). It is GROW-ONLY: a digest
// that is new is added to `excluded_name_digests` (so every writer excludes it from then on) AND to `exclusion_pending` (the messages that
// were indexed before the name existed still carry its tags). `reindexPending` finds those messages with a TARGETED lookup (the name's
// whole-word tag in every channel of the index), re-writes only them, and clears the pending digests. A renamed or deleted patient
// leaves the old name excluded (safe direction; compacting means a full rebuild). Cost is bounded: pairs (token x channel) per statement
// and per tick are capped, and the pending list is resumable across ticks and crashes. A reindex starts only after the writers' cache
// TTL has passed, so a replica that has not yet seen the digest cannot index it behind the pass.
import { type DbClient, schema } from "@chartwarden/db";
import {
  type ExcludedTokens,
  type SearchKeyProvider,
  deriveChannelKey,
  digestExclusion,
  nameTokenDigest,
  tagForWord,
  tokenizeForSearch,
} from "@chartwarden/messaging";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../messaging-write-core";
import { ensureIndexState } from "./index-state";
import type { IndexOutcome } from "./ports";

const STATE = schema.messageSearchIndexStates;

/** The port: one keyset page of the tenant's name text. An empty `fragments` with `nextAfterId === null` ends the enumeration. */
export interface PatientNameSource {
  fragmentsPage(
    organizationId: string,
    afterId: string | null,
    limit: number,
  ): Promise<{ readonly fragments: readonly string[]; readonly nextAfterId: string | null }>;
}

export class NameExclusionNotConfiguredError extends Error {
  constructor() {
    super("global search name exclusion has no name source; failing closed");
    this.name = "NameExclusionNotConfiguredError";
  }
}

export class NameExclusionNotSyncedError extends Error {
  constructor() {
    super("global search name exclusion has not been synced for this tenant; failing closed");
    this.name = "NameExclusionNotSyncedError";
  }
}

export interface NameExclusions {
  /** The WRITER's membership test for (org, version). Reads the names once (inline `sync`) when the tenant has never been synced. */
  current(organizationId: string, keyVersion: string): Promise<ExcludedTokens>;
  /**
   * The QUERY path's membership test: reads only (no state row creation, no name enumeration). A tenant that was never synced
   * throws `NameExclusionNotSyncedError` so the route fails closed (503); the first maintenance tick after enablement syncs.
   */
  currentReadOnly(organizationId: string, keyVersion: string): Promise<ExcludedTokens>;
  /**
   * Re-read the names and add the new digests (grow-only). Counts only. `complete` is false when the enumeration budget ran out:
   * the digests found are still applied (grow-only is safe) but the tenant is not marked synced.
   */
  sync(
    organizationId: string,
    keyVersion: string,
  ): Promise<{ added: number; total: number; complete: boolean }>;
  /** `sync` unless the tenant was fully synced less than NAME_SYNC_MIN_INTERVAL_MS ago (database clock). The maintenance tick uses this. */
  syncIfDue(organizationId: string, keyVersion: string): Promise<void>;
  /** Forget the cached set (after a sync, a purge or a rebuild). */
  invalidate(organizationId: string, keyVersion: string): void;
  /** The pending tokens (plaintext, memory only) for the targeted reindex: the source tokens whose digest is pending. */
  pendingTokens(
    organizationId: string,
    keyVersion: string,
  ): Promise<{
    tokens: readonly string[];
    pendingDigests: readonly string[];
    /** The delay since the LAST digest was added has passed (database clock). When false, `tokens` is empty and no names are read. */
    due: boolean;
    /** False when the enumeration budget ran out: a digest missing from `tokens` is then NOT an orphan. */
    complete: boolean;
  }>;
  /** Remove digests from the pending list (they were reindexed or no longer map to a token). */
  clearPending(
    organizationId: string,
    keyVersion: string,
    digests: readonly string[],
  ): Promise<void>;
}

/** Writers cache the digest set this long; a pending reindex waits twice as long before it looks for affected messages. */
export const EXCLUSION_CACHE_TTL_MS = 60_000;
export const EXCLUSION_REINDEX_DELAY_MS = 2 * EXCLUSION_CACHE_TTL_MS;
const NAME_PAGE_SIZE = 500;
/** A full name enumeration is capped per call so one big tenant cannot hold the (sequential) maintenance tick. */
export const NAME_ENUMERATION_BUDGET_MS = 20_000;
/** The maintenance tick re-reads a tenant's names at most this often (new names reach the writers within this window, then reindex). */
export const NAME_SYNC_MIN_INTERVAL_MS = 10 * 60_000;

export interface NameExclusionDeps {
  readonly db: DbClient;
  readonly keys: SearchKeyProvider;
  readonly names?: PatientNameSource | undefined;
  readonly now?: () => number;
}

/** Tests and unwired boots: nothing is excluded. Production must pass the real source; the composition root never uses this. */
export function createNoNameExclusions(): NameExclusions {
  const none: ExcludedTokens = { has: () => false };
  return {
    current: async () => none,
    currentReadOnly: async () => none,
    sync: async () => ({ added: 0, total: 0, complete: true }),
    syncIfDue: async () => undefined,
    invalidate: () => undefined,
    pendingTokens: async () => ({ tokens: [], pendingDigests: [], due: false, complete: true }),
    clearPending: async () => undefined,
  };
}

const textArray = (values: readonly string[]) =>
  sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`;

// ponytail: no resume cursor, so an over-budget tenant re-reads its prefix every pass; page by a persisted keyset if one ever is.
async function readNameTokens(
  source: PatientNameSource,
  organizationId: string,
  now: () => number,
): Promise<{ tokens: Set<string>; complete: boolean }> {
  const tokens = new Set<string>();
  const deadline = now() + NAME_ENUMERATION_BUDGET_MS;
  let after: string | null = null;
  do {
    if (now() >= deadline) return { tokens, complete: false };
    const page = await source.fragmentsPage(organizationId, after, NAME_PAGE_SIZE);
    for (const fragment of page.fragments)
      for (const token of tokenizeForSearch(fragment)) tokens.add(token);
    after = page.nextAfterId;
  } while (after !== null);
  return { tokens, complete: true };
}

interface CachedSet {
  readonly expiresAt: number;
  readonly exclusion: ExcludedTokens;
}

export function createNameExclusions(deps: NameExclusionDeps): NameExclusions {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, CachedSet>();
  const inFlight = new Map<string, Promise<unknown>>();
  const cacheKey = (org: string, version: string) => `${org}:${version}`;
  const inTenantTx = <T>(organizationId: string, fn: (tx: Tx) => Promise<T>) =>
    withOrgContext(deps.db, { organizationId, userId: "" }, fn);
  const source = (): PatientNameSource => {
    if (!deps.names) throw new NameExclusionNotConfiguredError();
    return deps.names;
  };
  const stateWhere = (org: string, version: string) =>
    and(eq(STATE.organizationId, org), eq(STATE.keyVersion, version));

  /** Cached digest set. `mayWrite` is the writer path (creates the state row and syncs a never-synced tenant); the query path only reads. */
  const loadSet = (organizationId: string, keyVersion: string, mayWrite: boolean) => {
    const id = cacheKey(organizationId, keyVersion);
    const hit = cache.get(id);
    if (hit && hit.expiresAt > now()) return Promise.resolve(hit.exclusion);
    const readRow = (tx: Tx) =>
      tx
        .select({ digests: STATE.excludedNameDigests, syncedAt: STATE.exclusionSyncedAt })
        .from(STATE)
        .where(stateWhere(organizationId, keyVersion))
        .then((found) => found[0]);
    const load = async (): Promise<ExcludedTokens> => {
      let row = await inTenantTx(organizationId, async (tx) => {
        if (mayWrite) await ensureIndexState(tx, organizationId, keyVersion);
        return readRow(tx);
      });
      if (!row?.syncedAt) {
        // Never synced: the names must be read BEFORE anything is indexed or matched (fail closed when there is no source).
        if (!mayWrite) throw new NameExclusionNotSyncedError();
        await self.sync(organizationId, keyVersion);
        row = await inTenantTx(organizationId, readRow);
        if (!row?.syncedAt) throw new NameExclusionNotSyncedError(); // over the enumeration budget: still not complete
      }
      const exclusion = digestExclusion(
        await deps.keys.tagKey(organizationId, keyVersion),
        new Set(row.digests ?? []),
      );
      cache.set(id, { expiresAt: now() + EXCLUSION_CACHE_TTL_MS, exclusion });
      return exclusion;
    };
    // One load per (org, version) at a time in this process: a burst of outbox events shares the first read.
    const running = inFlight.get(id) as Promise<ExcludedTokens> | undefined;
    if (running) return running;
    const started = load().finally(() => inFlight.delete(id));
    inFlight.set(id, started);
    return started;
  };

  const self: NameExclusions = {
    invalidate: (org, version) => void cache.delete(cacheKey(org, version)),

    async sync(organizationId, keyVersion) {
      const key = await deps.keys.tagKey(organizationId, keyVersion);
      const read = await readNameTokens(source(), organizationId, now);
      const digests = [...read.tokens].map((token) => nameTokenDigest(key, token));
      const result = await inTenantTx(organizationId, async (tx) => {
        await ensureIndexState(tx, organizationId, keyVersion);
        const rows = await tx
          .select({ applied: STATE.excludedNameDigests })
          .from(STATE)
          .where(stateWhere(organizationId, keyVersion))
          .for("update");
        const applied = new Set(rows[0]?.applied ?? []);
        const added = digests.filter((digest) => !applied.has(digest));
        await tx.execute(sql`
          UPDATE message_search_index_state
             SET excluded_name_digests = ARRAY(SELECT DISTINCT unnest(excluded_name_digests || ${textArray(added)})),
                 exclusion_pending = ARRAY(SELECT DISTINCT unnest(exclusion_pending || ${textArray(added)})),
                 exclusion_pending_since = CASE WHEN ${added.length} > 0 THEN now() ELSE exclusion_pending_since END,
                 exclusion_synced_at = CASE WHEN ${read.complete}::boolean THEN now() ELSE exclusion_synced_at END,
                 updated_at = now()
           WHERE organization_id = ${organizationId} AND key_version = ${keyVersion}`);
        return { added: added.length, total: applied.size + added.length, complete: read.complete };
      });
      cache.delete(cacheKey(organizationId, keyVersion));
      return result;
    },

    async syncIfDue(organizationId, keyVersion) {
      const fresh = await inTenantTx(organizationId, async (tx) => {
        const result = await tx.execute<{ fresh: boolean }>(sql`
          SELECT (exclusion_synced_at IS NOT NULL
                  AND now() - exclusion_synced_at < make_interval(secs => ${NAME_SYNC_MIN_INTERVAL_MS / 1000}::double precision)) AS fresh
            FROM message_search_index_state
           WHERE organization_id = ${organizationId} AND key_version = ${keyVersion}`);
        return result.rows[0]?.fresh === true;
      });
      if (!fresh) await self.sync(organizationId, keyVersion);
    },

    current: (organizationId, keyVersion) => loadSet(organizationId, keyVersion, true),
    currentReadOnly: (organizationId, keyVersion) => loadSet(organizationId, keyVersion, false),

    async pendingTokens(organizationId, keyVersion) {
      const state = await inTenantTx(organizationId, async (tx) => {
        const result = await tx.execute<{ pending: string[] | null; due: boolean }>(sql`
          SELECT exclusion_pending AS pending,
                 (exclusion_pending_since IS NOT NULL
                  AND now() - exclusion_pending_since
                      >= make_interval(secs => ${EXCLUSION_REINDEX_DELAY_MS / 1000}::double precision)) AS due
            FROM message_search_index_state
           WHERE organization_id = ${organizationId} AND key_version = ${keyVersion}`);
        return result.rows[0];
      });
      const pendingDigests = state?.pending ?? [];
      if (pendingDigests.length === 0 || state?.due !== true) {
        return { tokens: [], pendingDigests, due: false, complete: true };
      }
      const key = await deps.keys.tagKey(organizationId, keyVersion);
      const wanted = new Set(pendingDigests);
      const read = await readNameTokens(source(), organizationId, now);
      const tokens = [...read.tokens].filter((token) => wanted.has(nameTokenDigest(key, token)));
      return { tokens, pendingDigests, due: true, complete: read.complete };
    },

    async clearPending(organizationId, keyVersion, digests) {
      if (digests.length === 0) return;
      await inTenantTx(organizationId, (tx) =>
        tx.execute(sql`
          UPDATE message_search_index_state
             SET exclusion_pending = ARRAY(SELECT p FROM unnest(exclusion_pending) p
                                            WHERE p <> ALL(${textArray(digests)})),
                 exclusion_pending_since = CASE
                   WHEN cardinality(ARRAY(SELECT p FROM unnest(exclusion_pending) p
                                           WHERE p <> ALL(${textArray(digests)}))) = 0 THEN NULL
                   ELSE exclusion_pending_since END,
                 updated_at = now()
           WHERE organization_id = ${organizationId} AND key_version = ${keyVersion}`),
      );
    },
  };
  return self;
}

// ── targeted reindex ─────────────────────────────────────────────────────────────────────────────────────────────────

/** (token x channel) tag probes per statement, and per reconcile tick for one tenant. */
export const REINDEX_PAIRS_PER_STATEMENT = 5000;
export const REINDEX_BUDGET_MS = 30_000;

export interface PendingReindexDeps {
  readonly db: DbClient;
  readonly keys: SearchKeyProvider;
  readonly exclusions: NameExclusions;
  readonly indexMessage: (organizationId: string, messageId: string) => Promise<IndexOutcome>;
  readonly now?: () => number;
  /** Counts only. */
  readonly onProgress?: (info: {
    organizationId: string;
    reindexed: number;
    remaining: number;
  }) => void;
}

async function channelsOfIndex(
  tx: Tx,
  organizationId: string,
  keyVersion: string,
): Promise<string[]> {
  const result = await tx.execute<{ channel_id: string }>(sql`
    SELECT DISTINCT channel_id::text AS channel_id FROM message_search_token
     WHERE organization_id = ${organizationId} AND key_version = ${keyVersion}`);
  return result.rows.map((row) => row.channel_id);
}

async function messagesWithTags(
  tx: Tx,
  organizationId: string,
  keyVersion: string,
  pairs: readonly { readonly channelId: string; readonly tag: number }[],
): Promise<string[]> {
  if (pairs.length === 0) return [];
  const values = sql.join(
    pairs.map((pair) => sql`(${pair.channelId}::uuid, ${pair.tag}::int)`),
    sql`, `,
  );
  const result = await tx.execute<{ message_id: string }>(sql`
    WITH q(channel_id, tag) AS (VALUES ${values})
    SELECT DISTINCT t.message_id::text AS message_id
      FROM message_search_token t
      JOIN q ON q.channel_id = t.channel_id AND q.tag = t.tag
     WHERE t.organization_id = ${organizationId} AND t.key_version = ${keyVersion}`);
  return result.rows.map((row) => row.message_id);
}

/**
 * Re-write the already-indexed messages that still carry a pending excluded name. Returns the number of messages rewritten. A no-op
 * until the pending digests are older than the writers' cache TTL (twice), and resumable: a crash leaves the digests pending.
 */
export async function reindexPendingExclusions(
  deps: PendingReindexDeps,
  organizationId: string,
  keyVersion: string,
  tagBits: number,
): Promise<number> {
  const now = deps.now ?? Date.now;
  const pending = await deps.exclusions.pendingTokens(organizationId, keyVersion);
  if (pending.pendingDigests.length === 0 || !pending.due) return 0;

  deps.exclusions.invalidate(organizationId, keyVersion);
  const searchKey = await deps.keys.tagKey(organizationId, keyVersion);
  const digestOf = (token: string) => nameTokenDigest(searchKey, token);
  const channels = await withOrgContext(deps.db, { organizationId, userId: "" }, (tx) =>
    channelsOfIndex(tx, organizationId, keyVersion),
  );
  const channelKeys = new Map(
    channels.map((channelId) => [
      channelId,
      deriveChannelKey(searchKey, keyVersion, tagBits, channelId),
    ]),
  );
  const batchSize = Math.max(
    1,
    Math.floor(REINDEX_PAIRS_PER_STATEMENT / Math.max(1, channels.length)),
  );
  const deadline = now() + REINDEX_BUDGET_MS;
  const done = new Set<string>();
  let reindexed = 0;
  for (let i = 0; i < pending.tokens.length && now() < deadline; i += batchSize) {
    const batch = pending.tokens.slice(i, i + batchSize);
    const pairs = batch.flatMap((token) =>
      channels.map((channelId) => ({
        channelId,
        tag: tagForWord(channelKeys.get(channelId) as Buffer, token, tagBits),
      })),
    );
    const messageIds = await withOrgContext(deps.db, { organizationId, userId: "" }, (tx) =>
      messagesWithTags(tx, organizationId, keyVersion, pairs),
    );
    let clean = true;
    for (const messageId of messageIds) {
      const outcome = await deps.indexMessage(organizationId, messageId);
      if (outcome === "skipped_stale" || outcome === "skipped_off") clean = false;
      reindexed += 1;
    }
    // A message that was not rewritten may still carry the name: leave the whole batch pending for the next pass.
    if (clean) for (const token of batch) done.add(digestOf(token));
  }
  // Digests whose token no longer appears in the source (a deleted patient) have nothing to reindex: clear them too.
  const known = new Set(pending.tokens.map(digestOf));
  // Only when the enumeration finished: after a budget cut a missing digest may simply not have been read yet.
  const orphans = pending.complete
    ? pending.pendingDigests.filter((digest) => !known.has(digest))
    : [];
  await deps.exclusions.clearPending(organizationId, keyVersion, [...done, ...orphans]);
  deps.onProgress?.({
    organizationId,
    reindexed,
    remaining: pending.pendingDigests.filter((d) => !done.has(d) && !orphans.includes(d)).length,
  });
  return reindexed;
}
