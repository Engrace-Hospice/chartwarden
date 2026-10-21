// @wardenx/messaging - the pure write-time rules of an urgent clinical message (M36 WP 4.1, ADR-0068), shared by the Drizzle
// core and the in-memory twin so both refuse the same things. Structural only: who is QUALIFIED to receive is decided by the
// service's eligibility ports before the write, never by reading message text. Never echoes message content, and the
// recipient refusal names no reason (one answer for "not a member", "is the author" and "not qualified").
import { type RichBody, type UrgentErrorCode, ChartWardenError } from "@wardenx/types";
import { isSbarBody } from "../sbar/sbar-write";

const refuse = (code: UrgentErrorCode, message: string): ChartWardenError =>
  new ChartWardenError(code, message, 422);

export const urgentNotPatientChannel = (): ChartWardenError =>
  refuse("URGENT_NOT_PATIENT_CHANNEL", "An urgent clinical message needs a patient conversation.");
export const urgentSbarRequired = (): ChartWardenError =>
  refuse("URGENT_SBAR_REQUIRED", "An urgent clinical message needs an SBAR message.");
export const urgentRecipientInvalid = (): ChartWardenError =>
  refuse("URGENT_RECIPIENT_INVALID", "Choose a colleague who can take this message.");
export const urgentNotEditable = (): ChartWardenError =>
  refuse(
    "URGENT_MESSAGE_NOT_EDITABLE",
    "An urgent clinical message cannot be edited; send a new message instead.",
  );

export interface UrgentSendFacts {
  readonly channelKind: string;
  readonly richBody: RichBody | undefined;
  readonly authorUserId: string;
  readonly recipientUserId: string;
  /** The recipient is an ACTIVE member of this channel (the core's own membership read). */
  readonly recipientIsActiveMember: boolean;
}

/** Throws the first broken rule. Patient link, then SBAR, then recipient. */
export function assertUrgentSend(facts: UrgentSendFacts): void {
  if (facts.channelKind !== "care_team") throw urgentNotPatientChannel();
  if (!isSbarBody(facts.richBody)) throw urgentSbarRequired();
  if (facts.recipientUserId === facts.authorUserId || !facts.recipientIsActiveMember) {
    throw urgentRecipientInvalid();
  }
}

/** An urgent message is final once sent (decided 2026-10-11): any edit is refused. */
export function assertUrgencyEditable(urgency: string): void {
  if (urgency === "urgent") throw urgentNotEditable();
}
