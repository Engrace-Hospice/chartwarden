// M25 milestone 4 — QIC reconsideration rules (hospice ADR/TPE/QIC PRD). PURE. No I/O: the service reads the facts
// and these decide.
//
// What the PRD verified (cms.gov second-level appeal; 42 CFR 405.966(a)):
//   - the QIC decides within 60 days or must offer escalation to OMHA;
//   - documentation the redetermination notice named as missing must be included, and evidence not submitted before
//     the reconsideration notice is precluded at later levels absent good cause;
//   - a late evidence submission extends the QIC clock by up to 14 days each.
//
// SME-UNCONFIRMED (do not present as fact; the screen says so too):
//   - the 60 days are counted here as CALENDAR days from the QIC's RECEIPT of the request, the date the user records
//     from the QIC acknowledgement. The PRD does not verify the anchor (42 CFR 405.970 is the planner's reading) or
//     what happens when the last day is a weekend or holiday. No weekend/holiday roll is applied: any roll would
//     move the due date EARLIER, and escalation must never be offered before the QIC is actually late;
//   - the size of each extension is whatever the user enters from the QIC letter (0-14); the QIC may state a smaller
//     number than the maximum;
//   - the escalation procedure (written request? a CMS form? how long the QIC then has) is not in the PRD. Recording
//     an escalation here records a request made OUTSIDE WardenX; nothing is sent from here (milestone 6);
//   - the ALJ amount-in-controversy threshold for an escalated case is not checked here.
import { MS_PER_DAY, endOfDayInZone, isoDay, parseNoticeDay } from "./deadline";

/** The QIC's decision window, from its receipt of the request. */
export const QIC_DECISION_DAYS = 60;

/** The most one late-evidence submission can extend the QIC clock (PRD: "up to 14 days each"). */
export const QIC_LATE_EVIDENCE_EXTENSION_MAX_DAYS = 14;

/** The shortest reason that is not a placeholder when a cited item cannot be enclosed. */
export const QIC_MIN_UNAVAILABLE_REASON = 10;

/** How an escalation request left the building. Electronic sending is milestone 6. */
export const QIC_ESCALATION_CHANNELS = ["qic_portal", "fax", "mail", "other"] as const;
export type QicEscalationChannel = (typeof QIC_ESCALATION_CHANNELS)[number];

export interface QicExtension {
  /** Calendar days added to the QIC clock (0-14). */
  readonly days: number;
  /** When the extension was recorded here (ISO instant). */
  readonly recordedAt: string;
}

/** How a decision-due date was reached, shown to the user so a date is never an unexplained number. */
export interface QicClock {
  readonly receivedOn: string; // YYYY-MM-DD the QIC received the request
  readonly baseDays: number;
  readonly extensionDays: number;
  readonly decisionDueOn: string; // YYYY-MM-DD, receivedOn + baseDays + extensionDays
  readonly decisionDueAt: Date; // end of decisionDueOn in `zone`
  readonly zone: string;
}

export function deriveQicDecisionClock(input: {
  readonly receivedOn: string;
  readonly extensions: readonly QicExtension[];
  readonly zones: readonly string[];
}): QicClock {
  const receivedMs = parseNoticeDay(input.receivedOn);
  const extensionDays = input.extensions.reduce((sum, e) => sum + e.days, 0);
  const dueMs = receivedMs + (QIC_DECISION_DAYS + extensionDays) * MS_PER_DAY;
  // Several zones: the day ends LAST in the westernmost one. Filing deadlines take the earliest end (conservative
  // for filing); this clock is conservative the other way, so escalation is never offered before the QIC is late.
  const zones = input.zones.length > 0 ? input.zones : ["America/New_York"];
  const ends = zones.map((zone) => ({ zone, at: endOfDayInZone(dueMs, zone) }));
  const last = ends.reduce((a, b) => (b.at.getTime() > a.at.getTime() ? b : a));
  return {
    receivedOn: input.receivedOn,
    baseDays: QIC_DECISION_DAYS,
    extensionDays,
    decisionDueOn: isoDay(dueMs),
    decisionDueAt: last.at,
    zone: last.zone,
  };
}

export function isQicOverdue(clock: QicClock, now: Date): boolean {
  return now.getTime() > clock.decisionDueAt.getTime();
}

/** Whole days past the due instant, counting a started day as a day; 0 when not yet overdue. */
export function qicDaysOverdue(clock: QicClock, now: Date): number {
  const past = now.getTime() - clock.decisionDueAt.getTime();
  return past > 0 ? Math.ceil(past / MS_PER_DAY) : 0;
}

export type QicExtensionRefusal = "EXTENSION_OUT_OF_RANGE";

export function checkQicExtension(days: number): QicExtensionRefusal | null {
  return Number.isInteger(days) && days >= 0 && days <= QIC_LATE_EVIDENCE_EXTENSION_MAX_DAYS
    ? null
    : "EXTENSION_OUT_OF_RANGE";
}

/** One piece of documentation the redetermination notice named, as the person cites it. */
export interface QicEvidenceItem {
  readonly label: string;
  /** The M22 document enclosed for it, or null when it cannot be enclosed. */
  readonly documentId: string | null;
  /** Why it cannot be enclosed; required exactly when `documentId` is null. */
  readonly notAvailableReason: string | null;
}

