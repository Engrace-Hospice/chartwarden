// @wardenx/db — M26 Cap Management: shared pgEnum declarations (spec §3.2/§3.3). The enums live in this
// single home so the fan-out table files import them without ever redeclaring a pgEnum (check-ddl-legality
// rule 3). Filename intentionally avoids the substring "schema" (table-ownership/tenancy heuristic gotcha).
//
// CONVENTIONS (mirror @wardenx/db billing M23 / remittance M25 / cost-report M27 / quality M30 — the proven
// precedent): every DB ENUM type name is `m26_`-prefixed so it can never collide with another module's enum;
// the exported Drizzle const is camelCase `m26X`. Spec §3.2 wrote bare names (cap_period_status, …); the
// `m26_` prefix is the repo-wide anti-collision posture and supersedes the spec's bare names (convention wins).
import { pgEnum } from "drizzle-orm/pg-core";

export const m26PeriodStatus = pgEnum("m26_period_status", [
  "open",
  "active",
  "in_settlement",
  "settled",
  "reopened",
]);

export const m26Methodology = pgEnum("m26_methodology", ["streamlined", "proportional"]);

export const m26LineSourceKind = pgEnum("m26_line_source_kind", [
  "remittance",
  "adjustment",
  "reversal",
  "manual_correction",
]);

export const m26InpatientSourceKind = pgEnum("m26_inpatient_source_kind", ["claim_line"]);

export const m26ProjectionScope = pgEnum("m26_projection_scope", [
  "agency_aggregate",
  "patient_aggregate",
  "inpatient",
]);

export const m26ProjectionTrigger = pgEnum("m26_projection_trigger", [
  "nightly_batch",
  "remittance_trigger",
  "manual_recompute",
]);

export const m26AlertBand = pgEnum("m26_alert_band", [
  "safe",
  "watch_90",
  "warn_95",
  "breach_100",
  "inpatient_safe",
  "inpatient_watch_18",
  "inpatient_breach_20",
]);

export const m26SettlementStatus = pgEnum("m26_settlement_status", [
  "proposed",
  "reviewed",
  "final",
]);

export const m26PsrParseStatus = pgEnum("m26_psr_parse_status", [
  "queued",
  "parsed",
  "parse_failed",
  "reconciled",
]);

export const m26PsrReconScope = pgEnum("m26_psr_recon_scope", [
  "beneficiary",
  "agency_aggregate",
  "inpatient",
]);

export const m26PsrReconStatus = pgEnum("m26_psr_recon_status", [
  "open",
  "investigating",
  "resolved",
  "accepted",
]);

export const m26PsrVarianceReason = pgEnum("m26_psr_variance_reason", [
  "timing",
  "psr_correction",
  "our_correction",
  "mbi_mismatch",
  "data_quality",
  "unknown",
]);

export const m26MacRegion = pgEnum("m26_mac_region", [
  "ngs",
  "cgs",
  "palmetto",
  "wps",
  "noridian",
  "first_coast",
  "novitas",
]);
