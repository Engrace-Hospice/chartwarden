// apps/backend/src/modules/22-documents/abac-predicates.ts — M22-T07 (§4.7, §6.2).
//
// The seven named ABAC predicate resolvers M22 OWNS and registers into M3's named-predicate registry (M3 §3.4).
// Each is a typed `(context, target) => Promise<boolean>` evaluated server-side AFTER RBAC passes; M22 never
// authorizes by reading the request body — identifiers in the target are lifted by the route's `loadResource`
// (the route layer assembles `documentId` / `candidateId` / `reviewId` / `stepUpFresh` from the path + the M2
// step-up signal, never from a client-controlled authz claim). Every predicate is fail-closed: an incomplete
// target, an absent / cross-tenant fact, or an unresolved licensure attribute denies:
//
//   document_owner_or_caseload          — §4.7: the document's patient is in the actor's caseload (resolves
//        through the injected resolver, which prod backs with M5's `CaseloadProvider`), OR the actor holds a
//        scope-bypass role (compliance_officer / medical_director / survey_auditor / org_admin / qa), OR the
//        document is org-level (`patient_id IS NULL`). Applied to every `documents.read_phi_content` route +
//        the signed-URL mint, and to `documents.read` / `documents.export_phi_bundle`.
//   document_within_admission_window    — §4.7: post-discharge documents (bereavement letters, post-discharge
//        statement-of-disagreement / survey) stay readable by care-team members for 13 months past discharge;
//        after that only compliance/qa/scope-bypass roles may read. Non-post-discharge documents pass through.
//   legal_hold_aware                    — §4.7: a document-mutating action (`documents.edit_metadata` /
//        `documents.delete`) is denied when any active `document_legal_hold` row exists, regardless of RBAC.
//   extraction_reviewer_eligible        — §4.7 / D-AUTHZ-01: the actor's licensure may review the candidate's
//        risk level — RN/NP/PA/MD/DO may review high-risk medication/allergy/dx candidates; LPN may review
//        medium; intake_nurse may review low; aides/volunteers review none. Subsumes the former
//        `high_risk_capability_floor` (the platform floor cannot be loosened).
//   extraction_high_risk_field_per_field_only — §4.7 / §7.8 W8: at bulk-approve time, no candidate in scope is
//        `risk_level='high'`; if any is, the predicate denies (the route rejects 422 HIGH_RISK_FIELD_BULK_DENIED).
//   form_template_publish_authority     — §4.7: the actor is on the platform team (`platform_admin` role); a
//        tenant org_admin cannot publish a platform template version.
//   tenant_template_overlay_edit_authority — §4.7: the actor is `org_admin` AND step-up auth is fresh (≤5 min).
//
// Registration is idempotent (the shared registry is single-owner / no-clear): re-boot (tests) guards on
// `abacRegistry.has`. The predicates consume the M5 caseload read path ONLY through the injected resolver — no
// direct M5 schema import, no extra `dependsOn` edge beyond M22's declared `[1, 5]`.
import { type AbacContext, type AbacTarget, abacRegistry, registerPredicate } from "@wardenx/auth";
import type { ExtractionCandidateRiskLevel } from "@wardenx/types";

/** The §4.7 predicate names M22 owns (registered into M3). Single-owner across the platform registry. */
export const M22_ABAC_PREDICATES = [
  "document_owner_or_caseload",
  "document_within_admission_window",
  "legal_hold_aware",
  "extraction_reviewer_eligible",
  "extraction_high_risk_field_per_field_only",
  "form_template_publish_authority",
  "tenant_template_overlay_edit_authority",
] as const;

/** §4.7 — the roles that bypass patient-caseload scoping for document reads (compliance / medical / survey /
 *  admin / QA). A scope-bypass actor may read any document in their org regardless of caseload membership. */
export const DOCUMENT_SCOPE_BYPASS_ROLES = [
  "compliance_officer",
  "medical_director",
  "survey_auditor",
  "org_admin",
  "qa",
] as const;

/** §4.7 / D-AUTHZ-01 — licensure types cleared to review a HIGH-risk extraction candidate (RN-or-above). */
export const HIGH_RISK_REVIEWER_LICENSURE = ["RN", "NP", "PA", "MD", "DO"] as const;
/** Licensure types cleared to review a MEDIUM-risk candidate (RN-or-above plus LPN). */
export const MEDIUM_RISK_REVIEWER_LICENSURE = [...HIGH_RISK_REVIEWER_LICENSURE, "LPN"] as const;

const targetStr = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const hasRole = (context: AbacContext, role: string): boolean => context.roles.includes(role);
const hasScopeBypass = (context: AbacContext): boolean =>
  DOCUMENT_SCOPE_BYPASS_ROLES.some((r) => context.roles.includes(r));

/** Read the actor's licensure type from the M2 user-attribute (`attributes.licensure.type`); null if unset. */
function licensureType(context: AbacContext): string | null {
  const lic = context.attributes.licensure;
  if (lic && typeof lic === "object" && "type" in lic) {
    const type = (lic as { type: unknown }).type;
    return typeof type === "string" && type.length > 0 ? type : null;
  }
  return null;
}

/**
 * The read surface M22's ABAC predicates resolve against (the in-memory route service / Drizzle store
 * implements it; prod backs the caseload check with M5's `CaseloadProvider`). Every method is org-pinned and
 * fail-closed by contract (returns `null` on an absent / cross-tenant fact).
 */
