// M25 — the three-strategy auto-match algorithm (D3). PURE. Given a remittance line's match keys and a
// set of candidate M23 claims (resolved via the M23 ClaimReader at the service layer), pick the source
// claim by deterministic precedence:
//   1. payer ICN exact         (CLP07 vs claim.payer_icn) — the strongest key → confidence 100, auto
//   2. patient-control exact    (CLP01 vs claim.claim_control_number) → confidence 100, auto
//   3. heuristic                (patient member id + service-date overlap + total charge within $1)
//                               → a proposal that ALWAYS routes to the manual-match worklist (D3: a
//                               heuristic match below 100% confidence is never auto-bound)
import type { MatchStrategy } from "./types";

/** $1 tolerance band for the heuristic total-charge comparison (D3). */
export const HEURISTIC_CHARGE_TOLERANCE = 1;

/** The line's auto-match keys (mapped from the parsed CLP segment at the service layer). */
export interface MatchLineKeys {
  clp01PatientControlNumber?: string;
  clp07PayerIcn?: string;
  patientMemberId?: string;
  serviceFrom?: string; // ISO date
  serviceTo?: string; // ISO date
  totalCharge: number;
}

/** A candidate claim to match against (a projection of the M23 claim). */
export interface MatchCandidate {
  claimId: string;
  payerIcn?: string;
  claimControlNumber?: string;
  patientMemberId?: string;
  serviceFrom?: string; // ISO date
  serviceTo?: string; // ISO date
  totalCharge?: number;
}

export interface MatchResult {
  matched: boolean;
  claimId?: string;
  strategy?: MatchStrategy;
  /** 0–100. */
  confidence?: number;
  /** True when the line must go to the manual-match worklist (no candidate, ambiguity, or a heuristic hit). */
  requiresManual: boolean;
}

const UNMATCHED: MatchResult = { matched: false, requiresManual: true };

/** Inclusive service-date-range overlap between a line and a candidate (true if either side lacks dates). */
function datesOverlap(line: MatchLineKeys, c: MatchCandidate): boolean {
  if (!line.serviceFrom || !line.serviceTo || !c.serviceFrom || !c.serviceTo) return false;
  return line.serviceFrom <= c.serviceTo && c.serviceFrom <= line.serviceTo;
}

/** Run the three strategies in precedence order. */
export function autoMatch(line: MatchLineKeys, candidates: readonly MatchCandidate[]): MatchResult {
  // Strategy 1 — payer ICN exact.
  if (line.clp07PayerIcn) {
    const hits = candidates.filter((c) => c.payerIcn && c.payerIcn === line.clp07PayerIcn);
    if (hits.length === 1) {
      return { matched: true, claimId: hits[0]!.claimId, strategy: "payer_icn", confidence: 100, requiresManual: false };
    }
    if (hits.length > 1) return UNMATCHED; // ambiguous — never auto-bind
  }

  // Strategy 2 — patient control number exact.
  if (line.clp01PatientControlNumber) {
    const hits = candidates.filter(
      (c) => c.claimControlNumber && c.claimControlNumber === line.clp01PatientControlNumber,
    );
    if (hits.length === 1) {
      return { matched: true, claimId: hits[0]!.claimId, strategy: "patient_control", confidence: 100, requiresManual: false };
    }
    if (hits.length > 1) return UNMATCHED;
  }

  // Strategy 3 — heuristic (member id + date overlap + charge within $1). Always a manual proposal.
  if (line.patientMemberId) {
    const hits = candidates.filter(
      (c) =>
        c.patientMemberId === line.patientMemberId &&
        datesOverlap(line, c) &&
        c.totalCharge !== undefined &&
        Math.abs(c.totalCharge - line.totalCharge) <= HEURISTIC_CHARGE_TOLERANCE,
    );
    if (hits.length === 1) {
      return { matched: true, claimId: hits[0]!.claimId, strategy: "heuristic", confidence: 80, requiresManual: true };
    }
  }

  return UNMATCHED;
}
