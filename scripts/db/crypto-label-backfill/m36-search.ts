// M36 global search index. The blind tags are DERIVED data (HMAC under a key derived with the search label), so they are not
// "decrypted": a message's stored tags are classified by recomputing its tags from the decrypted body under each label set and
// asking which set the stored tags contain (every whole-word tag of the body). They are rewritten with the index writer that
// the rest of M36 uses (`indexMessage`: re-checks eligibility and the body digest, drops excluded names, delete-then-insert in
// one transaction), so a rewrite is atomic per message and a reader that probes both label sets never sees a gap.
//
// NAME-EXCLUSION DIGESTS. They are HMACs under the search key, so the label flip changes them. Before the first rewrite of a
// tenant the scan runs `exclusions.sync`, which adds the new-label digest of every patient / contact name token (grow-only) and
// marks them pending; the writer's exclusion set recognises a name under EITHER label's digest, so no name is ever indexed in the
// clear while this runs. When the rewrite reaches the end without a failure the digests that were pending at its start are
// cleared: every message has been re-indexed with those names excluded, which is exactly what the pending reindex is for.
import type { DbClient } from "@chartwarden/db";
import {
  SEARCH_LABELS_CURRENT,
  type SearchKeyProvider,
  deriveChannelKey,
  tagForWord,
  tokenizeForSearch,
} from "@chartwarden/messaging";
import { sql } from "drizzle-orm";
import type { IndexWriter } from "../../../apps/backend/src/modules/36-messaging/global-search/index-writer";
import type { NameExclusions } from "../../../apps/backend/src/modules/36-messaging/global-search/name-exclusion";
import {
  type BodyReader,
  isEligibleForIndex,
  neverRedacted,
} from "../../../apps/backend/src/modules/36-messaging/global-search/ports";
import {
  type RowClass,
  type Scan,
  type TableReport,
  type WriteResult,
  inOrg,
  rowsOf,
  tryOpen,
} from "./core";

interface IndexedMessage {
  readonly id: string;
  readonly channelId: string;
  readonly status: string;
  readonly bodyKind: string;
  readonly bodyCipher: Buffer;
  /** The tags currently stored for the message under the active key version. */
  readonly storedTags: ReadonlySet<number>;
}

export interface M36SearchDeps {
  readonly db: DbClient;
  readonly keys: SearchKeyProvider;
  readonly bodies: BodyReader;
  readonly exclusions: NameExclusions;
  readonly writer: IndexWriter;
}

/** What a tenant's index was prepared with (apply only). */
export interface PreparedSearch {
  readonly keyVersion: string;
  readonly pendingAtStart: readonly string[];
}

async function readTagBits(
  db: DbClient,
  organizationId: string,
  keyVersion: string,
): Promise<number | undefined> {
  return inOrg(
    db,
    organizationId,
    async (tx) =>
      rowsOf<{ tag_bits: number }>(
        await tx.execute(sql`
        SELECT tag_bits FROM message_search_index_state
         WHERE organization_id = ${organizationId} AND key_version = ${keyVersion}`),
      )[0]?.tag_bits,
  );
}

