// apps/web/src/modules/41-billing-commercial — pure labels, tones and joins for the commercial billing screens (issue #726).
// No React, no I/O: the screens render these so each rule is testable on its own.
import type { StatusTone } from "@chartwarden/ui";
import {
  dollars,
  claimStateTone as medicareClaimStateTone,
  statusLabel,
} from "../23-billing-medicare/billing-status";

export { dollars, statusLabel };

export const COMMERCIAL_PATHS = {
  queue: "/commercial/billing/claims",
  payers: "/commercial/billing/payers",
  claim: (id: string): string => `/commercial/billing/claims/${id}`,
} as const;

/** The work-queue payer-kind filter: the other payer on the claim (coordination of benefits). */
export const PAYER_KIND_OPTIONS = [
  { value: "", label: "All payer kinds" },
  { value: "commercial_only", label: "Commercial only" },
  { value: "medicare_secondary", label: "Medicare secondary" },
  { value: "medicaid_secondary", label: "Medicaid secondary" },
] as const;

export const CLAIM_STATE_OPTIONS = [
  { value: "", label: "All states" },
  { value: "draft", label: "Draft" },
  { value: "ready", label: "Ready" },
  { value: "void", label: "Void" },
] as const;

export type PayerKindFilter = "commercial_only" | "medicare_secondary" | "medicaid_secondary";
export type ClaimStateFilter = "draft" | "ready" | "void";

/** Narrow a select value to a filter the API accepts; anything else means "no filter". */
export function asPayerKind(value: string): PayerKindFilter | undefined {
  return PAYER_KIND_OPTIONS.some((o) => o.value === value && value !== "")
    ? (value as PayerKindFilter)
    : undefined;
}
export function asClaimState(value: string): ClaimStateFilter | undefined {
  return CLAIM_STATE_OPTIONS.some((o) => o.value === value && value !== "")
    ? (value as ClaimStateFilter)
    : undefined;
}

/** The claim's payer kind as a reader sees it: the commercial primary plus the secondary program, when there is one. */
export function payerKindLabel(secondaryPayerKind: string | null): string {
  if (secondaryPayerKind === "medicare") return "Commercial + Medicare secondary";
  if (secondaryPayerKind === "medicaid") return "Commercial + Medicaid secondary";
  return "Commercial only";
}

export function claimStateTone(state: string): StatusTone {
  if (state === "void") return "neutral";
  return medicareClaimStateTone(state);
}

const FILING_INDICATOR_LABEL: Record<string, string> = {
  "11": "Other non-federal program",
  "12": "PPO",
  "13": "POS",
  "14": "EPO",
  "15": "Indemnity",
  "17": "Dental maintenance org.",
  AM: "Automobile medical",
  BL: "Blue Cross / Blue Shield",
  CH: "TRICARE",
  CI: "Commercial insurance",
  DS: "Disability",
  FI: "FEHBP",
  HM: "HMO",
  LM: "Liability medical",
  OF: "Other federal program",
  VA: "Veterans Affairs plan",
  WC: "Workers' compensation",
  ZZ: "Mutually defined",
};
export function filingIndicatorLabel(code: string): string {
  return FILING_INDICATOR_LABEL[code] ? `${code} · ${FILING_INDICATOR_LABEL[code]}` : code;
}

const AUTH_REQUIREMENT_LABEL: Record<string, string> = {
  not_required: "Not required",
  required_at_admission: "Required at admission",
  required_per_level_of_care: "Required per level of care",
  confirm_with_payer: "Confirm with payer",
};
export function authorizationRequirementLabel(requirement: string): string {
  return AUTH_REQUIREMENT_LABEL[requirement] ?? statusLabel(requirement);
}

export interface AuthorizationFact {
  readonly status: string;
  readonly levelOfCare: string | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

/**
 * One line for the claim's authorization posture. An approved authorization is evidence; a requirement with none on file is the
 * thing a biller must fix; `confirm_with_payer` is unknown, not "no" (ADR-0100).
 */
export function authorizationPosture(
  requirement: string,
  authorizations: readonly AuthorizationFact[],
): { label: string; tone: StatusTone } {
  const approved = authorizations.filter((a) => a.status === "approved");
  if (approved.length > 0) return { label: `${approved.length} approved on file`, tone: "success" };
  if (requirement === "not_required")
    return { label: "Not required by this plan", tone: "neutral" };
  if (requirement === "confirm_with_payer") {
    return { label: "Unknown: confirm with the payer", tone: "warning" };
  }
  return { label: "Required, none approved on file", tone: "error" };
}

export function levelOfCareLabel(level: string | null): string {
  return level ? statusLabel(level) : "Every level of care";
}

export interface EnrollmentFact {
  readonly payerId: string;
  readonly status: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

const ENROLLMENT_TONE: Record<string, StatusTone> = {
  enrolled: "success",
  pending: "progress",
  suspended: "warning",
  not_enrolled: "error",
};

/**
 * The enrollment that governs sending to a payer today. Only a row in effect counts; with none, the provider entity is
 * `not_enrolled`, a first-class state (nothing is sent, ADR-0100 D5), never a blank.
 */
export function enrollmentStatusFor(
  payerId: string,
  enrollments: readonly EnrollmentFact[],
  today: string,
): { status: string; label: string; tone: StatusTone } {
  const inEffect = enrollments
    .filter(
      (e) =>
        e.payerId === payerId &&
        e.effectiveFrom <= today &&
        (e.effectiveTo === null || e.effectiveTo >= today),
    )
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  const status = inEffect[0]?.status ?? "not_enrolled";
  return { status, label: statusLabel(status), tone: ENROLLMENT_TONE[status] ?? "neutral" };
}

export function payerStatusTone(status: string | null): StatusTone {
  if (status === "active") return "success";
  if (status === null) return "warning";
  return "error";
}
export function payerStatusLabel(status: string | null): string {
  return status === null ? "Payer not found" : statusLabel(status);
}

export interface ValidationResultFact {
  readonly id: string;
  readonly ruleKey: string;
  readonly severity: string;
  readonly outcome: string;
  readonly overridable: boolean;
  readonly overridden: boolean;
  readonly blocking: boolean;
  readonly message: string;
}

export function resultTone(r: ValidationResultFact): StatusTone {
  if (r.outcome === "pass") return "success";
  if (r.overridden) return "neutral";
  if (r.outcome === "info") return "progress";
  return r.blocking ? "error" : "warning";
}
export function resultLabel(r: ValidationResultFact): string {
  if (r.outcome === "pass") return "Pass";
  if (r.overridden) return "Overridden";
  if (r.outcome === "info") return "Info";
  if (r.blocking) return r.overridable ? "Soft block" : "Hard block";
  return "Warning";
}

/** The shortest label that still tells two ids apart (the full id is not a name). */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function servicePeriod(from: string, to: string): string {
  return `${from} to ${to}`;
}

/** Whole dollars, for a KPI card where cents are noise and the value must fit a narrow card. */
export function wholeDollars(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}