export interface DocumentAbacResolver {
  /** The document's patient binding — `{ patientId }` (null patientId = org-level doc); null = absent / cross-tenant. */
  documentPatient(orgId: string, documentId: string): Promise<{ patientId: string | null } | null>;
  /** True when the patient is in the membership's caseload (resolves M5's `CaseloadProvider` in prod). */
  isInCaseload(orgId: string, userId: string, patientId: string): Promise<boolean>;
  /** True when any active `document_legal_hold` row exists for the document (`legal_hold_aware` denies). */
  hasActiveLegalHold(orgId: string, documentId: string): Promise<boolean>;
  /** The §164.524 13-month post-discharge readability decision for the document, or null if absent. */
  admissionWindow(
    orgId: string,
    documentId: string,
  ): Promise<{ postDischarge: boolean; withinWindow: boolean } | null>;
  /** The candidate's `risk_level` (drives `extraction_reviewer_eligible`), or null if absent / cross-tenant. */
  candidateRiskLevel(orgId: string, candidateId: string): Promise<ExtractionCandidateRiskLevel | null>;
  /** True when ANY candidate in the review's scope is `risk_level='high'`; null if the review is absent. */
  reviewScopeHasHighRisk(orgId: string, reviewId: string): Promise<boolean | null>;
}

/** Deps for M22's ABAC predicate resolvers (the slice injects an in-memory resolver over its dataset). */
export interface DocumentAbacDeps {
  readonly resolver: DocumentAbacResolver;
}

/**
 * Build M22's seven §4.7 predicate resolvers over injected deps (pure factory — unit-tested with a fresh
 * registry; the boot path registers them via {@link registerDocumentAbacPredicates}). The document-read routes
 * assemble the target from the path (`documentId`); the review routes from the path (`candidateId` / `reviewId`);
 * the overlay route from the M2 step-up freshness signal (`stepUpFresh`).
 */
export function buildDocumentAbacPredicates(
  deps: DocumentAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;
  return {
    document_owner_or_caseload: async (context, target) => {
      const documentId = targetStr(target, "documentId");
      if (!documentId) return false; // incomplete target → deny
      if (hasScopeBypass(context)) return true; // compliance / medical / survey / admin / qa
      const doc = await resolver.documentPatient(context.organizationId, documentId);
      if (doc === null) return false; // absent / cross-tenant → deny
      if (doc.patientId === null) return true; // org-level doc + a role that passed RBAC
      return resolver.isInCaseload(context.organizationId, context.userId, doc.patientId);
    },
    document_within_admission_window: async (context, target) => {
      const documentId = targetStr(target, "documentId");
      if (!documentId) return false; // incomplete target → deny
      const window = await resolver.admissionWindow(context.organizationId, documentId);
      if (window === null) return false; // absent / cross-tenant → deny
      if (!window.postDischarge) return true; // not a post-discharge document → no window restriction
      if (hasScopeBypass(context)) return true; // compliance / qa / scope-bypass may always read
      return window.withinWindow; // care-team members readable only inside the 13-month window
    },
    legal_hold_aware: async (context, target) => {
      const documentId = targetStr(target, "documentId");
      if (!documentId) return false; // incomplete target → deny (cannot prove no hold)
      const onHold = await resolver.hasActiveLegalHold(context.organizationId, documentId);
      return !onHold; // any active hold → deny the mutating action
    },
    extraction_reviewer_eligible: async (context, target) => {
      const candidateId = targetStr(target, "candidateId");
      if (!candidateId) return false; // incomplete target → deny
      const risk = await resolver.candidateRiskLevel(context.organizationId, candidateId);
      if (risk === null) return false; // absent / cross-tenant → deny
      const licensure = licensureType(context);
      if (risk === "high") return licensure !== null && HIGH_RISK_REVIEWER_LICENSURE.includes(licensure as never);
      if (risk === "medium")
        return licensure !== null && MEDIUM_RISK_REVIEWER_LICENSURE.includes(licensure as never);
      // low-risk: any clinical licensure, or an intake_nurse handling demographic candidates.
      return licensure !== null || hasRole(context, "intake_nurse");
    },
    extraction_high_risk_field_per_field_only: async (context, target) => {
      const reviewId = targetStr(target, "reviewId");
      if (!reviewId) return false; // incomplete target → deny
      const hasHighRisk = await resolver.reviewScopeHasHighRisk(context.organizationId, reviewId);
      if (hasHighRisk === null) return false; // absent / cross-tenant → deny
      return !hasHighRisk; // a high-risk candidate in scope → deny the bulk approve (per-field only, D4)
    },
    form_template_publish_authority: async (context) => hasRole(context, "platform_admin"),
    tenant_template_overlay_edit_authority: async (context, target) => {
      if (!hasRole(context, "org_admin")) return false; // tenant org_admin only
      return target.stepUpFresh === true; // step-up auth verified ≤5 min stale (§6.2)
    },
  };
}

/**
 * Register M22's seven §4.7 ABAC predicate resolvers into M3's shared registry (M22-T07; idempotent). Call at
 * boot after the document route service is constructed (the resolver reads the same dataset / M5 CaseloadProvider).
 * Re-boot (tests) skips already-registered names (single-owner / no-clear).
 */
export function registerDocumentAbacPredicates(deps: DocumentAbacDeps): void {
  const predicates = buildDocumentAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    if (abacRegistry.has(name)) continue;
    registerPredicate(name, predicate);
  }
}
