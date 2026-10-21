import type { RichBody } from "@chartwarden/types";
import type { MessageReferenceInput } from "./messaging-types";

export function referenceInput(reference: MessageReferenceInput) {
  return {
    kind: reference.kind,
    entityId: reference.entityId,
    start: reference.start,
    end: reference.end,
  };
}

interface SendBodyInput {
  readonly submitted: string;
  readonly references: ReturnType<typeof referenceInput>[];
  readonly richBody: RichBody | null;
  readonly clientMessageId: string;
  readonly parentMessageId?: string;
  readonly attachmentIds: readonly string[];
}

/**
 * The exact JSON body of POST /channels/{id}/messages, built once so the first send and every outbox retry are identical.
 * A formatted draft goes out as a structured body (its mentions are nodes); an unformatted one stays plain text with
 * offset references. An attachment-only message omits the text; the server stores an empty body.
 */
export function buildSendBody({
  submitted,
  references,
  richBody,
  clientMessageId,
  parentMessageId,
  attachmentIds,
}: SendBodyInput) {
  return {
    ...(richBody
      ? {
          bodyDoc: {
            schemaVersion: richBody.schemaVersion,
            doc: { type: "doc" as const, content: [...richBody.doc.content] },
          },
        }
      : { ...(submitted.trim() ? { body: submitted } : {}), references }),
    clientMessageId,
    ...(parentMessageId ? { parentMessageId } : {}),
    ...(attachmentIds.length > 0
      ? { attachments: attachmentIds.map((attachmentId) => ({ attachmentId })) }
      : {}),
  };
}

export type SendBody = ReturnType<typeof buildSendBody>;
