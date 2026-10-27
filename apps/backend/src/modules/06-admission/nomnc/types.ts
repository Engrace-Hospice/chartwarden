// apps/backend/src/modules/06-admission/nomnc/types.ts — the write inputs of the NOMNC / expedited-review service
// (milestone 10a). Typed times are a local date AND a time of day, both as the person entered them (no default).
import type {
  AcknowledgementKind,
  DeadlineKind,
  DecisionOutcome,
  RecipientKind,
  RequestedByKind,
} from "./domain";

/** A typed local date + time as the person entered them (no default for either). */
export interface TypedMoment {
  readonly date?: string | null;
  readonly time?: string | null;
}

export interface RecordNoticeInput {
  readonly supersedesId?: string | null;
  readonly servicesEndOn: string;
  readonly delivered: TypedMoment;
  readonly recipientKind: RecipientKind;
  readonly representativeName?: string | null;
  readonly deliveryNote?: string | null;
  readonly acknowledgementKind?: AcknowledgementKind | null;
  readonly acknowledgementNote?: string | null;
  readonly documentId?: string | null;
  readonly documentVersionId?: string | null;
  readonly sourceNote: string;
}

export interface PatchNoticeInput {
  readonly ifVersion: number;
  readonly deliveryNote?: string | null;
  readonly acknowledgementKind?: AcknowledgementKind | null;
  readonly acknowledgementNote?: string | null;
  readonly documentId?: string | null;
  readonly documentVersionId?: string | null;
}

export interface OpenReviewInput {
  readonly qioName: string;
  readonly qioReference?: string | null;
  readonly qioNotified: TypedMoment;
  readonly requestedByKind: RequestedByKind;
}

export interface PatchReviewInput {
  readonly ifVersion: number;
  readonly qioReference?: string | null;
  readonly dencDelivered?: TypedMoment;
  readonly dencDocumentId?: string | null;
  readonly dencDocumentVersionId?: string | null;
  readonly recordsSent?: TypedMoment;
  readonly recordsSentNote?: string | null;
  readonly decision?: {
    readonly outcome: DecisionOutcome;
    readonly received: TypedMoment;
    readonly note?: string | null;
  };
  readonly decisionDocumentId?: string | null;
  readonly decisionDocumentVersionId?: string | null;
}

export interface AddDeadlineInput {
  readonly kind: DeadlineKind;
  readonly label?: string | null;
  readonly due: TypedMoment;
  readonly sourceNote: string;
  readonly noticeDocumentId?: string | null;
  readonly noticeDocumentVersionId?: string | null;
}

export interface PatchDeadlineInput {
  readonly ifVersion: number;
  readonly label?: string | null;
  readonly due?: TypedMoment;
  readonly sourceNote?: string;
  readonly noticeDocumentId?: string | null;
  readonly noticeDocumentVersionId?: string | null;
  /** Mark the deadline met (the server stamps the time). Irreversible: a satisfied deadline is frozen. */
  readonly satisfy?: boolean;
}
