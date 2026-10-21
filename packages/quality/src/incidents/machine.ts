// @chartwarden/quality — M30 §2.2 / D8 incident_report lifecycle machine (P2a). Pure, IO-free.
//
// The incident aggregate lifecycle (§2.2, routes R-54..R-60):
//
//   draft ─submit→ submitted ─triage→ triaged ─beginInvestigation→ under_investigation
//     └(R-53 PATCH edits draft in place — not a transition)              │
//   under_investigation ─resolve→ resolved ─close→ closed_followup_complete ─reopen→ reopened
//                                                                            reopened ─resume→ under_investigation
//
// This is the M8/M11 lifecycle convention (NOT XState — the spec's "XState machine" wording is a proposal;
// the codebase has zero xstate): a transition is a PURE function `(state, event) → new state + an explicit
// in-transaction side-effect list`, throwing an {@link IncidentStateError} on an illegal transition or a
// guard failure. Every fact a guard needs (required-fields complete, mandatory-report flag set, the
// resolver-vs-assignee identity, corrective-action text length) is resolved UPSTREAM and injected as event
// data — no IO, no DB, no clock. The two-person corrective-action control (M30-F03 / ADR-0022, WF-12) is
// encoded as the `resolve` guard: the resolver MUST NOT be the incident's assignee.
import { ChartWardenError } from "@chartwarden/types";
import type { IncidentKind, IncidentSeverity, IncidentState } from "../contracts";
import { isSeverityAtLeastModerate } from "./kinds";

// -----------------------------------------------------------------------------
// Failure-code catalog (the M11 OrderStateError precedent)
// -----------------------------------------------------------------------------

/** The M30 incident-lifecycle failure-code catalog → canonical HTTP status. */
export const M30_INCIDENT_ERROR_STATUS = {
  // §2.2 — an event from a state that does not accept it.
  ILLEGAL_INCIDENT_TRANSITION: 409,
  // §2.2 `submit` — the per-kind required `kind_data` members are not yet complete (V-14).
  INCIDENT_REQUIRED_FIELDS_INCOMPLETE: 422,
  // §2.2 / V-15 `submit` — `mandatory_report_flag` must be TRUE for abuse / qualifying-exposure kinds.
  INCIDENT_MANDATORY_REPORT_FLAG_REQUIRED: 422,
  // §2.2 `triage` — triage must assign an owner (membership) to the incident.
  INCIDENT_TRIAGE_ASSIGNEE_REQUIRED: 422,
  // WF-12 / M30-F03 / ADR-0022 `resolve` — the resolver must not be the incident's assignee.
  RESOLVE_SELF_SIGNOFF_FORBIDDEN: 403,
  // §2.2 `close` — `corrective_action_taken_text` ≥ 40 chars required for severity ≥ moderate.
  INCIDENT_CORRECTIVE_ACTION_TEXT_REQUIRED: 422,
  // §2.2 `reopen` — a reopen reason is required (the reopen audits at severity=critical).
  INCIDENT_REOPEN_REASON_REQUIRED: 422,
} as const;

/** A machine-readable M30 incident-lifecycle failure code (§2.2). */
export type M30IncidentErrorCode = keyof typeof M30_INCIDENT_ERROR_STATUS;

/** Minimum corrective-action text length the §2.2 closure gate requires for severity ≥ moderate. */
export const INCIDENT_CORRECTIVE_ACTION_MIN_CHARS = 40;

/**
 * A guard / validation failure in the M30 incident-lifecycle domain. Extends the M1 `ChartWardenError`
 * envelope base so the Fastify error handler renders the precise code + HTTP status with no cross-module
 * import edge (the M11 `OrderStateError` precedent).
 */
export class IncidentStateError extends ChartWardenError {
  constructor(code: M30IncidentErrorCode, message: string) {
    super(code, message, M30_INCIDENT_ERROR_STATUS[code]);
    this.name = "IncidentStateError";
  }
}

/** Throw an {@link IncidentStateError} when `condition` is false (guard helper). */
function require_(
  condition: boolean,
  code: M30IncidentErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new IncidentStateError(code, message);
}

// -----------------------------------------------------------------------------
// Side effects + transition result (the M11 declarative-effects precedent)
// -----------------------------------------------------------------------------

/** The §2.4 / §4.10 `m30.incident.*` outbox events an incident transition may publish. */
export type IncidentOutboxEvent =
  | "m30.incident.submitted"
  | "m30.incident.mandatory_report_required"
  | "m30.incident.closed"
  | "m30.incident.reopened";

