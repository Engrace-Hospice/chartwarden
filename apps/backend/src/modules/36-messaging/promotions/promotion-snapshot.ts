// apps/backend/src/modules/36-messaging/promotions/promotion-snapshot.ts - WP 3.7: re-read the proposed message text at
// REVIEW time and prove it is the text that was proposed. M36 keeps no copy: a request stores the SHA-256 of the body at
// request time. The text comes from the live message when its hash still matches, else from the append-only revision that
// carries that hash (the sender edited it since). The opened plaintext is hashed again and must equal the recorded hash, so
// a corrupted or swapped row yields nothing. Erased, deleted, missing or unmatched => null (fail closed). The decrypt path is
// the one the channel history already uses (MessageBodyCipher.open + storedBodyToPlainText); no new crypto lives here.
import { type DbClient, schema } from "@chartwarden/db";
import { messageBodySha256 } from "@chartwarden/messaging";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { storedBodyToPlainText } from "@chartwarden/types";
import { and, desc, eq } from "drizzle-orm";
import type { MessageBodyCipher } from "../messaging-write-core";

const MSG = schema.messages;
const REV = schema.messageRevisions;

/** The only decrypt capability the snapshot needs: the entitled-reader open of a `body_cipher`. */
export type PromotionBodyOpener = Pick<MessageBodyCipher, "open">;

export interface StoredBody {
  readonly bodyCipher: Buffer;
  readonly bodyKind: string;
  readonly bodySha256: string;
}

export interface PromotionBodyPorts {
  /** The live message body, or null when the message is missing or deleted. */
  current(orgId: string, messageId: string): Promise<StoredBody | null>;
  /** The newest revision whose body hash equals `sha256`, or null. */
  revisionBySha(orgId: string, messageId: string, sha256: string): Promise<StoredBody | null>;
  open(orgId: string, cipher: Buffer): Promise<string>;
}

export interface ResolvedSnapshot {
  /** Null unless the caller asked for the text AND the message is unchanged (an edited message serves no text). */
  readonly text: string | null;
  readonly sourceState: "current" | "edited_since";
}

const erased = (b: StoredBody): boolean => b.bodyCipher.length === 0;

/**
 * Whether the proposed message can still be proven, and whether it changed since, or null when it cannot. The body is
 * decrypted ONLY when `withText` is set and the message is unchanged: every other caller learns provability from the
 * stored hash and never causes a decrypt (an edited message's superseded text is never opened for anyone).
 */
export async function resolveSnapshot(
  ports: PromotionBodyPorts,
  orgId: string,
  messageId: string,
  expectedSha256: string,
  withText = false,
): Promise<ResolvedSnapshot | null> {
  const current = await ports.current(orgId, messageId);
  if (!current || erased(current)) return null;
  const matches = current.bodySha256 === expectedSha256;
  const stored = matches ? current : await ports.revisionBySha(orgId, messageId, expectedSha256);
  if (!stored || erased(stored)) return null;
  if (!withText || !matches)
    return { text: null, sourceState: matches ? "current" : "edited_since" };
  const plaintext = await ports.open(orgId, stored.bodyCipher);
  if (messageBodySha256(plaintext) !== expectedSha256) return null;
  return {
    text: storedBodyToPlainText(stored.bodyKind, plaintext),
    sourceState: "current",
  };
}

export function createDbPromotionBodyPorts(
  db: DbClient,
  opener: PromotionBodyOpener,
): PromotionBodyPorts {
  return {
    current: (orgId, messageId) =>
      withOrgContext(db, systemOrgContext(orgId), async (tx) => {
        const [row] = await tx
          .select({
            bodyCipher: MSG.bodyCipher,
            bodyKind: MSG.bodyKind,
            bodySha256: MSG.bodySha256,
            status: MSG.status,
          })
          .from(MSG)
          .where(and(eq(MSG.organizationId, orgId), eq(MSG.id, messageId)))
          .limit(1);
        if (!row || row.status === "deleted") return null;
        return { bodyCipher: row.bodyCipher, bodyKind: row.bodyKind, bodySha256: row.bodySha256 };
      }),
    revisionBySha: (orgId, messageId, sha256) =>
      withOrgContext(db, systemOrgContext(orgId), async (tx) => {
        const [row] = await tx
          .select({
            bodyCipher: REV.bodyCipher,
            bodyKind: REV.bodyKind,
            bodySha256: REV.bodySha256,
          })
          .from(REV)
          .where(
            and(
              eq(REV.organizationId, orgId),
              eq(REV.messageId, messageId),
              eq(REV.bodySha256, sha256),
            ),
          )
          .orderBy(desc(REV.revisionNo))
          .limit(1);
        return row ?? null;
      }),
    open: (orgId, cipher) => opener.open(orgId, cipher),
  };
}
