// apps/web/src/modules/06-admission — pure helpers for the HETS hospice-period answer the benefit-period field shows
// (GET /api/v1/billing/eligibility/hospice-periods?patientId=). Everything here only decides what to SHOW: HETS
// confirmation is a WARNING, never a block — the staff member can always keep the manual checkbox flow.
//
// Medicare counts benefit periods per beneficiary across every hospice (Claims Processing Manual ch. 11 §20.1.6).
// HETS returns the CWF's elections and billed periods but no period number, so the server computes the next number
// only when the history is complete (`nextPeriodBasis: "computed"`); every other basis is explained, never guessed.
import type { RhcCarryOver } from "../../shell/rhc-carry-over";

export type HetsNextPeriodBasis =
  | "computed"
  | "election_open"
  | "election_status_uncertain"
  | "unbilled_election"
  | "history_truncated";

/** The hospice-periods read, as the field consumes it (the route's full response shape). */
export interface HetsHospicePeriodsView {
  status: "available" | "no_check_on_file" | "hets_not_configured";
  hetsConfigured: boolean;
  checkId: string | null;
  asOfServiceDate: string | null;
  outcome: string | null;
  checkedAt: string | null;
  staleAt: string | null;
  stale: boolean | null;
  synthetic: boolean;
  hospiceHistoryReturned: boolean;
  hospiceElectionOpen: boolean | null;
  hospiceHistoryTruncated: boolean | null;
  nextPeriodNumber: number | null;
  nextPeriodBasis: HetsNextPeriodBasis | null;
  lastAttempt: {
    checkId: string;
    outcome: string;
    checkedAt: string;
    reason: string | null;
  } | null;
  /** The RHC carry-over for the requested election date (absent / null when none was asked for). */
  rhcCarryOver?: RhcCarryOver | null;
}

/** What the hook resolved: nothing to ask (no patient), loading, quietly unavailable, or the answer. */
export type HetsLoad =
  | { kind: "idle" }
  | { kind: "loading" }
  /** 403 (no `billing.eligibility.read`), `hets_not_configured`, or a failed read: the manual flow, quietly. */
  | { kind: "unavailable"; reason: "forbidden" | "not_configured" | "error" }
  | { kind: "loaded"; view: HetsHospicePeriodsView };

/** What the field shows for the HETS answer. */
export interface HetsAdvice {
  /** A quiet one-line hint (no banner). */
  hint: string | null;
  /** The informational HETS line ("Medicare (HETS, checked …) indicates period N"). */
  info: string | null;
  /** "Use period N" — sets the number + `hets_confirmed` with this confirmation date. */
  usePeriod: { sequence: number; confirmedOn: string } | null;
  /** Non-blocking warnings. */
  warnings: string[];
  /** Offer "Run HETS check" / "Re-check HETS" (only when the caller holds `billing.eligibility.check`). */
  offerCheck: "run" | "recheck" | null;
  /** The answer came from the SANDBOX transport — synthetic data, label it. */
  sandbox: boolean;
}

/** Local calendar date (YYYY-MM-DD) of an ISO timestamp — the day the clinician saw, not UTC's. */
export function localDateOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const MANUAL_HINT = "Look the period up in HETS / ELGA / ELGH and tick the confirmation below.";

const NOE_REJECT_WARNING =
  "HETS shows a hospice election still open (possibly at another hospice). Medicare rejects our NOE until that election is terminated (a discharge, revocation or NOTR on that election).";

const BASIS_EXPLANATION: Record<Exclude<HetsNextPeriodBasis, "computed">, string> = {
  election_open:
    "HETS cannot give the next period: the most recent hospice election is still open, so the period it is in has not ended.",
  election_status_uncertain:
    "HETS cannot give the next period: it is unclear whether the most recent election was closed (no NOTR, or a later period not yet billed).",
  unbilled_election:
    "HETS cannot give the next period: an election on file has periods nobody has billed yet, so the count is incomplete.",
  history_truncated:
    "HETS cannot give the next period: Medicare returned only part of the hospice history (its return limit), so older periods are missing.",
};

const NO_HISTORY_EXPLANATION =
  "The HETS check on file has no hospice history section, so it cannot give the next period.";

