// apps/backend/src/modules/36-messaging/clinical-link/clinical-link-service.ts - WP 3.2 clinical links.
//
// A message links to ONE record owned by another module. M36 stores (kind, source id, patient id) and nothing else; every
// fact shown about the record is READ THROUGH the owning module's `linkSummary` seam at open time. This file is the pure
// decision logic (ports in, verdict out); the route supplies the caller's guards, the DB store supplies the rows.
//
// ONE REFUSAL. Missing, forbidden, other-tenant, erased and seam-failed are the same answer on both paths (a generic 422
// at write, `{state:"unavailable"}` at open), so a link can never be used to probe whether a record exists.
//
// READ ONLY. Nothing in M36 calls a write method of a source seam; `ClinicalLinkSourcePorts` has no write member and the
// static test in `m36-clinical-link-no-write.test.ts` scans this directory to keep it that way.
import {
  CLINICAL_LINK_KINDS,
  type ClinicalLinkKind,
  type ClinicalLinkSummary,
  type RichBody,
  WardenXError,
  richBodyClinicalLinks,
} from "@wardenx/types";

export { CLINICAL_LINK_KINDS };
export type { ClinicalLinkKind };

export const CLINICAL_LINK_NOT_AVAILABLE = "CLINICAL_LINK_NOT_AVAILABLE";
export const CLINICAL_LINKS_FLAG_KEY = "messaging.clinical_links";

/** The ONE refusal. Fresh instance per throw (stack traces are per-instance); the text is fixed and names nothing. */
export function linkNotAvailable(): WardenXError {
  return new WardenXError(CLINICAL_LINK_NOT_AVAILABLE, "link not available", 422);
}

/** The owning-module reads M36 may make. Read-only by construction: there is no write member to call. */
export interface ClinicalLinkSourcePorts {
  /** The owning seam's `linkSummary` (org-explicit). A throw is a seam failure; null is "not found in this org". */
  summary(
    kind: ClinicalLinkKind,
    organizationId: string,
    sourceId: string,
  ): Promise<ClinicalLinkSummary | null>;
}

/** Whether the CURRENT caller passes the kind's read permission and scope for this target (break-glass never counts). */
export type LinkPermits = (
  kind: ClinicalLinkKind,
  target: { readonly sourceId: string; readonly patientId: string | null },
) => Promise<boolean>;

export interface ValidatedClinicalLink {
  readonly kind: ClinicalLinkKind;
  readonly sourceId: string;
  /** Null only for an IDG meeting. */
  readonly patientId: string | null;
}

/**
 * The summary the caller may see, or null for ANY reason they may not: not found, null patient on a kind that needs one,
 * a summary for a different id, a failing permission/scope check, or a seam that threw (`onSeamFailure` gets the kind only).
 */
async function authorisedSummary(
  kind: ClinicalLinkKind,
  organizationId: string,
  sourceId: string,
  ports: ClinicalLinkSourcePorts,
  permits: LinkPermits,
  onSeamFailure?: (kind: ClinicalLinkKind) => void,
): Promise<ClinicalLinkSummary | null> {
  let summary: ClinicalLinkSummary | null;
  try {
    summary = await ports.summary(kind, organizationId, sourceId);
  } catch {
    onSeamFailure?.(kind);
    return null;
  }
  if (!summary || summary.id.toLowerCase() !== sourceId.toLowerCase()) return null;
  if (summary.patientId === null && kind !== "idg_meeting") return null;
  // A guard that crashes (not a 403/404 verdict) must not surface as a 500: that would fire only when the record exists.
  try {
    return (await permits(kind, { sourceId, patientId: summary.patientId })) ? summary : null;
  } catch {
    onSeamFailure?.(kind);
    return null;
  }
}

export interface WriteValidationDeps {
  readonly ports: ClinicalLinkSourcePorts;
  readonly permits: LinkPermits;
  readonly onSeamFailure?: (kind: ClinicalLinkKind) => void;
}

