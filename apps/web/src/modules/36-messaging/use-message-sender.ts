import { type RichBody, richBodyMentions, richBodyToPlainText } from "@wardenx/types";
import { useApiClient } from "@wardenx/ui";
import { useCallback, useRef, useState } from "react";
import type { FormEvent, MutableRefObject } from "react";
import { apiErrorCode, toSentAttachments } from "./attachment-utils";
import { draftToRichBody } from "./draft-to-rich-body";
import { type SendBody, buildSendBody, referenceInput } from "./message-send-body";
import type { Message, MessageAttachment, MessageReferenceInput } from "./messaging-types";
import { apiErrorMessage, rotateIdempotencyKey, sendAttemptFor } from "./messaging-utils";
import type { SendAttempt } from "./messaging-utils";
import type { AttachmentUploads } from "./use-attachment-upload";

const SEND_FAILED_MESSAGE = "Message could not be sent. Your draft has been preserved.";
const ATTACHMENT_NOT_BINDABLE_MESSAGE =
  "One or more files can no longer be attached. Remove them and attach again. Your draft has been preserved.";

/** What the thread needs to show the message it just sent. */
export interface SentMessage {
  readonly messageId: string;
  readonly createdAt: string;
  readonly body: string;
  /** WP 2.1: the structured body that was sent, when the draft had formatting. */
  readonly bodyDoc?: RichBody;
  readonly references: readonly MessageReferenceInput[];
  readonly attachments: MessageAttachment[];
}

/** A channel message that got no response, handed to the owner's outbox. `sent.messageId` is the clientMessageId until the server confirms. */
export interface QueuedSend {
  readonly body: SendBody;
  readonly idempotencyKey: string;
  readonly sent: SentMessage;
}

interface UseMessageSenderInput {
  channelId: string;
  /** WP 2.2: the root this message replies to (the thread panel's composer); absent for a channel message. */
  parentMessageId?: string;
  archived: boolean;
  draft: string;
  draftReferences: readonly MessageReferenceInput[];
  uploads: AttachmentUploads;
  /** The thread's generation: bumped on channel switch and unmount, so a late reply is dropped. */
  generationRef: MutableRefObject<number>;
  onSent: (sent: SentMessage) => void;
  /** The request has been issued with `submitted` (the owner can move the text into its in-flight record). */
  onIssued?: (submitted: string) => void;
  /** The request is over, whatever its outcome (after `onSent` on success), even if the composer has since unmounted. */
  onSettled?: (ok: boolean, submitted: string) => void;
  /** Channel composer only: a send with no attachments that got no response becomes an outbox item instead of an error. */
  onQueued?: (queued: QueuedSend) => void;
}

/**
 * The send composer's rules, in one place:
 * - one stable clientMessageId + header Idempotency-Key per composed message (sendAttemptFor), reused on a retry;
 * - the key is reused only when no reply arrived (lost reply) and rotated after any answered status >= 400,
 *   because the idempotency store caches answered failures;
 * - the in-flight latch is taken only after sendAttemptFor (it can throw) and cleared on every exit, a thrown
 *   fetch included;
 * - a reply that lands after a channel switch or unmount (generation moved) is ignored.
 */
