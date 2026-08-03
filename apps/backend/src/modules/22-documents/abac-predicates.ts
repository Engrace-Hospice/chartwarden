// apps/backend/src/modules/22-documents/abac-predicates.ts — M22-T07 (§4.7).
//
// The SEVEN named ABAC predicate resolvers M22 OWNS and registers into M3's named-predicate registry
// (M3 §3.4). Each is a typed `(context, target) => boolean` evaluated server-side AFTER RBAC passes; M22
// never authorizes by reading the request body — a document's owner facts are loaded through the injected
// {@link DocumentAbacResolver} (org-scoped, RLS-backstopped). `document_owner_or_caseload` COMPOSES M5's
// `caseload_or_scope`/`CaseloadProvider` (M3 D5) rather than duplicating caseload-lookup code; M22 reaches
// the M5 seam OPAQUELY via `getSeam("CaseloadProvider")` so no `@wardenx/patient` import / dependency edge
// is created (M22 `dependsOn` stays `[1, 5]`).
//
// `extraction_reviewer_eligible` SUBSUMES the former licensure-floor check (M22-F16/F19 / ADR-0022): the
// RN-or-above requirement for high-risk medication/allergy/dx fields lives here, read off the actor's
// session licensure attribute (`user.licensure.type ∈ {RN, NP, PA, MD, DO}`); the platform floor cannot be
// loosened. Registration is idempotent: the shared registry is single-owner / no-clear, so re-boot (tests)
// is idempotent via registerPredicateIdempotent.
import { type AbacContext, type AbacTarget, registerPredicateIdempotent } from "@wardenx/auth";
import type { DocumentRetentionClass } from "@wardenx/types";
import { getSeam } from "../../bootstrap/index";

/** The §4.7 predicate names M22 owns (registered into M3). Single-owner across the platform registry. */
export const M22_ABAC_PREDICATES = [
  "document_owner_or_caseload",
  "extraction_reviewer_eligible",
  "extraction_high_risk_field_per_field_only",
  "form_template_publish_authority",
  "tenant_template_overlay_edit_authority",
  "legal_hold_aware",
  "document_within_admission_window",
] as const;

/** The §4.7 owner facts the document predicates resolve for one document (RLS-backstopped). */
export interface DocumentAbacFacts {
  readonly documentId: string;
  /** `null` for org-level operational documents (no patient bind). */
  readonly patientId: string | null;
  readonly retentionClass: DocumentRetentionClass;
  /** Any active `document_legal_hold` row exists for the document (gates write actions, §4.7). */
  readonly legalHoldActive: boolean;
  /** The patient's discharge instant, if discharged — drives the 13-month post-discharge read window. */
  readonly patientDischargedAt: string | null;
}

/** Loads a document's org-scoped owner facts (in-memory in the slice; Drizzle in prod under RLS). */
export interface DocumentAbacResolver {
  loadDocument(organizationId: string, documentId: string): Promise<DocumentAbacFacts | null>;
}

const hasRole = (context: AbacContext, role: string): boolean => context.roles.includes(role);
const targetId = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/** The scope-bypass roles that may read any document regardless of caseload (§4.7). */
const SCOPE_BYPASS_ROLES = [
  "compliance_officer",
  "medical_director",
  "survey_auditor",
  "org_admin",
  "qa",
] as const;
const isScopeBypass = (context: AbacContext): boolean =>
  SCOPE_BYPASS_ROLES.some((r) => hasRole(context, r));

/** §4.7 — the licensure types eligible to review high-risk medication/allergy/dx fields (RN-or-above). */
const HIGH_RISK_LICENSURE = new Set(["RN", "NP", "PA", "MD", "DO"]);

/** Read the actor's session-assembled licensure type (M2 `user.licensure.type`), or null. */
function licensureTypeOf(context: AbacContext): string | null {
  const licensure = context.attributes.licensure;
  if (licensure && typeof licensure === "object") {
    const type = (licensure as { type?: unknown }).type;
    if (typeof type === "string") return type;
  }
  return null;
}

/** Thirteen months in milliseconds — the post-discharge care-team read window (§4.7). */
const THIRTEEN_MONTHS_MS = 13 * 30 * 24 * 60 * 60 * 1000;