/**
 * One in-transaction side effect a transition declares (§2.4). The service layer is the only place these
 * run; the machine never touches IO. `outbox` events are restricted to the `m30.incident.*` catalog.
 */
export type IncidentSideEffect =
  /** Write the M4 write-audit row for the aggregate (always present). */
  | { readonly kind: "audit"; readonly severity: "warn" | "critical" }
  /** Publish an `m30.incident.*` outbox event in the same tx (§4.10). */
  | { readonly kind: "outbox"; readonly event: IncidentOutboxEvent }
  /** Set a timestamp/marker column on the aggregate (e.g. `triaged_at`, `closed_at`, `reopened_at`). */
  | { readonly kind: "set_timestamp"; readonly field: string };

/** A transition's full result — the new state + its ordered side-effect list. */
export interface IncidentTransitionResult {
  readonly from: IncidentState;
  readonly event: IncidentEvent["type"];
  readonly to: IncidentState;
  readonly effects: ReadonlyArray<IncidentSideEffect>;
}

function result(
  from: IncidentState,
  event: IncidentEvent["type"],
  to: IncidentState,
  effects: ReadonlyArray<IncidentSideEffect>,
): IncidentTransitionResult {
  return { from, event, to, effects };
}

/** Critical-severity audit applies to any state change on an `allegation_of_abuse` kind (§2.2). */
function auditSeverity(kind: IncidentKind): "warn" | "critical" {
  return kind === "allegation_of_abuse" ? "critical" : "warn";
}

// -----------------------------------------------------------------------------
// Events (per-event facts resolved upstream and injected as data)
// -----------------------------------------------------------------------------

/** The §2.2 incident lifecycle events. */
export type IncidentEvent =
  | {
      readonly type: "submit";
      readonly kind: IncidentKind;
      readonly severity: IncidentSeverity;
      /** §2.2 — the per-kind required `kind_data` members are complete (`validateIncidentKindData`, V-14). */
      readonly requiredFieldsComplete: boolean;
      /** V-15 — this incident requires an external mandatory report (`determineMandatoryReport`). */
      readonly mandatoryReportRequired: boolean;
      /** V-15 — `incident_report.mandatory_report_flag` is set on the row (operator confirmed). */
      readonly mandatoryReportFlagSet: boolean;
    }
  | {
      readonly type: "triage";
      readonly kind: IncidentKind;
      /** §2.2 — triage assigns the investigating owner; absent ⇒ rejected. */
      readonly assignedToMembershipId: string | null;
    }
  | {
      readonly type: "beginInvestigation";
      readonly kind: IncidentKind;
    }
  | {
      readonly type: "resolve";
      readonly kind: IncidentKind;
      /** WF-12 — the incident's current assignee (`assigned owner`). */
      readonly assignedToMembershipId: string;
      /** WF-12 — the actor verifying the corrective action and resolving. */
      readonly resolvedByMembershipId: string;
    }
  | {
      readonly type: "close";
      readonly kind: IncidentKind;
      readonly severity: IncidentSeverity;
      /** §2.2 — length of `corrective_action_taken_text` (≥ 40 required for severity ≥ moderate). */
      readonly correctiveActionTextLength: number;
    }
  | {
      readonly type: "reopen";
      readonly kind: IncidentKind;
      /** §2.2 — length of the reopen reason (≥ 1 required; reopen audits at severity=critical). */
      readonly reopenReasonLength: number;
    }
  | {
      readonly type: "resume";
      readonly kind: IncidentKind;
    };

/** The legal §2.2 transition graph (from → events accepted). Guards are checked separately. */
export const INCIDENT_GRAPH: Readonly<Record<IncidentState, ReadonlyArray<IncidentEvent["type"]>>> =
  {
    draft: ["submit"],
    submitted: ["triage"],
    triaged: ["beginInvestigation"],
    under_investigation: ["resolve"],
    resolved: ["close"],
    closed_followup_complete: ["reopen"],
    reopened: ["resume"],
  };

/**
 * Apply an incident lifecycle event (§2.2). Throws {@link IncidentStateError} `ILLEGAL_INCIDENT_TRANSITION`
 * if the event is not accepted from `from`, or the specific §2.2 guard code on a guard failure. Returns the
 * new state + the ordered §2.4 side-effect list the service runs in the incident's optimistic-locked tx.
 */
