import { useApiClient } from "@wardenx/ui";
import { useCallback, useRef, useState } from "react";
import type { FormEvent, MutableRefObject } from "react";
import { apiErrorCode, toSentAttachments } from "./attachment-utils";
import type { Message, MessageAttachment, MessageReferenceInput } from "./messaging-types";
import { apiErrorMessage, rotateIdempotencyKey, sendAttemptFor } from "./messaging-utils";
import type { SendAttempt } from "./messaging-utils";
import type { AttachmentUploads } from "./use-attachment-upload";

const SEND_FAILED_MESSAGE = "Message could not be sent. Your draft has been preserved.";
const ATTACHMENT_NOT_BINDABLE_MESSAGE =
  "One or more files can no longer be attached. Remove them and attach again. Your draft has been preserved.";

function referenceInput(reference: MessageReferenceInput) {
  return {
    kind: reference.kind,
    entityId: reference.entityId,
    start: reference.start,
    end: reference.end,
  };
}

/** What the thread needs to show the message it just sent. */
export interface SentMessage {
  readonly messageId: string;
  readonly createdAt: string;
  readonly body: string;
  readonly references: readonly MessageReferenceInput[];
  readonly attachments: MessageAttachment[];
}

interface UseMessageSenderInput {
  channelId: string;
  archived: boolean;
  draft: string;
  draftReferences: readonly MessageReferenceInput[];
  uploads: AttachmentUploads;
  /** The thread's generation: bumped on channel switch and unmount, so a late reply is dropped. */
  generationRef: MutableRefObject<number>;
  onSent: (sent: SentMessage) => void;
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
  archived,
  draft,
  draftReferences,
  uploads,
  generationRef,
  onSent,
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
    if (!submitted.trim() || sending || sendInFlightRef.current || archived) return;
    if (uploads.blocksSend) return;
    const references = draftReferences
      .filter((reference) => reference.end <= submitted.length)
      .map(referenceInput);
    // WP 1.2: one stable id pair per composed message, reused on retry (see sendAttemptFor).
    const attachmentIds = uploads.sendableIds;
    const sentAttachments = toSentAttachments(uploads.chips);
    const attempt = sendAttemptFor(
      sendAttemptRef.current,
      JSON.stringify([channelId, submitted, references, attachmentIds]),
    );
    sendAttemptRef.current = attempt;
    // Take the latch only after the attempt exists: sendAttemptFor can throw (crypto.randomUUID).
    sendInFlightRef.current = true;
    const generation = generationRef.current;
    setSending(true);
    setSendError(null);
    const postMessage = () =>
      client.POST("/api/v1/messaging/channels/{id}/messages", {
        params: {
          path: { id: channelId },
          header: { "Idempotency-Key": attempt.idempotencyKey },
        },
        body: {
          body: submitted,
          references,
          clientMessageId: attempt.clientMessageId,
          ...(attachmentIds.length > 0
            ? { attachments: attachmentIds.map((attachmentId) => ({ attachmentId })) }
            : {}),
        },
      });
    let result: Awaited<ReturnType<typeof postMessage>>;
    try {
      result = await postMessage();
    } catch {
      // Network failure / aborted fetch: no response arrived, so keep the attempt for the retry.
      if (generation !== generationRef.current) return;
      sendInFlightRef.current = false;
      setSending(false);
      setSendError(SEND_FAILED_MESSAGE);
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
      return;
    }
    sendAttemptRef.current = null;
    uploads.reset();
    onSent({
      messageId: data.messageId,
      createdAt: data.createdAt,
      body: submitted,
      references: draftReferences,
      attachments: sentAttachments,
    });
  }

  return { send, sending, sendError, clearSendError, resetSender };
}

/** The optimistic row for a message the server just accepted. */
export function sentMessageRow(
  sent: SentMessage,
  channelId: string,
  meId: string,
  meDisplayName: string,
): Message {
  return {
    messageId: sent.messageId,
    channelId,
    authorUserId: meId,
    authorDisplayName: meDisplayName,
    body: sent.body,
    bodyKind: "plain",
    createdAt: sent.createdAt,
    parentMessageId: null,
    references: sent.references.map((reference) => ({ ...reference, navigable: true })),
    attachments: sent.attachments,
  };
}
