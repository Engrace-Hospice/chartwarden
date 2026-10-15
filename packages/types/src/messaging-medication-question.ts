// M36 WP 3.10 - "Ask a nurse about a medication" (ADR-0067). A medication question is an ordinary secure message, an
// optional read-only medication link and a task for the patient's nurse. It is never an order: nothing here names an
// order or prescribing permission, and the question text is never read by code (it only travels in the sealed message).

import type { TaskDto } from "./messaging-task";

/** Ops flag (default off). The entry is enabled only when this AND `messaging.tasks` are on. */
export const MEDICATION_QUESTION_FLAG_KEY = "messaging.medication_questions";

/** The send route's own body cap (messaging-typebox SendMessageBodySchema), reused so this entry is never stricter or looser. */
export const MEDICATION_QUESTION_TEXT_MAX = 8000;

/** Colleagues offered in the chooser. */
export const MEDICATION_QUESTION_COLLEAGUE_CAP = 20;

export const MEDICATION_QUESTION_ERROR_CODES = [
  "MEDICATION_QUESTION_NOT_PATIENT_CHANNEL",
  "MEDICATION_QUESTION_ASSIGNEE_INVALID",
  "MEDICATION_QUESTION_NO_NURSE",
] as const;
export type MedicationQuestionErrorCode = (typeof MEDICATION_QUESTION_ERROR_CODES)[number];

/** Why a question has no assigned nurse: none could be found, or the assigned one left and nobody could take it. */
export const MEDICATION_QUESTION_UNROUTED_REASONS = ["no_nurse", "owner_left"] as const;
export type MedicationQuestionUnroutedReason =
  (typeof MEDICATION_QUESTION_UNROUTED_REASONS)[number];

export interface MedicationQuestionRequest {
  readonly text: string;
  readonly medication_id?: string;
  readonly assignee_user_id?: string;
  readonly allow_unrouted?: boolean;
  readonly client_message_id: string;
}

export interface MedicationQuestionResponse {
  readonly message_id: string;
  readonly channel_id: string;
  readonly patient_id: string;
  readonly routed: boolean;
  readonly task: TaskDto | null;
  readonly created: boolean;
}

export interface MedicationQuestionPerson {
  readonly user_id: string;
  readonly display_name: string | null;
}

export type MedicationQuestionOptions =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly patient_linked: boolean;
      readonly patient_id: string | null;
      readonly nurse: MedicationQuestionPerson | null;
      readonly colleagues: readonly MedicationQuestionPerson[];
      readonly links_enabled: boolean;
    };