const INACTIVE_PART_A =
  "HETS shows Medicare Part A is not active for the service date checked. Verify coverage before admitting under the Medicare hospice benefit.";

function attemptHint(view: HetsHospicePeriodsView): string | null {
  const a = view.lastAttempt;
  if (!a) return null;
  return `The latest HETS attempt (${localDateOf(a.checkedAt)}) did not return an answer${a.reason ? ` (${a.reason})` : ""}.`;
}

function manual(hint: string | null, offerCheck: HetsAdvice["offerCheck"] = null): HetsAdvice {
  return { hint, info: null, usePeriod: null, warnings: [], offerCheck, sandbox: false };
}

/**
 * Decide what the field shows for the HETS answer.
 * @param entered the period number currently in the field (NaN when blank / malformed)
 * @param canCheck the caller holds `billing.eligibility.check`
 */
export function hetsAdvice(load: HetsLoad, entered: number, canCheck: boolean): HetsAdvice {
  if (load.kind === "idle" || load.kind === "loading") return manual(null);
  if (load.kind === "unavailable") return manual(MANUAL_HINT);
  const v = load.view;
  if (v.status === "hets_not_configured") return manual(MANUAL_HINT);
  if (v.status === "no_check_on_file") {
    const hint = [
      canCheck
        ? "No HETS check is on file for this patient yet."
        : `No HETS check is on file for this patient. ${MANUAL_HINT}`,
      attemptHint(v),
    ]
      .filter(Boolean)
      .join(" ");
    return manual(hint, canCheck ? "run" : null);
  }

  // A resolved check is on file.
  const checkedOn = v.checkedAt ? localDateOf(v.checkedAt) : "";
  const warnings: string[] = [];
  const stale = v.stale === true;
  if (stale)
    warnings.push(
      `The HETS check on file (${checkedOn}) is over 30 days old. Re-check before relying on it.`,
    );
  if (v.outcome === "inactive_part_a") warnings.push(INACTIVE_PART_A);
  if (v.hospiceElectionOpen === true) warnings.push(NOE_REJECT_WARNING);

  let info: string | null = null;
  let usePeriod: HetsAdvice["usePeriod"] = null;
  let hint: string | null = attemptHint(v);
  const n = v.nextPeriodNumber;
  if (v.nextPeriodBasis === "computed" && n !== null) {
    info = `Medicare (HETS, checked ${checkedOn}) indicates period ${n}.`;
    if (!stale) usePeriod = { sequence: n, confirmedOn: checkedOn };
    if (Number.isInteger(entered) && entered >= 1 && entered !== n)
      warnings.push(
        `The period entered (${entered}) differs from Medicare's HETS answer (${n}). Keep it only if you have confirmed otherwise.`,
      );
  } else {
    const why =
      v.nextPeriodBasis === null || v.nextPeriodBasis === "computed"
        ? NO_HISTORY_EXPLANATION
        : BASIS_EXPLANATION[v.nextPeriodBasis];
    hint = [why, "Enter the period from HETS / ELGA / ELGH manually.", hint]
      .filter(Boolean)
      .join(" ");
  }
  return {
    hint,
    info,
    usePeriod,
    warnings,
    offerCheck: canCheck && stale ? "recheck" : null,
    sandbox: v.synthetic,
  };
}

/** True once a poll shows a check newer than the one on file when the check was requested. */
export function hetsAnswerChanged(
  before: HetsHospicePeriodsView | null,
  after: HetsHospicePeriodsView,
): boolean {
  const key = (v: HetsHospicePeriodsView | null) =>
    v ? `${v.checkId ?? ""}|${v.lastAttempt?.checkId ?? ""}` : "|";
  return key(before) !== key(after);
}

/**
 * Whether this user can run a HETS check from the Benefit period step: HETS must be configured and the
 * caller must hold `billing.eligibility.check`. Otherwise the period is looked up manually.
 */
export function canRunHetsCheck(load: HetsLoad, canCheck: boolean): boolean {
  if (!canCheck) return false;
  if (load.kind === "unavailable") return false;
  if (load.kind === "loaded")
    return load.view.hetsConfigured && load.view.status !== "hets_not_configured";
  return true;
}
