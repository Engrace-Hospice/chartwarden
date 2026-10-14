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
   * Query-string param holding the touched patient's id, for a read that names its patient in the
   * query rather than the path (`/consents/eval-audit/by-patient?patientId=…`).
   */
  readonly patientIdQueryParam?: string;
  /**
   * Dot path(s) into the RESPONSE payload holding the touched patient's id, for a read whose route
   * identifies the RESOURCE but not the patient (`GET /consents/:consentId`). Numeric segments index
   * arrays (`"data.0.patientId"`); the first path yielding a non-empty string wins.
   *
   * This exists because the accounting query joins on `context.patientId`
   * (packages/audit/src/query/drizzle-audit-query.ts `touchesPatient`) — a patient-scoped read that
   * emits an event it cannot attribute to a patient is invisible to the §164.528 report, which is
   * the one question the read trail exists to answer.
   */
  readonly patientIdPayloadPath?: string | readonly string[];
  /**
   * For a SINGLE-resource read that discloses SEVERAL patients (a handoff lists up to 50): dot path to an ARRAY in the
   * RESPONSE payload plus the key holding each element's patient id. The emitter writes ONE `<kind>.viewed` event per
   * distinct patient (all against the same resource id), so the §164.528 accounting join sees every patient disclosed,
   * not just the first. Elements without a string at the key (a restricted row) are skipped. Combine with
   * `resourceIdParam`; the first patient found is also the primary attribution when no other path names one.
   */
  readonly patientIdsPayload?: { readonly path: string; readonly key: string };
  /**
   * Route param holding the specific resource's id (a single chart open). Defaults to
   * `patientIdParam` when omitted — a patient-scoped read is accounted against the patient.
   */
  readonly resourceIdParam?: string;
  /**
   * Dot path into the RESPONSE payload holding the resource's id, for a route that has no id param because it CREATES the
   * resource (`POST /handoffs` answers the new handoff). Used only when `resourceIdParam` yields nothing.
   */
  readonly resourceIdPayloadPath?: string;
  /**
   * For a LIST read only: record `resourceIdParam`'s value (when it is a uuid) as the event's resource id. Opt-in, because
   * most list routes' param is a PARENT id under a CHILD `resourceKind`, which would mislabel the row; set it only when the
   * param names the container the `resourceKind` itself lives in (a channel's messages under `message`).
   */
  readonly listResourceId?: boolean;
  /** Field names the route surfaces — recorded in context, NEVER the values (§2.3). */
  readonly fields?: readonly string[];
  /**
   * True for a high-volume LIST read: the emitter records ONE aggregate `<kind>.list_viewed`
   * event (count + filter) via `auditListRead`, not one `<kind>.viewed` per row (§3.4).
   */
  readonly list?: boolean;
  /**
   * Query-string keys whose VALUES must not reach the audit row (a free-text search term is message content, not
   * metadata). The key stays, with its value replaced, so the row still shows that the filter was used.
   */
  readonly filterOmit?: readonly string[];
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
