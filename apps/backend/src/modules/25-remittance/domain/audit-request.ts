// M25 milestone 7a-1 - the AUDIT REQUEST aggregate (a RAC / UPIC / SMRC / other request for records). PURE.
//
// Its own aggregate, not an ADR: a different issuer, often multi-claim, with follow-ons (findings, overpayment
// demand, rebuttal) that are unverified SME items. The authority kind is a LABEL only: it names a real contractor
// type but implies no window, channel or procedure, and nothing here encodes any. The due date is not a column of
// the request: it lives in `recorded_deadline`, typed from the request letter. A request with no recorded deadline
// reads `no_deadline_recorded` (never a default) and raises one alert after AUDIT_NO_DEADLINE_ALERT_DAYS.
import { isRealDay } from "./recorded-deadline";

export const AUDIT_AUTHORITY_KINDS = ["rac", "upic", "smrc", "other"] as const;
export type AuditAuthorityKind = (typeof AUDIT_AUTHORITY_KINDS)[number];

export type AuditState =
  | "received"
  | "in_assembly"
  | "in_review"
  | "responded"
  | "withdrawn"
  | "closed";

export const AUDIT_STATES: readonly AuditState[] = [
  "received",
  "in_assembly",
  "in_review",
  "responded",
  "withdrawn",
  "closed",
];

export const AUDIT_TRANSITIONS: Readonly<Record<AuditState, readonly AuditState[]>> = {
  received: ["in_assembly", "withdrawn"],
  in_assembly: ["in_review", "withdrawn"],
  in_review: ["responded", "withdrawn"],
  responded: ["closed", "withdrawn"],
  withdrawn: [],
  closed: [],
};

/** Days after intake with no recorded deadline before the one `audit.no_deadline_recorded` alert (product-confirm). */
export const AUDIT_NO_DEADLINE_ALERT_DAYS = 2;

export type AuditCreateRefusal =
  | "AUTHORITY_KIND_INVALID"
  | "AUTHORITY_NAME_REQUIRED"
  | "DATE_INVALID"
  | "RECEIVED_IN_FUTURE"
  | "DATED_AFTER_RECEIVED";

export function canTransitionAudit(from: AuditState, to: AuditState): boolean {
  return AUDIT_TRANSITIONS[from].includes(to);
}

export function isAuditTerminal(state: AuditState): boolean {
  return AUDIT_TRANSITIONS[state].length === 0;
}

export function checkAuditCreate(input: {
  readonly authorityKind: string;
  readonly authorityName: string;
  readonly requestDatedOn: string | null;
  readonly receivedOn: string;
  /** Today's date (YYYY-MM-DD) in the caller's frame. */
  readonly today: string;
}): AuditCreateRefusal | null {
  if (!(AUDIT_AUTHORITY_KINDS as readonly string[]).includes(input.authorityKind)) {
    return "AUTHORITY_KIND_INVALID";
  }
  if (input.authorityKind === "other" && input.authorityName.trim() === "") {
    return "AUTHORITY_NAME_REQUIRED";
  }
  if (!isRealDay(input.receivedOn)) return "DATE_INVALID";
  if (input.requestDatedOn !== null && !isRealDay(input.requestDatedOn)) return "DATE_INVALID";
  if (input.receivedOn > input.today) return "RECEIVED_IN_FUTURE";
  if (input.requestDatedOn !== null && input.requestDatedOn > input.receivedOn) {
    return "DATED_AFTER_RECEIVED";
  }
  return null;
}

export type AuditDueState = "no_deadline_recorded" | "open" | "past" | "not_applicable";

/** Derived on read from the earliest open recorded deadline (null = none). A finished request has no due state. */
export function auditDueState(input: {
  readonly state: AuditState;
  readonly nextDueAt: Date | null;
  readonly now: Date;
}): AuditDueState {
  if (isAuditTerminal(input.state)) return "not_applicable";
  if (input.nextDueAt === null) return "no_deadline_recorded";
  return input.now.getTime() > input.nextDueAt.getTime() ? "past" : "open";
}

const MS_PER_DAY = 86_400_000;

export function shouldAlertNoDeadline(
  row: {
    readonly state: string;
    readonly createdAt: Date;
    readonly hasDeadline: boolean;
    readonly alreadyAlerted: boolean;
  },
  now: Date,
): boolean {
  if (row.hasDeadline || row.alreadyAlerted) return false;
  if (isAuditTerminal(row.state as AuditState)) return false;
  return now.getTime() - row.createdAt.getTime() >= AUDIT_NO_DEADLINE_ALERT_DAYS * MS_PER_DAY;
}
