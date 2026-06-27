// @wardenx/audit — PHI read-route `config.auditRead` shape + normalization (M4 §2.5, §3.4).
//
// A PHI read route declares its read-audit intent on its Fastify route `config.auditRead`. The
// composition root's coverage hook (apps/backend/src/bootstrap/plugins/read-audit.ts) reads it at
// route-registration time and refuses any governed PHI read route that omits it (§2.5 completeness,
// fail-closed at boot). This leaf-level shape lets both the host plugin and the route modules speak
// the same contract without a cross-module edge.
import type { ReadAuditMode } from "./require-read-audit";

/** Emission intent: the route surfaces PHI, so it must emit a read event. Names only, never values. */
export interface RouteReadAuditEmit {
  /** Resource kind read, e.g. `patient` — drives the `<kind>.viewed`/`.list_viewed` event_type. */
  readonly resourceKind: string;
  /** Route param holding the touched patient's id (enables the §164.528 accounting join). */
  readonly patientIdParam?: string;
  /**
   * Route param holding the specific resource's id (a single chart open). Defaults to
   * `patientIdParam` when omitted — a patient-scoped read is accounted against the patient.
   */
  readonly resourceIdParam?: string;
  /** Field names the route surfaces — recorded in context, NEVER the values (§2.3). */
  readonly fields?: readonly string[];
  /**
   * True for a high-volume LIST read: the emitter records ONE aggregate `<kind>.list_viewed`
   * event (count + filter) via `auditListRead`, not one `<kind>.viewed` per row (§3.4).
   */
  readonly list?: boolean;
}

/** An explicit, justified waiver: the route surfaces no accountable PHI (e.g. aggregate counts). */
export interface RouteReadAuditWaiver {
  /** Why this read needs no read event — a non-empty justification (an empty waiver is not a waiver). */
  readonly none: string;
}

/** A route's `config.auditRead`: emit a read event, or a justified `none` waiver (§2.5). */
export type RouteReadAudit = RouteReadAuditEmit | RouteReadAuditWaiver;

/** Type guard: is this `config.auditRead` value a `none` waiver? */
function isWaiver(value: RouteReadAudit): value is RouteReadAuditWaiver {
  return typeof (value as RouteReadAuditWaiver).none === "string";
}

/**
 * Normalize a route's `config.auditRead` value into the registry's `ReadAuditMode`, or `null` when
 * absent (the coverage hook turns a `null` into a fail-closed registration error). A waiver carries
 * its justification through to `declareReadAudit`, which rejects an empty one.
 */
export function routeReadAuditMode(value: RouteReadAudit | undefined | null): ReadAuditMode | null {
  if (value === undefined || value === null) return null;
  return isWaiver(value) ? { auditRead: "none", justification: value.none } : { auditRead: true };
}
