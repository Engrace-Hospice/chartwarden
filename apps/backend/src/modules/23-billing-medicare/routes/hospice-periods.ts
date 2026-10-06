// apps/backend/src/modules/23-billing-medicare/routes/hospice-periods.ts — the pure projection behind
// `GET /api/v1/billing/eligibility/hospice-periods` (the readmission screen's HETS benefit-period source).
//
// Reads the structured hospice history the `eligibility.refresh` worker stored in
// `eligibility_check.parsed_payload` (see `eligibilityParsedPayload` in jobs/m23-jobs.ts). The payload is
// opaque jsonb at the DB layer, so every field is re-validated here; anything malformed reads as "no hospice
// history returned" rather than throwing or guessing. Carries no MBI (the payload never held one).
import type { EligibilityOutcome } from "@wardenx/billing";
import type { HospicePeriodView, HospicePeriodsView, NextPeriodBasis } from "./read-service";

/** The slice of an `eligibility_check` row the projection needs (domain-cased outcome). */
export interface EligibilityCheckRowLike {
  readonly id: string;
  readonly asOfServiceDate: string;
  readonly outcome: EligibilityOutcome;
  readonly parsedPayload: unknown;
  readonly checkedAt: Date;
  readonly staleAt: Date;
}

const NEXT_BASES: readonly NextPeriodBasis[] = [
  "computed",
  "election_open",
  "election_status_uncertain",
  "unbilled_election",
  "history_truncated",
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isoDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const dateOrNull = (v: unknown): string | null => (isoDate(v) ? v : null);
const boolOrNull = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

function toPeriod(v: unknown): HospicePeriodView | null {
  if (
    !isRecord(v) ||
    (v.kind !== "election" && v.kind !== "benefit_period") ||
    !isoDate(v.startDate)
  ) {
    return null;
  }
  const code = v.revocationCode;
  return {
    kind: v.kind,
    periodNumber:
      typeof v.periodNumber === "number" && Number.isInteger(v.periodNumber)
        ? v.periodNumber
        : null,
    startDate: v.startDate,
    endDate: dateOrNull(v.endDate),
    hospiceNpi:
      typeof v.hospiceNpi === "string" && /^\d{10}$/.test(v.hospiceNpi) ? v.hospiceNpi : null,
    revocationOrDischargeDate: dateOrNull(v.revocationOrDischargeDate),
    revocationCode: code === "0" || code === "1" || code === "2" || code === "3" ? code : null,
    daysUsed: typeof v.daysUsed === "number" && Number.isInteger(v.daysUsed) ? v.daysUsed : null,
  };
}

/** Project the latest resolved check (+ the latest attempt) into the {@link HospicePeriodsView}. */
export function projectHospicePeriods(input: {
  readonly patientId: string;
  readonly hetsConfigured: boolean;
  /** The latest check with a resolved Part A outcome (`active_part_a` / `inactive_part_a`), or null. */
  readonly resolved: EligibilityCheckRowLike | null;
  /** The latest check of any outcome, or null. */
  readonly latest: EligibilityCheckRowLike | null;
  readonly now: Date;
}): HospicePeriodsView {
  const { resolved, latest } = input;
  const payload = resolved && isRecord(resolved.parsedPayload) ? resolved.parsedPayload : {};
  const rawPeriods = Array.isArray(payload.hospicePeriods) ? payload.hospicePeriods : null;
  const periods = (rawPeriods ?? [])
    .map(toPeriod)
    .filter((p): p is HospicePeriodView => p !== null);
  const basis = NEXT_BASES.find((b) => b === payload.hospiceNextPeriodBasis) ?? null;
  const next = payload.hospiceNextPeriodNumber;
  const latestPayload = latest && isRecord(latest.parsedPayload) ? latest.parsedPayload : {};
  const lastAttempt =
    latest && (!resolved || latest.id !== resolved.id)
      ? {
          checkId: latest.id,
          outcome: latest.outcome,
          checkedAt: latest.checkedAt.toISOString(),
          reason: typeof latestPayload.reason === "string" ? latestPayload.reason : null,
        }
      : null;

  return {
    status: resolved
      ? "available"
      : input.hetsConfigured
        ? "no_check_on_file"
        : "hets_not_configured",
    hetsConfigured: input.hetsConfigured,
    patientId: input.patientId,
    checkId: resolved?.id ?? null,
    asOfServiceDate: resolved?.asOfServiceDate ?? null,
    outcome: resolved?.outcome ?? null,
    checkedAt: resolved ? resolved.checkedAt.toISOString() : null,
    staleAt: resolved ? resolved.staleAt.toISOString() : null,
    stale: resolved ? resolved.staleAt.getTime() <= input.now.getTime() : null,
    synthetic: payload.transport === "sandbox",
    hospiceHistoryReturned: rawPeriods !== null,
    hospiceElectionOpen: rawPeriods !== null ? boolOrNull(payload.hospiceElectionOpen) : null,
    hospiceHistoryTruncated:
      rawPeriods !== null ? boolOrNull(payload.hospiceHistoryTruncated) : null,
    hospicePeriods: periods,
    nextPeriodNumber:
      rawPeriods !== null &&
      basis === "computed" &&
      typeof next === "number" &&
      Number.isInteger(next)
        ? next
        : null,
    nextPeriodBasis: rawPeriods !== null ? basis : null,
    lastAttempt,
  };
}