export function transitionIncident(
  from: IncidentState,
  event: IncidentEvent,
): IncidentTransitionResult {
  if (!INCIDENT_GRAPH[from].includes(event.type)) {
    throw new IncidentStateError(
      "ILLEGAL_INCIDENT_TRANSITION",
      `incident cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "submit": {
      require_(
        event.requiredFieldsComplete,
        "INCIDENT_REQUIRED_FIELDS_INCOMPLETE",
        "the incident's per-kind required fields are not complete",
      );
      // V-15 — the mandatory-report gate: abuse / qualifying-exposure kinds cannot be submitted until the
      // mandatory_report_flag is affirmatively set.
      require_(
        !event.mandatoryReportRequired || event.mandatoryReportFlagSet,
        "INCIDENT_MANDATORY_REPORT_FLAG_REQUIRED",
        "this incident kind/subkind requires the mandatory-report flag to be set before submission",
      );
      // NOTE: the §2.2 state is tracked by `incident_report.lifecycle`; there is no `submitted_at` column
      // in the frozen schema, so the transition stamps no timestamp here (only `triaged_at` / `closed_at` /
      // `reopened_at` exist as discrete columns).
      const effects: IncidentSideEffect[] = [
        { kind: "audit", severity: auditSeverity(event.kind) },
        { kind: "outbox", event: "m30.incident.submitted" },
      ];
      if (event.mandatoryReportRequired) {
        effects.push({ kind: "outbox", event: "m30.incident.mandatory_report_required" });
      }
      return result(from, event.type, "submitted", effects);
    }

    case "triage": {
      require_(
        event.assignedToMembershipId !== null,
        "INCIDENT_TRIAGE_ASSIGNEE_REQUIRED",
        "triage must assign an investigating owner to the incident",
      );
      return result(from, event.type, "triaged", [
        { kind: "set_timestamp", field: "triaged_at" },
        { kind: "audit", severity: auditSeverity(event.kind) },
      ]);
    }

    case "beginInvestigation": {
      // §2.2 — opening the corrective-action plan / beginning investigation (R-57). No additional guard
      // beyond the graph; the assignee-only authority is an ABAC concern (assignedToIncident) at the route.
      // No discrete `investigation_started_at` column in the frozen schema; `lifecycle` tracks the state.
      return result(from, event.type, "under_investigation", [
        { kind: "audit", severity: auditSeverity(event.kind) },
      ]);
    }

    case "resolve": {
      // WF-12 / M30-F03 / ADR-0022 — the two-person corrective-action control: the resolver who verifies
      // the corrective action MUST NOT be the incident's assignee.
      require_(
        event.resolvedByMembershipId !== event.assignedToMembershipId,
        "RESOLVE_SELF_SIGNOFF_FORBIDDEN",
        "the resolver verifying the corrective action must not be the incident's assignee (two-person control)",
      );
      // No discrete `resolved_at` column in the frozen schema; `lifecycle` tracks the state.
      return result(from, event.type, "resolved", [
        { kind: "audit", severity: auditSeverity(event.kind) },
      ]);
    }

    case "close": {
      // §2.2 — closure requires a substantive corrective-action narrative for moderate-or-worse incidents.
      require_(
        !isSeverityAtLeastModerate(event.severity) ||
          event.correctiveActionTextLength >= INCIDENT_CORRECTIVE_ACTION_MIN_CHARS,
        "INCIDENT_CORRECTIVE_ACTION_TEXT_REQUIRED",
        `closing a severity ≥ moderate incident requires corrective-action text of at least ${INCIDENT_CORRECTIVE_ACTION_MIN_CHARS} characters`,
      );
      return result(from, event.type, "closed_followup_complete", [
        { kind: "set_timestamp", field: "closed_at" },
        { kind: "audit", severity: auditSeverity(event.kind) },
        { kind: "outbox", event: "m30.incident.closed" },
      ]);
    }

    case "reopen": {
      require_(
        event.reopenReasonLength >= 1,
        "INCIDENT_REOPEN_REASON_REQUIRED",
        "reopening a closed incident requires a reason",
      );
      // §2.2 — reopen ALWAYS audits at severity=critical (a survey-significant action).
      return result(from, event.type, "reopened", [
        { kind: "set_timestamp", field: "reopened_at" },
        { kind: "audit", severity: "critical" },
        { kind: "outbox", event: "m30.incident.reopened" },
      ]);
    }

    case "resume": {
      // §2.2 — a reopened incident resumes investigation (reopened → under_investigation).
      return result(from, event.type, "under_investigation", [
        { kind: "audit", severity: auditSeverity(event.kind) },
      ]);
    }
  }
}
