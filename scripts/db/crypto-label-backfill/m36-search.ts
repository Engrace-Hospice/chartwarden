// M36 global search index. The blind tags are DERIVED data (HMAC under a key derived with the search label), so they are not
// "decrypted": a message's stored tags are classified by recomputing its tags from the decrypted body under the one remaining
// label and asking whether the stored tags contain every one of them (and none of an excluded name). READ-ONLY: a message whose
// tags were derived under the removed legacy label reports as "unreadable" (not searchable) until the index is rebuilt.
import type { DbClient } from "@chartwarden/db";
import {
  type SearchKeyProvider,
  deriveChannelKey,
  tagForWord,
  tokenizeForSearch,
} from "@chartwarden/messaging";
import { sql } from "drizzle-orm";
import {
  NameExclusionNotSyncedError,
  type NameExclusions,
} from "../../../apps/backend/src/modules/36-messaging/global-search/name-exclusion";
import {
  type BodyReader,
  isEligibleForIndex,
  neverRedacted,
} from "../../../apps/backend/src/modules/36-messaging/global-search/ports";
import { type RowClass, type Scan, inOrg, rowsOf, tryOpen } from "./core";

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
  const { db, keys, bodies, exclusions } = deps;

  /** "current" or "unreadable" for one message, or "ignore" when nothing is indexed / nothing is searchable. */
  async function classifyMessage(row: IndexedMessage): Promise<RowClass> {
    if (row.storedTags.size === 0 || tagBits === undefined) return "ignore";
    if (!isEligibleForIndex(row, neverRedacted)) return "ignore"; // drift of another kind: the reconcile job owns it
    const body = await tryOpen(() =>
      bodies.read(organizationId, { bodyKind: row.bodyKind, bodyCipher: row.bodyCipher }),
    );
    if (!body) return "unreadable";
    let excluded: Awaited<ReturnType<typeof exclusions.currentReadOnly>>;
    try {
      excluded = await exclusions.currentReadOnly(organizationId, keyVersion);
    } catch (error) {
      // One tenant whose names were never synced must not abort a multi-tenant run: it counts as unresolved rows instead.
      if (error instanceof NameExclusionNotSyncedError) return "unreadable";
      throw error;
    }
    const tokens = tokenizeForSearch(body.text, excluded);
    if (tokens.length === 0) return "ignore"; // only dummies are stored; no label is involved
    // Tokens the index must NOT carry: the body's non-stop-word tokens that the exclusion set removed (patient / contact names).
    const everyToken = tokenizeForSearch(body.text);
    const excludedTokens = everyToken.filter((t) => !tokens.includes(t));
    const channelKey = deriveChannelKey(
      await keys.tagKey(organizationId, keyVersion),
      keyVersion,
      tagBits,
      row.channelId,
    );
    const containsAll = tokens.every((token) =>
      row.storedTags.has(tagForWord(channelKey, token, tagBits)),
    );
    const carriesExcludedName = excludedTokens.some((token) =>
      row.storedTags.has(tagForWord(channelKey, token, tagBits)),
    );
    return containsAll && !carriesExcludedName ? "current" : "unreadable";
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
  };
}

/**
 * Every LIVE key version of the tenant's index (active first) with its tag width (undefined when nothing was ever indexed under
 * it). A rotation overlap leaves tags under more than one version; each is verified under its own key.
 */
export async function m36SearchState(
  deps: Pick<M36SearchDeps, "db" | "keys">,
  organizationId: string,
): Promise<Array<{ keyVersion: string; tagBits: number | undefined }>> {
  const versions = await deps.keys.liveVersions(organizationId);
  return Promise.all(
    versions.map(async (keyVersion) => ({
      keyVersion,
      tagBits: await readTagBits(deps.db, organizationId, keyVersion),
    })),
  );
}