/** Deps for M22's ABAC predicate resolvers (the slice injects an in-memory resolver + caseload stub). */
export interface DocumentAbacDeps {
  /** Loads a document's org-scoped owner facts (in-memory in the slice; Drizzle in prod under RLS). */
  readonly resolver: DocumentAbacResolver;
  /** Caseload membership check (defaults to the boot-registered M5 `CaseloadProvider` seam). */
  readonly isInCaseload?: (q: {
    organizationId: string;
    userId: string;
    patientId: string;
  }) => Promise<boolean>;
}

/**
 * Build M22's seven §4.7 predicate resolvers over injected deps (pure factory — unit-tested with a fresh
 * registry; the boot path registers these via {@link registerDocumentAbacPredicates}). The document target's
 * id is the route `:id` param; a missing/cross-tenant document fails closed (deny).
 */
export function buildDocumentAbacPredicates(
  deps: DocumentAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;
  const isInCaseload = deps.isInCaseload ?? ((q) => getSeam("CaseloadProvider").isInCaseload(q));

  /** Caseload-or-scope over a document's patient (org-level doc readable by a scope-bypass role). §4.7. */
  const ownerOrCaseload = async (context: AbacContext, facts: DocumentAbacFacts): Promise<boolean> => {
    if (isScopeBypass(context)) return true;
    if (facts.patientId === null) return false; // org-level doc — only scope-bypass roles (above)
    if (!context.userId) return false;
    return isInCaseload({
      organizationId: context.organizationId,
      userId: context.userId,
      patientId: facts.patientId,
    });
  };

  return {
    // every documents.read_phi_content route + the signed-URL mint (§4.7).
    document_owner_or_caseload: async (context, target) => {
      const id = targetId(target, "id");
      if (!id) return false;
      const facts = await resolver.loadDocument(context.organizationId, id);
      if (!facts) return false; // fail-closed (absent / cross-tenant)
      return ownerOrCaseload(context, facts);
    },

    // per-candidate decision time — high-risk fields need RN-or-above licensure (subsumes the floor, §4.7).
    extraction_reviewer_eligible: async (context, target) => {
      // The target carries the candidate's risk level (resolved per-route); low/medium are broadly eligible.
      const risk = typeof target.riskLevel === "string" ? target.riskLevel : "low";
      if (risk !== "high") return true; // low/medium demographic + clinical fields: route RBAC suffices
      const licensure = licensureTypeOf(context);
      return licensure !== null && HIGH_RISK_LICENSURE.has(licensure);
    },

    // bulk-approve: deny when any candidate in scope is high-risk (returns 422 HIGH_RISK_FIELD_BULK_DENIED).
    extraction_high_risk_field_per_field_only: async (_context, target) => {
      const anyHighRisk = target.anyHighRisk === true;
      return !anyHighRisk;
    },

    // publish a platform template version — must be on the platform team (tenant org_admin cannot, §4.7).
    form_template_publish_authority: async (context) => hasRole(context, "platform_admin"),

    // publish a tenant overlay — must be org_admin for the target org (step-up verified at the route, §4.7).
    tenant_template_overlay_edit_authority: async (context) => hasRole(context, "org_admin"),

    // any document-mutating action is denied while an active legal hold exists, regardless of RBAC (§4.7).
    legal_hold_aware: async (context, target) => {
      const id = targetId(target, "id");
      if (!id) return false;
      const facts = await resolver.loadDocument(context.organizationId, id);
      if (!facts) return false; // fail-closed
      return facts.legalHoldActive === false;
    },

    // post-discharge docs readable by care-team for 13 months; after that only compliance/QA/scope-bypass.
    document_within_admission_window: async (context, target) => {
      const id = targetId(target, "id");
      if (!id) return false;
      const facts = await resolver.loadDocument(context.organizationId, id);
      if (!facts) return false; // fail-closed
      if (isScopeBypass(context)) return true; // compliance/QA always read
      if (facts.patientDischargedAt === null) return ownerOrCaseload(context, facts); // not discharged
      const elapsed = Date.now() - Date.parse(facts.patientDischargedAt);
      if (elapsed > THIRTEEN_MONTHS_MS) return false; // window closed for care-team
      return ownerOrCaseload(context, facts);
    },
  };
}

/**
 * Register M22's seven §4.7 ABAC predicate resolvers into M3's shared registry (M22-T07; idempotent).
 * Call at boot after the M5 `CaseloadProvider` seam is registered (`document_owner_or_caseload` /
 * `document_within_admission_window` resolve caseload through it). Re-boot (tests) skips already-registered
 * names (single-owner / no-clear).
 */
export function registerDocumentAbacPredicates(deps: DocumentAbacDeps): void {
  const predicates = buildDocumentAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
}
