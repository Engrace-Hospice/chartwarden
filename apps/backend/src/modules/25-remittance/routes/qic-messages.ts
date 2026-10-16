// apps/backend/src/modules/25-remittance/routes/qic-messages.ts - M25 milestone 4: the words a refusal from the pure
// QIC rules (domain/qic.ts) carries to the person. Shared by the submit guard and the QIC service, so a refusal reads
// the same wherever it fires. Reason codes become the typed error's `code`; the message is shown verbatim in the UI.
import type {
  QicEscalationFilingRefusal,
  QicEscalationRefusal,
  QicEvidenceRefusal,
  QicExtensionRefusal,
} from "../domain";

export const QIC_EVIDENCE_MESSAGES: Readonly<Record<QicEvidenceRefusal, string>> = {
  NOTICE_COPY_REQUIRED:
    "enclose a copy of the redetermination notice, and name it as the notice copy, before submitting",
  EVIDENCE_LIST_CONFLICT:
    "the list names documentation but also says the notice named none; keep one or the other",
  EVIDENCE_LIST_REQUIRED:
    "list the documentation the redetermination notice named as missing, or state that it named none",
  EVIDENCE_LABEL_REQUIRED: "every item the notice named needs a label",
  EVIDENCE_NOT_ENCLOSED:
    "an item names a document that is not among the attached documents; attach it or remove it from the item",
  EVIDENCE_REASON_REQUIRED:
    "an item with no enclosed document needs a reason of at least 10 characters saying why it is not available",
  PRECLUSION_ACK_REQUIRED:
    "acknowledge that evidence left out of this request may be excluded at later levels of appeal",
};

export const QIC_EXTENSION_MESSAGES: Readonly<Record<QicExtensionRefusal, string>> = {
  EXTENSION_OUT_OF_RANGE: "a late-evidence extension is a whole number of days from 0 to 14",
};

export const QIC_ESCALATION_MESSAGES: Readonly<Record<QicEscalationRefusal, string>> = {
  NOT_RECONSIDERATION: "only a QIC reconsideration can be escalated to OMHA",
  NOT_UNDER_REVIEW: "only a reconsideration the QIC is reviewing can be escalated",
  QIC_RECEIPT_NOT_RECORDED:
    "record the date the QIC received the request first; without it the QIC's decision date is not known",
  QIC_NOT_YET_DUE: "the QIC's decision date has not passed yet, so escalation is not available",
  ALREADY_REQUESTED: "an escalation request is already recorded for this reconsideration",
};

export const QIC_ESCALATION_FILING_MESSAGES: Readonly<Record<QicEscalationFilingRefusal, string>> =
  {
    CHANNEL_INVALID: "the escalation channel must be qic_portal, fax, mail or other",
    PROOF_REQUIRED: "the confirmation or tracking reference for the escalation request is required",
    REQUESTED_IN_FUTURE: "the escalation request time cannot be in the future",
    REQUESTED_BEFORE_DUE:
      "the escalation request cannot pre-date the QIC's decision date; record when it was actually sent",
  };