/**
 * Validate every clinicalLink node of a body BEFORE the message commits. Any failure throws the same generic 422; a body
 * with no link nodes returns [] without touching a seam. The flag is the caller's check (it needs no seam).
 */
export async function validateClinicalLinks(
  organizationId: string,
  richBody: RichBody | undefined,
  deps: WriteValidationDeps,
): Promise<readonly ValidatedClinicalLink[]> {
  const nodes = richBody ? richBodyClinicalLinks(richBody) : [];
  const out: ValidatedClinicalLink[] = [];
  for (const node of nodes) {
    const summary = await authorisedSummary(
      node.kind,
      organizationId,
      node.entityId,
      deps.ports,
      deps.permits,
      deps.onSeamFailure,
    );
    if (!summary) throw linkNotAvailable();
    out.push({ kind: node.kind, sourceId: node.entityId, patientId: summary.patientId });
  }
  return out;
}

const keyOf = (link: { kind: string; sourceId: string }) =>
  `${link.kind}:${link.sourceId.toLowerCase()}`;

/**
 * The route service's defence in depth (asserted before the write core runs): the rows it persists must be exactly the body's clinicalLink nodes. A writer that
 * passes a body with link nodes but no validated list (or the reverse) is refused, so an unvalidated link cannot reach
 * the table through any path that skips the route.
 */
export function assertLinksMatchBody(
  richBody: RichBody | undefined,
  links: readonly ValidatedClinicalLink[] | undefined,
): readonly ValidatedClinicalLink[] {
  const given = links ?? [];
  const expected = new Set((richBody ? richBodyClinicalLinks(richBody) : []).map((n) =>
    keyOf({ kind: n.kind, sourceId: n.entityId }),
  ));
  if (given.length !== expected.size || given.some((link) => !expected.has(keyOf(link)))) {
    throw linkNotAvailable();
  }
  return given;
}

export interface OpenedClinicalLink {
  readonly state: "ok";
  readonly kind: ClinicalLinkKind;
  readonly status: string;
  readonly occurred_at: string | null;
  readonly as_of: string;
  readonly link: string;
  readonly patient_id: string | null;
}
export interface UnavailableClinicalLink {
  readonly state: "unavailable";
}
export type ResolvedClinicalLink = OpenedClinicalLink | UnavailableClinicalLink;

/** Deep link into the owning module's screen. Ids only. */
export function deepLinkFor(kind: ClinicalLinkKind, summary: ClinicalLinkSummary): string {
  const id = summary.id;
  switch (kind) {
    case "medication":
      return `/medication-orders/${id}`;
    case "order":
      return `/orders/${id}`;
    case "care_plan":
      return `/care-plans/${id}/summary`;
    case "assessment":
      return `/patients/${summary.patientId}/assessments/${id}`;
    case "visit":
      return `/scheduling/visits/${id}`;
    case "document":
      return `/patients/${summary.patientId}/documents`;
    case "idg_meeting":
      return `/idg/meetings/${id}`;
  }
}

export interface ResolveDeps extends WriteValidationDeps {
  readonly now: () => Date;
}

/** Open a link NOW: the live summary, re-authorised for this caller. Every failure is the identical `unavailable`. */
export async function resolveClinicalLink(
  link: { readonly kind: ClinicalLinkKind; readonly sourceId: string },
  organizationId: string,
  deps: ResolveDeps,
): Promise<ResolvedClinicalLink> {
  const summary = await authorisedSummary(
    link.kind,
    organizationId,
    link.sourceId,
    deps.ports,
    deps.permits,
    deps.onSeamFailure,
  );
  if (!summary) return { state: "unavailable" };
  return {
    state: "ok",
    kind: link.kind,
    status: summary.status,
    occurred_at: summary.occurredAt,
    as_of: deps.now().toISOString(),
    link: deepLinkFor(link.kind, summary),
    patient_id: summary.patientId,
  };
}