export function m36SearchScan(
  deps: M36SearchDeps,
  organizationId: string,
  keyVersion: string,
  tagBits: number | undefined,
): Scan<IndexedMessage> {
  const { db, keys, bodies, exclusions, writer } = deps;

  /** "current" | "legacy" for one message, or "ignore" when nothing is indexed / nothing is searchable. */
  async function classifyMessage(row: IndexedMessage): Promise<RowClass> {
    if (row.storedTags.size === 0 || tagBits === undefined) return "ignore";
    if (!isEligibleForIndex(row, neverRedacted)) return "ignore"; // drift of another kind: the reconcile job owns it
    const body = await tryOpen(() =>
      bodies.read(organizationId, { bodyKind: row.bodyKind, bodyCipher: row.bodyCipher }),
    );
    if (!body) return "unreadable";
    const excluded = await exclusions.currentReadOnly(organizationId, keyVersion);
    const tokens = tokenizeForSearch(body.text, excluded);
    if (tokens.length === 0) return "ignore"; // only dummies are stored; no label is involved
    const sets = await keys.tagKeysForRead(organizationId, keyVersion);
    const containsAll = (set: (typeof sets)[number]) => {
      const channelKey = deriveChannelKey(set.key, keyVersion, tagBits, row.channelId, set.labels);
      return tokens.every((token) => row.storedTags.has(tagForWord(channelKey, token, tagBits)));
    };
    // `tagKeysForRead` lists the current set first. Tags that match no set are a stale index (an edit the index has not
    // caught up with): rewriting them is the repair, so they count as work, never as "current".
    const current = sets.find((s) => s.labels === SEARCH_LABELS_CURRENT);
    return current && containsAll(current) ? "current" : "legacy";
  }

  return {
    module: "m36-search",
    table: "message_search_token",
    organizationId,
    idOf: (row) => row.id,
    async page(after, limit) {
      return inOrg(db, organizationId, async (tx) => {
        const messages = rowsOf<{
          id: string;
          channel_id: string;
          status: string;
          body_kind: string;
          body_cipher: Buffer;
        }>(
          await tx.execute(sql`
            SELECT id::text AS id, channel_id::text AS channel_id, status::text AS status,
                   body_kind::text AS body_kind, body_cipher
              FROM message
             WHERE organization_id = ${organizationId}
               AND (${after}::uuid IS NULL OR id > ${after}::uuid)
             ORDER BY id LIMIT ${limit}`),
        );
        if (messages.length === 0) return [];
        const ids = messages.map((m) => m.id);
        const tagRows = rowsOf<{ message_id: string; tags: number[] }>(
          await tx.execute(sql`
            SELECT message_id::text AS message_id, array_agg(tag) AS tags
              FROM message_search_token
             WHERE organization_id = ${organizationId} AND key_version = ${keyVersion}
               AND message_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)
             GROUP BY message_id`),
        );
        const byMessage = new Map(tagRows.map((r) => [r.message_id, new Set(r.tags)]));
        return messages.map((m) => ({
          id: m.id,
          channelId: m.channel_id,
          status: m.status,
          bodyKind: m.body_kind,
          bodyCipher: m.body_cipher,
          storedTags: byMessage.get(m.id) ?? new Set<number>(),
        }));
      });
    },
    classify: classifyMessage,
    async reseal(row): Promise<WriteResult> {
      try {
        const outcome = await writer.indexMessage(organizationId, row.id);
        if (outcome === "skipped_off") return "skipped";
        if (outcome === "skipped_stale") return "failed";
        if (outcome === "removed") return "resealed";
        // Verify: re-read this message's tags and prove they are now the NEW set's.
        return (await verifyOne(row.id)) ? "resealed" : "failed";
      } catch {
        return "failed";
      }
    },
  };

  async function verifyOne(messageId: string): Promise<boolean> {
    const fresh = await inOrg(db, organizationId, async (tx) => {
      const m = rowsOf<{
        id: string;
        channel_id: string;
        status: string;
        body_kind: string;
        body_cipher: Buffer;
      }>(
        await tx.execute(sql`
          SELECT id::text AS id, channel_id::text AS channel_id, status::text AS status,
                 body_kind::text AS body_kind, body_cipher
            FROM message WHERE organization_id = ${organizationId} AND id = ${messageId}::uuid`),
      )[0];
      if (!m) return undefined;
      const tags = rowsOf<{ tag: number }>(
        await tx.execute(sql`
          SELECT tag FROM message_search_token
           WHERE organization_id = ${organizationId} AND key_version = ${keyVersion}
             AND message_id = ${messageId}::uuid`),
      );
      return {
        id: m.id,
        channelId: m.channel_id,
        status: m.status,
        bodyKind: m.body_kind,
        bodyCipher: m.body_cipher,
        storedTags: new Set(tags.map((t) => t.tag)),
      } satisfies IndexedMessage;
    });
    if (!fresh) return true; // deleted meanwhile
    const klass = await classifyMessage(fresh);
    return klass === "current" || klass === "ignore";
  }
}

/** The tag width of the tenant's active index, or undefined when nothing was ever indexed (nothing to do). */
export async function m36SearchState(
  deps: Pick<M36SearchDeps, "db" | "keys">,
  organizationId: string,
): Promise<{ keyVersion: string; tagBits: number | undefined }> {
  const keyVersion = await deps.keys.activeVersion(organizationId);
  return { keyVersion, tagBits: await readTagBits(deps.db, organizationId, keyVersion) };
}

/** Apply only, before the first rewrite: add the new-label name digests and remember what was pending. */
export async function m36SearchPrepare(
  deps: M36SearchDeps,
  organizationId: string,
  keyVersion: string,
): Promise<PreparedSearch> {
  await deps.exclusions.sync(organizationId, keyVersion);
  deps.exclusions.invalidate(organizationId, keyVersion);
  const pending = await inOrg(
    deps.db,
    organizationId,
    async (tx) =>
      rowsOf<{ pending: string[] | null }>(
        await tx.execute(sql`
        SELECT exclusion_pending AS pending FROM message_search_index_state
         WHERE organization_id = ${organizationId} AND key_version = ${keyVersion}`),
      )[0]?.pending,
  );
  return { keyVersion, pendingAtStart: pending ?? [] };
}

/** Apply only, after the scan: clear the digests that were pending at its start, but only for a clean full pass. */
export async function m36SearchFinish(
  deps: M36SearchDeps,
  organizationId: string,
  prepared: PreparedSearch,
  report: TableReport,
): Promise<void> {
  const clean =
    report.stoppedBy === "exhausted" &&
    report.counts.failed === 0 &&
    report.counts.skipped === 0 &&
    report.counts.unreadable === 0;
  if (!clean) return;
  await deps.exclusions.clearPending(organizationId, prepared.keyVersion, prepared.pendingAtStart);
}
