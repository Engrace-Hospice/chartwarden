// WP 2.7b C2 (ADR-0058, Accepted) - the small ports the index writer depends on, so the two things that are not settled yet
// (the async key-ring body cipher of WP 2.13, and the ADR-0055 redaction marker) are one-line adapter changes later.
import { messageBodySha256 } from "@wardenx/messaging";
import type { MessageBodyKind } from "@wardenx/messaging";
import type { MessageBodyCipher } from "../messaging-write-core";
import { decodeStoredBody } from "../rich-body-codec";

export interface StoredBody {
  readonly bodyKind: string;
  readonly bodyCipher: Buffer;
}

/**
 * Opens a stored body for indexing. `text` is the PLAIN TEXT projection (a rich body is projected through
 * `decodeStoredBody`, so raw stored JSON is never tokenised); `sha256` is the digest of the raw opened plaintext, which the
 * writer compares with `message.body_sha256`. Awaitable on purpose: WP 2.13 makes the cipher async.
 */
export interface BodyReader {
  read(organizationId: string, body: StoredBody): Promise<{ text: string; sha256: string }>;
}

export function createBodyReader(cipher: Pick<MessageBodyCipher, "open">): BodyReader {
  return {
    async read(organizationId, body) {
      const plaintext = await Promise.resolve(cipher.open(organizationId, body.bodyCipher));
      return {
        text: decodeStoredBody(body.bodyKind as MessageBodyKind, plaintext).body,
        sha256: messageBodySha256(plaintext),
      };
    },
  };
}

export interface IndexableMessageRow {
  readonly id: string;
  readonly status: string;
}

/**
 * ADR-0058 decision 6/7: a redacted message, and one whose redaction is pending, is out of the index. ADR-0055 has not shipped
 * redaction and its marker is undecided, so today this is constant false; WP 5.x replaces it with the real marker read.
 */
export type IsRedactedOrPending = (row: IndexableMessageRow) => boolean;

export const neverRedacted: IsRedactedOrPending = () => false;

export function isEligibleForIndex(
  row: IndexableMessageRow,
  isRedactedOrPending: IsRedactedOrPending,
): boolean {
  return row.status !== "deleted" && !isRedactedOrPending(row);
}

export type IndexOutcome = "indexed" | "removed" | "skipped_off" | "skipped_stale";
