// apps/backend/src/modules/36-messaging/ack-requests/ack-edit-lock.ts - WP 4.2 (ADR-0056 D8): a message that has a response request
// cannot be edited - the request binds to what was sent. A correction is a NEW message. A cancelled request (its message was
// deleted) no longer blocks anything. The database trigger on `message` (migration 1106) is the backstop for this friendly check.
import { WardenXError } from "@wardenx/types";
import type { Tx } from "../messaging-write-core";
import { ackTxOver } from "./ack-store-db";

export async function assertMessageEditable(
  tx: Tx,
  orgId: string,
  messageId: string,
): Promise<void> {
  const request = await ackTxOver(tx, orgId).findByMessage(messageId, false);
  if (request && request.status !== "cancelled") {
    throw new WardenXError(
      "ACK_MESSAGE_NOT_EDITABLE",
      "A message that asks for a response cannot be edited; send a new message instead.",
      422,
    );
  }
}
