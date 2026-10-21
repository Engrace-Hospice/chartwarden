// @chartwarden/quality — M30 HQRP & Quality: canonical shared DOMAIN VALUE TYPES (§2.1, §4.2, §4.3).
//
// This file is the SINGLE SOURCE OF TRUTH for the domain value types referenced by M30's five
// published seams (./seams) and consumed by every other M30 P2a surface. Two kinds of type live here:
//
//   1. Row-backed concepts — where exactly one M30 Drizzle table backs the concept, the type is
//      DERIVED from that table's `$inferSelect` projection (exposed via the `@chartwarden/db` `schema`
//      namespace, per ADR-0005 D4: schema TYPES are universally importable even though table ACCESS
//      is ownership-gated). Deriving keeps these locked to the FROZEN schema — no drift.
//   2. Enum unions — string-literal unions whose members mirror, verbatim, the `pgEnum` value lists in
//      `packages/db/src/schema/quality/*.ts`. The schema is frozen, so these are stable contracts.
//
// P2a is PURE DOMAIN: no Fastify, no DB queries, no I/O. These are type declarations only.
import type { schema } from "@chartwarden/db";

// -----------------------------------------------------------------------------
// Enum unions (mirror the M30 pgEnum value lists, verbatim)
// -----------------------------------------------------------------------------

/**
 * Period shape over which a quality measure is computed — mirrors `m30_measure_period_kind`
 * (`quality-measure-value.ts`): a rolling-12-month-to-quarter window, a calendar quarter/year, or a
 * cap-year overlay.
 */
export type MeasurePeriodKind =
  | "rolling_12m_to_quarter"
  | "calendar_quarter"
  | "calendar_year"
  | "cap_year_overlay";

/** Safety-incident kind — mirrors `m30_incident_kind` (`incident-report.ts`; V-14). */
export type IncidentKind =
  | "fall"
  | "medication_error"
  | "complaint"
  | "allegation_of_abuse"
  | "exposure_event"
  | "other_safety_event"
  | "restraint_use";

/** Incident severity band — mirrors `m30_incident_severity` (`incident-report.ts`). */
export type IncidentSeverity = "minor" | "moderate" | "severe" | "critical";

/**
 * Incident lifecycle state — mirrors `m30_incident_lifecycle` (`incident-report.ts`, §2.2). The
 * seven-state machine `draft → submitted → triaged → under_investigation → resolved →
 * closed_followup_complete`, with `reopened` as the re-entry state.
 */
export type IncidentState =
  | "draft"
  | "submitted"
  | "triaged"
  | "under_investigation"
  | "resolved"
  | "closed_followup_complete"
  | "reopened";

/**
 * QAPI project lifecycle phase — mirrors `m30_qapi_project_status` (`qapi-project.ts`, §2.2). The
 * `corrective_action` phase is the one that lands a project on the risk register.
 */
export type QapiProjectPhase =
  | "proposed"
  | "active"
  | "corrective_action"
  | "completed"
  | "abandoned";

/** SRA cycle lifecycle status — mirrors `m30_sra_cycle_status` (`sra-cycle.ts`, §2.2). */
export type SraCycleStatus = "chartered" | "in_progress" | "review" | "closed" | "reopened";

/** CoP self-assessed compliance posture — mirrors `m30_cop_status` (`cop-compliance-status.ts`). */
export type CopStatus = "compliant" | "at_risk" | "deficient";

// -----------------------------------------------------------------------------
// Row-backed domain value types (derived from the FROZEN M30 Drizzle schema)
// -----------------------------------------------------------------------------

/**
 * A platform-shipped quality measure code (e.g. an HCI component or claims-based measure), validated
 * against the M38 `cms_quality_measure_v<FY>` value set at write time (V-1). Kept as a nominal-by-
 * convention `string` so seam callers pass measure codes without coupling to the value-set registry.
 */
export type MeasureId = string;

/**
 * The computed value of one quality measure for one provider entity over one period — the current
 * (non-superseded) `quality_measure_value` row. Aggregate-only: this row carries no patient-level PHI.
 */
export type MeasureValue = schema.QualityMeasureValue;

/** A measure-computation period, expressed as a kind plus an ISO-8601 `[start, end)` window. */
export interface MeasurePeriod {
  /** The window shape (rolling-12m, calendar quarter/year, or cap-year overlay). */
  readonly kind: MeasurePeriodKind;
  /** ISO-8601 inclusive period start. */
  readonly start: string;
  /** ISO-8601 exclusive period end (V-3: `end > start`). */
  readonly end: string;
}

/**
 * The reproducibility snapshot behind a measure value (D1 invariant): the opaque seam-input state that
 * was hashed at compute time, plus the metadata needed to reproduce the value months later. Returned
 * by `QualityMeasureProvider.getSnapshot`.
 */
export interface MeasureValueSnapshot {
  /** The `quality_measure_value.id` this snapshot reproduces. */
  readonly valueId: string;
  /** The measure code (V-1). */
  readonly measureCode: MeasureId;
  /** The 64-hex SHA-256 over `snapshot` captured at compute time (V-5). */
  readonly snapshotContentHash: string;
  /** Semver of the calculator that produced the value. */
  readonly calculatorVersion: string;
  /** ISO-8601 timestamp the value was computed. */
  readonly computedAt: string;
  /** The hashed-over seam-input state (calculator-version specific; audit-denylisted §3.6). */
  readonly snapshot: schema.MeasureComputationSnapshot;
}

/**
 * A single safety-incident record — the `incident_report` row (falls, med errors, complaints, abuse
 * allegations, exposures). May carry patient-level PHI (`patientId`, `kindData` free-text), so seam
 * callers must hold patient scope for patient-bound rows.
 */
export type Incident = schema.IncidentReport;

/** A QAPI improvement project under a program — the `qapi_project` row. */
export type QapiProject = schema.QapiProject;

/**
 * Per-citation Condition-of-Participation compliance status for a provider entity — the
 * `cop_compliance_status` row. Aggregate-only: carries categorical status, not underlying PHI.
 */
export type ComplianceStatus = schema.CopComplianceStatus;

/** An annual HIPAA Security Risk Assessment cycle — the `sra_cycle` row. */
export type SraCycle = schema.SraCycle;