export type QicEvidenceRefusal =
  | "NOTICE_COPY_REQUIRED"
  | "EVIDENCE_LIST_CONFLICT"
  | "EVIDENCE_LIST_REQUIRED"
  | "EVIDENCE_LABEL_REQUIRED"
  | "EVIDENCE_NOT_ENCLOSED"
  | "EVIDENCE_REASON_REQUIRED"
  | "PRECLUSION_ACK_REQUIRED";

/**
 * The evidence-completeness guard for a reconsideration request. Documentation the redetermination notice named as
 * missing must be enclosed, or explained with an acknowledged warning that omitted evidence may be excluded later.
 * `none` is the attestation that the notice named nothing (an empty list alone is never accepted).
 */
export function checkQicEvidence(input: {
  readonly items: readonly QicEvidenceItem[];
  readonly none: boolean;
  readonly enclosedIds: readonly string[];
  readonly preclusionAcknowledged: boolean;
  readonly redeterminationNoticeDocumentId: string | null;
}): QicEvidenceRefusal | null {
  const enclosed = new Set(input.enclosedIds);
  const notice = input.redeterminationNoticeDocumentId;
  if (notice === null || !enclosed.has(notice)) return "NOTICE_COPY_REQUIRED";
  if (input.none && input.items.length > 0) return "EVIDENCE_LIST_CONFLICT";
  if (!input.none && input.items.length === 0) return "EVIDENCE_LIST_REQUIRED";
  if (input.items.some((i) => i.label.trim() === "")) return "EVIDENCE_LABEL_REQUIRED";
  if (input.items.some((i) => i.documentId !== null && !enclosed.has(i.documentId))) {
    return "EVIDENCE_NOT_ENCLOSED";
  }
  const unenclosed = input.items.filter((i) => i.documentId === null);
  if (
    unenclosed.some((i) => (i.notAvailableReason ?? "").trim().length < QIC_MIN_UNAVAILABLE_REASON)
  ) {
    return "EVIDENCE_REASON_REQUIRED";
  }
  if (unenclosed.length > 0 && !input.preclusionAcknowledged) return "PRECLUSION_ACK_REQUIRED";
  return null;
}

export type QicEscalationRefusal =
  | "NOT_RECONSIDERATION"
  | "NOT_UNDER_REVIEW"
  | "QIC_RECEIPT_NOT_RECORDED"
  | "QIC_NOT_YET_DUE"
  | "ALREADY_REQUESTED";

/** Escalation to OMHA is offered only to an under-review reconsideration whose recorded clock has lapsed. */
export function canRequestEscalation(input: {
  readonly tier: string;
  readonly state: string;
  readonly clock: QicClock | null;
  readonly alreadyRequested: boolean;
  readonly now: Date;
}): QicEscalationRefusal | null {
  if (input.tier !== "reconsideration") return "NOT_RECONSIDERATION";
  if (input.state !== "under_review") return "NOT_UNDER_REVIEW";
  if (input.clock === null) return "QIC_RECEIPT_NOT_RECORDED";
  if (input.alreadyRequested) return "ALREADY_REQUESTED";
  return isQicOverdue(input.clock, input.now) ? null : "QIC_NOT_YET_DUE";
}

export type QicEscalationFilingRefusal =
  | "CHANNEL_INVALID"
  | "PROOF_REQUIRED"
  | "REQUESTED_IN_FUTURE"
  | "REQUESTED_BEFORE_DUE";

/** What a recorded escalation request needs: a known channel, the confirmation given, a real past time. */
export function checkEscalationFiling(input: {
  readonly channel: string;
  readonly confirmationRef: string;
  readonly requestedAt: Date;
  readonly now: Date;
  /** The QIC's decision instant: a request cannot pre-date it (and so not the receipt or the filing either). */
  readonly notBefore?: Date;
}): QicEscalationFilingRefusal | null {
  if (!(QIC_ESCALATION_CHANNELS as readonly string[]).includes(input.channel)) {
    return "CHANNEL_INVALID";
  }
  if (input.confirmationRef.trim() === "") return "PROOF_REQUIRED";
  if (input.requestedAt.getTime() > input.now.getTime()) return "REQUESTED_IN_FUTURE";
  if (input.notBefore && input.requestedAt.getTime() < input.notBefore.getTime()) {
    return "REQUESTED_BEFORE_DUE";
  }
  return null;
}

// CMS Medicare Beneficiary Identifier: 11 characters; position 1 a digit 1-9, 2 a letter, 3 a letter or digit, 4 a
// digit, 5 a letter, 6 a letter or digit, 7 a digit, 8-9 letters, 10-11 digits. S, L, O, I, B and Z are never used.
const MBI_SHAPE =
  /[1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9][0-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9][0-9][AC-HJKMNP-RT-Y]{2}[0-9]{2}/;
/** Short free-text fields (a reference, a label) get spaces removed too, so "1EG4 TE5 MK73" is caught. */
const SHORT_FIELD_MAX = 40;

/**
 * True when `text` contains something shaped like a Medicare number (MBI). M25 holds no MBI by design, so cited
 * evidence and references must not carry one into the audit-visible and packet-visible record. A false positive
 * costs the person one edit; a miss puts PHI where it does not belong.
 */
export function containsMbi(text: string): boolean {
  const upper = text.toUpperCase().replace(/-/g, "");
  if (MBI_SHAPE.test(upper)) return true;
  return upper.length <= SHORT_FIELD_MAX && MBI_SHAPE.test(upper.replace(/\s+/g, ""));
}