export function useMessageSender({
  channelId,
  parentMessageId,
  archived,
  draft,
  draftReferences,
  uploads,
  generationRef,
  onSent,
  onIssued,
  onSettled,
  onQueued,
}: UseMessageSenderInput) {
  const client = useApiClient();
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const sendAttemptRef = useRef<SendAttempt | null>(null);
  const sendInFlightRef = useRef(false);

  /** Channel switch: forget the attempt, the latch and any shown error. */
  const resetSender = useCallback(() => {
    sendAttemptRef.current = null;
    sendInFlightRef.current = false;
    setSending(false);
    setSendError(null);
  }, []);

  const clearSendError = useCallback(() => setSendError(null), []);

  async function send(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    const submitted = draft;
    // WP 1.5: text OR at least one sendable file (a still-scanning one counts, as before).
    if (!submitted.trim() && uploads.sendableIds.length === 0) return;
    if (sending || sendInFlightRef.current || archived) return;
    if (uploads.blocksSend) return;
    const references = draftReferences
      .filter((reference) => reference.end <= submitted.length)
      .map(referenceInput);
    const richBody = draftToRichBody(submitted, draftReferences);
    // WP 1.2: one stable id pair per composed message, reused on retry (see sendAttemptFor).
    const attachmentIds = uploads.sendableIds;
    const sentAttachments = toSentAttachments(uploads.chips);
    const attempt = sendAttemptFor(
      sendAttemptRef.current,
      JSON.stringify([channelId, parentMessageId ?? null, submitted, references, attachmentIds]),
    );
    sendAttemptRef.current = attempt;
    // Take the latch only after the attempt exists: sendAttemptFor can throw (crypto.randomUUID).
    sendInFlightRef.current = true;
    const generation = generationRef.current;
    setSending(true);
    setSendError(null);
    onIssued?.(submitted);
    const requestBody = buildSendBody({
      submitted,
      references,
      richBody,
      clientMessageId: attempt.clientMessageId,
      parentMessageId,
      attachmentIds,
    });
    const postMessage = () =>
      client.POST("/api/v1/messaging/channels/{id}/messages", {
        params: {
          path: { id: channelId },
          header: { "Idempotency-Key": attempt.idempotencyKey },
        },
        body: requestBody,
      });
    let result: Awaited<ReturnType<typeof postMessage>>;
    try {
      result = await postMessage();
    } catch {
      // Network failure / aborted fetch: no response arrived, so keep the attempt for the retry.
      if (generation !== generationRef.current) return;
      sendInFlightRef.current = false;
      setSending(false);
      // Offline outbox: a plain channel message goes to the owner's "Not sent" list instead of an error. The attempt is
      // handed over (the next message mints fresh ids); files stay on the old preserved-draft path.
      if (onQueued && attachmentIds.length === 0) {
        sendAttemptRef.current = null;
        onQueued({
          body: requestBody,
          idempotencyKey: attempt.idempotencyKey,
          sent: {
            messageId: attempt.clientMessageId,
            createdAt: new Date().toISOString(),
            body: submitted,
            ...(richBody ? { bodyDoc: richBody } : {}),
            references: draftReferences,
            attachments: [],
          },
        });
        return;
      }
      setSendError(SEND_FAILED_MESSAGE);
      onSettled?.(false, submitted);
      return;
    }
    const { data, error, response } = result;
    if (generation !== generationRef.current) return;
    sendInFlightRef.current = false;
    setSending(false);
    // The idempotency store caches every answered response, errors included, so a retry under the
    // same key would replay the failure. Keep the key only when no response arrived (lost reply).
    if (response && response.status >= 400) sendAttemptRef.current = rotateIdempotencyKey(attempt);
    if (error || !data) {
      const notBindable = apiErrorCode(error) === "ATTACHMENT_NOT_BINDABLE";
      setSendError(
        notBindable ? ATTACHMENT_NOT_BINDABLE_MESSAGE : apiErrorMessage(error, SEND_FAILED_MESSAGE),
      );
      // Flag which chips went bad (blocked, gone) so the user knows what to remove; the others stay.
      if (notBindable) void uploads.recheck();
      onSettled?.(false, submitted);
      return;
    }
    sendAttemptRef.current = null;
    uploads.reset();
    onSent({
      messageId: data.messageId,
      createdAt: data.createdAt,
      body: submitted,
      ...(richBody ? { bodyDoc: richBody } : {}),
      references: draftReferences,
      attachments: sentAttachments,
    });
    onSettled?.(true, submitted);
  }

  return { send, sending, sendError, clearSendError, resetSender };
}

/** The optimistic row for a message the server just accepted. */
export function sentMessageRow(
  sent: SentMessage,
  channelId: string,
  meId: string,
  meDisplayName: string,
  parentMessageId: string | null = null,
): Message {
  // A structured send shows what the server will return: the projection as `body`, mentions at projection offsets.
  const rich = sent.bodyDoc;
  const references: readonly MessageReferenceInput[] = rich
    ? richBodyMentions(rich).map(({ kind, entityId, label, start, end }) => ({
        kind,
        entityId,
        start,
        end,
        displayLabel: label,
      }))
    : sent.references;
  return {
    messageId: sent.messageId,
    channelId,
    authorUserId: meId,
    authorDisplayName: meDisplayName,
    body: rich ? richBodyToPlainText(rich) : sent.body.trim() ? sent.body : "",
    bodyKind: rich ? "rich" : "plain",
    ...(rich ? { bodyDoc: rich } : {}),
    createdAt: sent.createdAt,
    parentMessageId,
    references: references.map((reference) => ({ ...reference, navigable: true })),
    attachments: sent.attachments,
  };
}
