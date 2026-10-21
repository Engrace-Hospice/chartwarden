// WP 2.7b C2 (ADR-0058 decisions 1, 3, 4, 6) - writes one message's blind-token rows.
//
// ONE tenant transaction per call, in this order:
//   1. the tenant setting row, FOR SHARE (an admin's OFF update waits for this write; the purge then starts after it);
//   2. the message row, FOR SHARE (migration 1091 INDEXER CONTRACT: an edit/delete cannot commit between our read and our
//      insert, so no tokens for a vanished body are left behind; the edit/delete trigger runs under the writer's lock);
//   3. re-check eligibility (status <> 'deleted', not redacted/pending) and that the body we opened still hashes to the
//      CURRENT `body_sha256`; otherwise delete the message's tokens and stop;
//   4. tokenise the PLAIN TEXT projection (never raw stored JSON; excluded patient/contact name tokens are dropped like stop words),
//      derive the tags under the message's CHANNEL key (ADR-0058: K_ch = HKDF(K_search, version, T, channel)), pad, delete-then-bulk-insert.
// Nothing happens while the platform kill switch or the tenant flag is OFF (an inert no-op that still completes the event). The same-transaction
// delete hook in migration 1091 never consults a flag; `removeMessage` here is the unconditional repair path.
// Key and tag-width errors THROW: the caller (outbox retry, maintenance tick) fails closed and tries again.
import { type DbClient, schema } from "@chartwarden/db";
import { type SearchKeyProvider, buildMessageTags, deriveChannelKey } from "@chartwarden/messaging";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";
import { deleteSearchTokens } from "../message-search-tokens";
import { ensureIndexState } from "./index-state";
import type { NameExclusions } from "./name-exclusion";
import type { PlatformSearchFlag } from "./platform-flag";
import {
  type BodyReader,
  type IndexOutcome,
  type IsRedactedOrPending,
  isEligibleForIndex,
  neverRedacted,
} from "./ports";
import { readTenantSearchSettingInTx } from "./tenant-setting-store";

const MESSAGE = schema.messages;
const TOKENS = schema.messageSearchTokens;
/** 5 bound parameters per row; keep a statement far below the 65535-parameter protocol limit. */
const INSERT_CHUNK_ROWS = 2000;

export type { IndexOutcome };

export interface IndexWriterDeps {
  readonly db: DbClient;
  readonly bodies: BodyReader;
  readonly keys: SearchKeyProvider;
  /** The excluded patient/contact name tokens. Explicit on purpose: there is no default that would index names. */
  readonly exclusions: NameExclusions;
  readonly platformFlag: PlatformSearchFlag;
  readonly isRedactedOrPending?: IsRedactedOrPending;
  /** Ids and a fixed reason only: never a tag, a token or any body content. */
  readonly onError?: (info: IndexWriterErrorInfo) => void;
}

export interface IndexWriterErrorInfo {
  readonly organizationId: string;
  readonly messageId: string;
  readonly reason: "digest_mismatch";
}

export interface IndexWriter {
  indexMessage(organizationId: string, messageId: string): Promise<IndexOutcome>;
  /** Unconditional (flag-independent) removal of a message's rows: the repair path for a missed delete. */
  removeMessage(organizationId: string, messageId: string): Promise<number>;
}

export function createIndexWriter(deps: IndexWriterDeps): IndexWriter {
  const isRedactedOrPending = deps.isRedactedOrPending ?? neverRedacted;
  return {
    async indexMessage(organizationId, messageId) {
      if (!(await deps.platformFlag.read(organizationId)).enabled) return "skipped_off";
      const keyVersion = await deps.keys.activeVersion(organizationId);
      const searchKey = await deps.keys.tagKey(organizationId, keyVersion);
      // Read outside the tenant transaction: the first read of a tenant pages through the name source.
      const excluded = await deps.exclusions.current(organizationId, keyVersion);
      return withOrgContext(deps.db, { organizationId, userId: "" }, async (tx) => {
        const setting = await readTenantSearchSettingInTx(tx, organizationId, { lock: "share" });
        if (!setting.enabled) return "skipped_off";

        const rows = await tx
          .select({
            id: MESSAGE.id,
            channelId: MESSAGE.channelId,
            status: MESSAGE.status,
            bodyKind: MESSAGE.bodyKind,
            bodyCipher: MESSAGE.bodyCipher,
            bodySha256: MESSAGE.bodySha256,
          })
          .from(MESSAGE)
          .where(and(eq(MESSAGE.organizationId, organizationId), eq(MESSAGE.id, messageId)))
          .for("share");
        const row = rows[0];
        if (!row || !isEligibleForIndex(row, isRedactedOrPending)) {
          await deleteSearchTokens(tx, organizationId, messageId);
          return "removed";
        }

        const body = await deps.bodies.read(organizationId, row);
        if (body.sha256 !== row.bodySha256) {
          // The opened body is not the one the row's digest names (tamper, or a half-applied re-wrap): index nothing.
          await deleteSearchTokens(tx, organizationId, messageId);
          deps.onError?.({ organizationId, messageId, reason: "digest_mismatch" });
          return "skipped_stale";
        }

        const { tagBits } = await ensureIndexState(tx, organizationId, keyVersion);
        const channelKey = deriveChannelKey(searchKey, keyVersion, tagBits, row.channelId);
        const tags = buildMessageTags(channelKey, body.text, tagBits, excluded);
        await tx
          .delete(TOKENS)
          .where(
            and(
              eq(TOKENS.organizationId, organizationId),
              eq(TOKENS.keyVersion, keyVersion),
              eq(TOKENS.messageId, messageId),
            ),
          );
        for (let i = 0; i < tags.length; i += INSERT_CHUNK_ROWS) {
          await tx.insert(TOKENS).values(
            tags.slice(i, i + INSERT_CHUNK_ROWS).map((tag) => ({
              organizationId,
              keyVersion,
              channelId: row.channelId,
              tag,
              messageId,
            })),
          );
        }
        return "indexed";
      });
    },

    removeMessage: (organizationId, messageId) =>
      withOrgContext(deps.db, { organizationId, userId: "" }, (tx) =>
        deleteSearchTokens(tx, organizationId, messageId),
      ),
  };
}
