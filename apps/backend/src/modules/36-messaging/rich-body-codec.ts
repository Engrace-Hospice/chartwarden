// M36 WP 2.1 - the server side of the structured message body: validate/sanitise on write, decode on read.
//
// The stored plaintext of a `rich` row is `canonicalRichBodyJson` of the sanitised body; it is what gets hashed
// (`body_sha256`, re-checked by messaging.hash_verify) and sealed under the tenant DEK, exactly like a plain body.
// Everything that leaves the encrypted store goes through `decodeStoredBody`, so no reader ever sees the JSON: the
// wire `body` is the plain-text projection and `bodyDoc` is a freshly re-sanitised copy.
import type { MessageBodyKind, MessageReferenceInput } from "@chartwarden/messaging";
import {
  type RichBody,
  ChartWardenError,
  canonicalRichBodyJson,
  normalizeMentionLabel,
  parseStoredRichBody,
  richBodyMentions,
  richBodyToPlainText,
  sanitizeRichBody,
} from "@chartwarden/types";

export const INVALID_RICH_BODY = "INVALID_RICH_BODY";

/**
 * Sanitise an untrusted structured body. The error names the rule that failed but never echoes the offending
 * content (reflected-XSS and PHI hygiene: an error string may be logged, shown in a toast, or sent to a tracker).
 */
export function sanitizeRichBodyOrThrow(raw: unknown): { richBody: RichBody; plainText: string } {
  const result = sanitizeRichBody(raw);
  if (!result.ok) {
    throw new ChartWardenError(INVALID_RICH_BODY, "the structured message body is not valid", 422);
  }
  return { richBody: result.value, plainText: richBodyToPlainText(result.value) };
}

/** The plaintext that is hashed and sealed, and the kind it is stored under. */
export function storedBodyFor(args: {
  body: string;
  bodyKind?: MessageBodyKind;
  richBody?: RichBody;
}): { plaintext: string; bodyKind: MessageBodyKind } {
  if (args.richBody) {
    // Re-sanitise even though the route did: this is the authority every writer (route, seam, job) passes through.
    const { richBody } = sanitizeRichBodyOrThrow(args.richBody);
    return { plaintext: canonicalRichBodyJson(richBody), bodyKind: "rich" };
  }
  if (args.bodyKind === "rich") {
    throw new ChartWardenError(INVALID_RICH_BODY, "a rich message needs a structured body", 422);
  }
  return { plaintext: args.body, bodyKind: args.bodyKind ?? "plain" };
}

/** What a reader may be shown for a stored body of any kind (legacy kinds pass through unchanged). */
export function decodeStoredBody(
  bodyKind: MessageBodyKind,
  plaintext: string,
): { body: string; bodyDoc?: RichBody; unreadable?: true } {
  if (bodyKind !== "rich") return { body: plaintext };
  const parsed = parseStoredRichBody(plaintext);
  // Unreadable (corrupt or hostile) rich body: show nothing rather than guess. hash_verify is what flags tampering.
  if (!parsed.ok) return { body: "", unreadable: true };
  return { body: richBodyToPlainText(parsed.value), bodyDoc: parsed.value };
}

/** A mention token in the text matches the directory name when both agree under NFKC with invisibles removed. */
export function sameMentionToken(tokenInText: string, displayName: string): boolean {
  return normalizeMentionLabel(tokenInText) === normalizeMentionLabel(`@${displayName}`);
}

/**
 * Route-level resolution of a send/edit body: `bodyDoc` and `body` are exclusive, and a structured body carries
 * its mentions as nodes (so a separate `references` list is refused, not reconciled). Returns undefined for a
 * legacy plain/markdown write. References are offsets into the plain-text projection, which is what
 * message_entity_reference stores and what the existing `@displayName` range check validates.
 */
export function resolveRichWrite(input: {
  body?: string;
  bodyDoc?: unknown;
  references?: readonly unknown[];
}): { richBody: RichBody; plainText: string; references: MessageReferenceInput[] } | undefined {
  if (input.bodyDoc === undefined) return undefined;
  if (input.body !== undefined || (input.references?.length ?? 0) > 0) {
    throw new ChartWardenError(
      INVALID_RICH_BODY,
      "send either body (with references) or bodyDoc, not both",
      422,
    );
  }
  const { richBody, plainText } = sanitizeRichBodyOrThrow(input.bodyDoc);
  const references = richBodyMentions(richBody).map(({ kind, entityId, start, end }) => ({
    kind,
    entityId,
    start,
    end,
  }));
  return { richBody, plainText, references };
}
