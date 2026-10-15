// M36 WP 4.1 - the urgency model (ADR-0068). A message is `routine` unless it was raised through the "Urgent clinical"
// entry, which needs a patient care-team channel, an SBAR body and one named qualified recipient. Urgency is a column
// set by that one entry; it is never inferred from message text or from the SBAR form's urgency label, and nothing here
// pages, escalates or acknowledges anyone (the acknowledgment request is WP 4.2, routing is WP 4.3).

/** Ops flag (default off, absent = off). The entry also needs `messaging.sbar` (SBAR is mandatory). */
export const URGENT_CLINICAL_FLAG_KEY = "messaging.urgent_clinical";

/** Permission to raise an urgent clinical message / to be named as its recipient (migration 1105; M3 catalog). */
export const URGENT_SEND_PERMISSION = "messaging.urgent.send";
export const URGENT_RECEIVE_PERMISSION = "messaging.urgent.receive";

/** The `message.urgency` enum. `important` has no writer in WP 4.1 (its deadline policy arrives with WP 4.2). */
export const MESSAGE_URGENCIES = ["routine", "important", "urgent"] as const;
export type MessageUrgency = (typeof MESSAGE_URGENCIES)[number];

/** Recipients offered in the chooser. */
export const URGENT_RECIPIENT_CAP = 30;

export const URGENT_ERROR_CODES = [
  "URGENT_NOT_PATIENT_CHANNEL",
  "URGENT_SBAR_REQUIRED",
  "URGENT_RECIPIENT_INVALID",
  "URGENT_MESSAGE_NOT_EDITABLE",
] as const;
export type UrgentErrorCode = (typeof URGENT_ERROR_CODES)[number];

export interface UrgentMessageRequest {
  /** The sanitised SBAR document (a rich body with an sbar block); the server validates it like any SBAR send. */
  readonly body_doc: unknown;
  readonly recipient_user_id: string;
  readonly client_message_id: string;
}

export interface UrgentMessageResponse {
  readonly message_id: string;
  readonly channel_id: string;
  readonly patient_id: string;
  readonly recipient_user_id: string;
  /** True when this call wrote the message; false on an idempotent replay. */
  readonly created: boolean;
}

export interface UrgentRecipient {
  readonly user_id: string;
  readonly display_name: string | null;
}

export type UrgentMessageOptions =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly patient_linked: boolean;
      readonly patient_id: string | null;
      readonly recipients: readonly UrgentRecipient[];
    };
