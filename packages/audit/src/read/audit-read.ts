// @wardenx/audit — PHI read-capture contract (M4-T03, M4 spec §3.4, §2.3 "App — read").
//
// Viewing PHI is itself an auditable event (HIPAA §164.312(b)) and, when surfaced to an
// outside party, a §164.528-reportable *disclosure*. This module is the route-facing surface
// every PHI read route calls, layered on the M1 `auditRead()` primitive (./audit.ts):
//   • it picks the event_type — `<resource>.viewed` normally, `<resource>.disclosed` when the
//     read leaves the covered entity (the accounting-of-disclosures case);
//   • it records `patientId` so the accounting query (M4-T09, §7) can join every read to the
//     patient it touched;
//   • it records WHICH fields were surfaced and the disclosure recipient/purpose — names and
//     metadata only, never values: a read trail must not become a second copy of the PHI it
//     describes (the same rule the write-trigger diff scrub enforces, §2.3).
//
// Individual chart opens are always recorded individually (that is the accounting-relevant
// access). High-volume *list* reads collapse to one aggregate `<resource>.list_viewed` event
// carrying a count + the filter, via `auditListRead()` (§3.4).
import {
  type AuditContext,
  type AuditExecutor,
  type AuditSeverity,
  auditRead,
} from "../audit";

/** A read that surfaces a single resource to the actor (a chart open), or discloses it out. */
export interface PhiReadInput {
  /** Resource kind read, e.g. `patient`, `encounter`. Drives the `<kind>.viewed` event_type. */
  readonly resourceKind: string;
  /** The specific resource read — required so the access is individually accountable. */
  readonly resourceId: string;
  /** Patient this read touches; enables the §164.528 accounting-of-disclosures join (§7). */
  readonly patientId?: string;
  /** Which fields were surfaced — names only, recorded in `context`; NEVER the values (§2.3). */
  readonly fields?: readonly string[];
  /**
   * Set when this read leaves the covered entity. Its presence switches the event_type to
   * `<kind>.disclosed` — the §164.528-reportable case. `to`/`purpose` are recorded in context.
   */
  readonly disclosure?: { readonly to: string; readonly purpose: string };
  /** Severity override (defaults: `info` for a view, `warn` for a disclosure). */
  readonly severity?: AuditSeverity;
}

/** A high-volume list read — one aggregate event rather than one per row (§3.4). */
export interface PhiListReadInput {
  /** Resource kind listed, e.g. `patient`. Drives the `<kind>.list_viewed` event_type. */
  readonly resourceKind: string;
  /** How many rows the list surfaced (recorded in `context`). */
  readonly count: number;
  /** The filter/query that produced the list — metadata only; redacted before write. */
  readonly filter?: Record<string, unknown>;
  /** The container the list is scoped to when the route names one (e.g. a channel id): the event's resource id. */
  readonly resourceId?: string;
  /** Patient scope when the list is patient-bound (e.g. one patient's encounters). */
  readonly patientId?: string;
  readonly severity?: AuditSeverity;
}

/** Drop `undefined` entries so the recorded `context` carries only what was actually present. */
function compactContext(entries: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entries)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Record one PHI read of a single resource. Writes `<resourceKind>.disclosed` when `disclosure`
 * is present (the §164.528-reportable case), otherwise `<resourceKind>.viewed`. Call AFTER
 * authorization succeeds, in the resource handler / preSerialization hook (§3.4). Writes through
 * the caller's `tx` so the read event commits with the request (atomicity, M1 §7.3).
 */
export async function auditPhiRead(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: PhiReadInput,
): Promise<void> {
  const disclosed = input.disclosure !== undefined;
  await auditRead(tx, ctx, {
    eventType: `${input.resourceKind}.${disclosed ? "disclosed" : "viewed"}`,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
    severity: input.severity ?? (disclosed ? "warn" : "info"),
    context: compactContext({
      patientId: input.patientId,
      fields: input.fields,
      disclosure: input.disclosure,
    }),
  });
}

/**
 * Record one aggregate event for a high-volume list read (`<resourceKind>.list_viewed`) carrying
 * the row count + filter in `context`, rather than one event per row. Individual chart opens must
 * still go through `auditPhiRead()` — they are the accounting-relevant accesses (§3.4).
 */
export async function auditListRead(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: PhiListReadInput,
): Promise<void> {
  await auditRead(tx, ctx, {
    eventType: `${input.resourceKind}.list_viewed`,
    resourceKind: input.resourceKind,
    ...(input.resourceId ? { resourceId: input.resourceId } : {}),
    severity: input.severity ?? "info",
    context: compactContext({
      count: input.count,
      filter: input.filter,
      patientId: input.patientId,
    }),
  });
}
