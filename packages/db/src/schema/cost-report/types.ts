// @wardenx/db — M27 Cost Report: helper TS types for the module's jsonb columns (§3.3).
// These back the Drizzle `.$type<...>()` generics so the column payloads are typed (no `any`).
// Filename intentionally avoids the substring "schema" (table-ownership/tenancy heuristic gotcha).
//
// NB: the DEEP per-worksheet `data` shapes (Worksheet A/S-3/B/D/E-1/…) and the validation
// `predicate_spec` are TypeBox-typed at the service layer in `@wardenx/cost-report` (P2). At the DB
// layer the columns are typed loosely here so the schema package takes no `@wardenx/cost-report` edge.

// cost_report_worksheet.data — TypeBox-validated per worksheet_code at the service layer (P2).
export interface WorksheetData {
  [key: string]: unknown;
}

// cost_report_snapshot.materialized_inputs — every consumed-seam input captured at submit/reopen time
// (patient-days, cap-accruals, drug-costs, trial-balance, wage-data, encounter-stats, loc-periods).
// Opaque at the DB layer; the content_hash_sha256 is the change-marker. Audit-denylisted (§3.6).
export interface SnapshotMaterializedInputs {
  [key: string]: unknown;
}

// cost_report_snapshot.worksheet_snapshot — frozen copy of every worksheet `data` at snapshot time.
export interface WorksheetSnapshot {
  [worksheetCode: string]: WorksheetData;
}

// cost_report_validation_rule.predicate_spec — the typed predicate definition consumed by the
// rule-engine (P2). Opaque at the DB layer.
export interface RulePredicateSpec {
  [key: string]: unknown;
}

// cost_report_validation_result.details — remediation hints, computed values, source-data refs.
export interface ValidationResultDetails {
  reason?: string;
  seam?: string;
  remediationHint?: string;
  computedValues?: Record<string, unknown>;
  [key: string]: unknown;
}

// statistic_data.monthly_breakdown — by month × LOC × program.
export interface StatisticMonthlyCell {
  patientDays: number;
  uniqueBeneficiaries: number;
  admissions: number;
  discharges: number;
  deathsBySetting?: Record<string, number>;
}
// { [monthLabel]: { [loc]: { [program]: StatisticMonthlyCell } } }
export interface StatisticMonthlyBreakdown {
  [monthLabel: string]: {
    [loc: string]: {
      [program: string]: StatisticMonthlyCell;
    };
  };
}

// statistic_data.visit_counts_by_discipline — { [discipline]: count } (optionally per month).
export interface VisitCountsByDiscipline {
  [discipline: string]: number;
}

// statistic_data.fte_calculations — { [discipline]: fte }.
export interface FteCalculations {
  [discipline: string]: number;
}

// statistic_data.bereavement_census — { contactsCount, visitsCount, ... }.
export interface BereavementCensus {
  contactsCount: number;
  visitsCount: number;
  [key: string]: unknown;
}

// trial_balance_import.normalized_accounts — [{ glCode, glName, debitCents, creditCents, period }].
export interface NormalizedAccount {
  glCode: string;
  glName: string;
  debitCents: number;
  creditCents: number;
  period?: string;
}

// wage_data_import.normalized_wage_rows — [{ discipline, paidHours, salaryCents, fringeCents, period }].
export interface NormalizedWageRow {
  discipline: string;
  paidHours: number;
  salaryCents: number;
  fringeCents: number;
  period?: string;
}

// {trial_balance,wage_data}_import.raw_payload_cipher — envelope-encrypted JSON (per-tenant DEK).
// Audit-denylisted (§3.6); the cleartext is reachable only via in-app envelope decryption.
export interface EnvelopeCipher {
  keyId: string;
  iv: string;
  ciphertext: string;
  authTag?: string;
  [key: string]: unknown;
}
