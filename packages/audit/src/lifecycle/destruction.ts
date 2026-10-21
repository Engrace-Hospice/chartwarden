// @chartwarden/audit — Destruction-certificate workflow (M4-T08, M4 spec §6, §10.5, §10.6; W-M4-09).
//
// A retention scan flags expired partitions and opens a `destruction_certificate`; Compliance
// approves it with re-auth, and the run erases the approved rows and files a signed certificate
// (§10.5). This module is the workflow that turns an approved certificate into a faithful outcome:
// it runs each row-group through the eraser (./eraser), tallies what was erased vs refused, derives
// the certificate's final state-machine status, and returns the audit events the run must emit.
//
//   • Every refusal is recorded, never silently dropped — a Part 2 refusal (the patient is still
//     within their lifetime+6yr window, §6) moves the certificate to `partial_refused` and emits
//     `audit.destruction_refused_part_two`; the non-Part-2 rows in the same batch are still erased
//     (W-M4-09).
//   • Legal-hold supremacy (§10.6) is enforced row-by-row by the eraser; a fully-held batch lands
//     the certificate in `held` (nothing touched), a partly-held batch in `partial_refused`.
//   • A run that erases anything emits `data.destruction_certified` so the signed certificate is
//     itself an audit artifact (§10.5).
import { type EraseInput, type EraseOutcome, type EraserPorts, eraseAuditRows } from "./eraser";

/** Certificate state after a run (mirrors the `destruction_status` enum's terminal values). */
export type DestructionRunStatus = "executed" | "partial_refused" | "held";

/** The approved certificate + the row-groups it authorizes for erasure. */
export interface DestructionRun {
  readonly certificateId: string;
  readonly dataClass: string;
  readonly organizationId: string;
  readonly rows: readonly EraseInput[];
}

/** One audit event the destruction run must emit (filed through the M4 writer by the caller). */
export interface DestructionAuditEvent {
  readonly action: string;
  readonly retentionClass: "compliance" | "compliance_42cfr_part2";
  readonly payload: Record<string, unknown>;
}

/** The faithful outcome of running a destruction certificate. */
export interface DestructionResult {
  readonly certificateId: string;
  readonly status: DestructionRunStatus;
  readonly rowsErased: number;
  readonly refusedPartTwo: number;
  readonly refusedLegalHold: number;
  readonly refusedNotEligible: number;
  /** The per-row-group outcomes, in input order — the certificate's itemized record. */
  readonly outcomes: readonly EraseOutcome[];
  /** The audit events the caller writes via the M4 writer (refusal + certification, §6/§10.5). */
  readonly auditEvents: readonly DestructionAuditEvent[];
}

/**
 * Execute an approved destruction certificate: erase each authorized row-group through the eraser,
 * honoring legal-hold supremacy + Part 2 lifetime retention, and report the certificate's terminal
 * status plus the audit events to emit. Pure over the injected `EraserPorts` — no DB, no clock of
 * its own (the eraser's `ports.now()` drives the 6-year window).
 */
export async function runDestruction(
  run: DestructionRun,
  ports: EraserPorts,
): Promise<DestructionResult> {
  const outcomes: EraseOutcome[] = [];
  let rowsErased = 0;
  let erasedGroups = 0;
  let refusedPartTwo = 0;
  let refusedLegalHold = 0;
  let refusedNotEligible = 0;

  for (const row of run.rows) {
    const outcome = await eraseAuditRows(row, ports);
    outcomes.push(outcome);
    switch (outcome.kind) {
      case "erased":
        rowsErased += outcome.rowsErased;
        erasedGroups += 1;
        break;
      case "refused_part_two_retention":
        refusedPartTwo += 1;
        break;
      case "refused_legal_hold":
        refusedLegalHold += 1;
        break;
      case "refused_class_not_eligible":
        refusedNotEligible += 1;
        break;
    }
  }

  const total = run.rows.length;
  const refusedTotal = total - erasedGroups;
  const status: DestructionRunStatus =
    refusedTotal === 0 ? "executed" : refusedLegalHold === total ? "held" : "partial_refused";

  const auditEvents: DestructionAuditEvent[] = [];
  // A Part 2 refusal is itself a compliance event, recorded at the Part 2 retention class (§6).
  if (refusedPartTwo > 0) {
    auditEvents.push({
      action: "audit.destruction_refused_part_two",
      retentionClass: "compliance_42cfr_part2",
      payload: {
        certificateId: run.certificateId,
        dataClass: run.dataClass,
        organizationId: run.organizationId,
        refusedCount: refusedPartTwo,
      },
    });
  }
  // The signed certificate is an audit artifact whenever the run actually erased something (§10.5).
  if (rowsErased > 0) {
    auditEvents.push({
      action: "data.destruction_certified",
      retentionClass: "compliance",
      payload: {
        certificateId: run.certificateId,
        dataClass: run.dataClass,
        organizationId: run.organizationId,
        rowsErased,
        status,
      },
    });
  }

  return {
    certificateId: run.certificateId,
    status,
    rowsErased,
    refusedPartTwo,
    refusedLegalHold,
    refusedNotEligible,
    outcomes,
    auditEvents,
  };
}
