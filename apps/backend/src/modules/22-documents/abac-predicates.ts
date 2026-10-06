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
// RN-or-above requirement for high-risk medication/allergy/dx fields lives here; the platform floor cannot
// be loosened. It used to read a `context.attributes.licensure.type` that nothing has ever written
// (F-030), so it answered "no" for every reviewer and NOBODY could review a high-risk extracted
// medication, allergy or diagnosis field — a fail-closed control that has never once opened. It now reads
// the licence M17 actually records, through the `CredentialReader` seam (the `CaseloadProvider` pattern
// three lines up: opaque, no dependency edge). Registration is idempotent: the shared registry is
// single-owner / no-clear, so re-boot (tests) is idempotent via registerPredicateIdempotent.
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

/** A candidate's server-stored risk tier (§3.3 `extraction_candidate.risk_level`). */
export type CandidateRiskLevel = "low" | "medium" | "high";

/** Loads a document's org-scoped owner facts (in-memory in the slice; Drizzle in prod under RLS). */
export interface DocumentAbacResolver {
  loadDocument(organizationId: string, documentId: string): Promise<DocumentAbacFacts | null>;
  /**
   * F-237 — the stored risk tier of each candidate that belongs to the review's OWN batch. An id that is
   * absent, cross-tenant or from another batch is simply missing from the map (the predicate denies it).
   */
  loadReviewCandidateRisks(
    organizationId: string,
    reviewId: string,
    candidateIds: readonly string[],
  ): Promise<ReadonlyMap<string, CandidateRiskLevel>>;
  /** F-237 — the risk tier of a discrepancy's primary candidate, when the discrepancy is the review's batch's. */
  loadDiscrepancyRisk(
    organizationId: string,
    reviewId: string,
    discrepancyId: string,
  ): Promise<CandidateRiskLevel | null>;
}

const hasRole = (context: AbacContext, role: string): boolean => context.roles.includes(role);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (value: unknown): string | null =>
  typeof value === "string" && UUID.test(value) ? value : null;
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

/**
 * §4.7 — the credential kinds eligible to review high-risk medication/allergy/dx fields (RN-or-above).
 *
 * The §4.7 text names {RN, NP, PA, MD, DO}; these are the four `credential_discipline` values that
 * cover them, because `md` is PHYSICIAN — MD *or* DO. The two are the same level with the same scope
 * and the platform has always stored them as one value: `VISIT_PURPOSE_DISCIPLINES` documents its
 * physician-intent purposes as "MD/DO or NP" while listing `md`. Splitting them to make this list
 * read literally would have stopped four CoP-relevant visit purposes accepting osteopathic
 * physicians — a regression bought with a distinction no consumer makes.
 *
 * `pa` was genuinely missing from the vocabulary until migration 0221; a physician assistant could
 * not be recorded as licensed at all, so this arm could never have opened for one.
 */
const HIGH_RISK_CREDENTIALS: ReadonlySet<string> = new Set(["rn", "np", "pa", "md"]);

/**
 * The acting membership, which the credential read is keyed on. Absent ⇒ deny: a session with no
 * active membership holds no credentials to check.
 */
function actorMembershipId(context: AbacContext): string | null {
  const value = context.attributes.membershipId;
  return typeof value === "string" && value.length > 0 ? value : null;
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
  /**
   * The reviewer's ACTIVE clinical credentials (defaults to the boot-registered M17
   * `CredentialReader` seam). Reached opaquely, like `CaseloadProvider` — M22 `dependsOn` stays
   * `[1, 5]` and no `@wardenx/scheduling` import is created.
   */
  readonly activeCredentials?: (q: {
    organizationId: string;
    membershipId: string;
    asOf: string;
  }) => Promise<readonly { kind: string; status: string }[]>;
  /** Clock for the credential `asOf` date (tests pin it; production uses the real one). */
  readonly now?: () => Date;
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
  const activeCredentials =
    deps.activeCredentials ?? ((q) => getSeam("CredentialReader").activeCredentialsAsOf(q));
  const now = deps.now ?? (() => new Date());

  /**
   * Does this reviewer hold an ACTIVE licence at the §4.7 floor, as of today?
   *
   * The seam has already applied the status / effective / expiry logic — a suspended, revoked,
   * not-yet-effective or expired row is simply absent — so this only has to match the kind. Any
   * failure to resolve denies: a licence check that cannot read the licences is not evidence of one.
   */
  const holdsHighRiskLicence = async (context: AbacContext): Promise<boolean> => {
    const membershipId = actorMembershipId(context);
    if (!membershipId) return false; // fail-closed
    try {
      const credentials = await activeCredentials({
        organizationId: context.organizationId,
        membershipId,
        asOf: now().toISOString().slice(0, 10),
      });
      return credentials.some((c) => HIGH_RISK_CREDENTIALS.has(c.kind));
    } catch {
      return false;
    }
  };

  /** Caseload-or-scope over a document's patient (org-level doc readable by a scope-bypass role). §4.7. */
  const ownerOrCaseload = async (
    context: AbacContext,
    facts: DocumentAbacFacts,
  ): Promise<boolean> => {
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
    //
    // F-237 — the risk tier is the CANDIDATE ROW's, loaded here. It used to be read off `?riskLevel=` on
    // the request, so a browser that sent `low` (or nothing) for a medication was waved through and an
    // unlicensed reviewer could decide a high-risk field. The target now carries only ids.
    extraction_reviewer_eligible: async (context, target) => {
      // The §7.4 W4 SUD confirm/reject is a high-risk act on its own (it drives a Part 2 privacy flag).
      if (target.sudReview === true) return holdsHighRiskLicence(context);
      const reviewId = targetId(target, "id");
      const candidateId = uuidOrNull(target.candidateId);
      const discrepancyId = targetId(target, "discrepancyId");
      if (!reviewId) return false;
      let risk: CandidateRiskLevel | null;
      if (candidateId) {
        risk =
          (
            await resolver.loadReviewCandidateRisks(context.organizationId, reviewId, [candidateId])
          ).get(candidateId) ?? null;
      } else if (discrepancyId) {
        risk = await resolver.loadDiscrepancyRisk(context.organizationId, reviewId, discrepancyId);
      } else {
        // No candidate id at all: the handler's body validation answers 400 before any decision is
        // written, so there is nothing for this predicate to authorize.
        return target.candidateId === undefined;
      }
      if (risk === null) return false; // not this review's candidate ⇒ fail closed
      if (risk !== "high") return true; // low/medium demographic + clinical fields: route RBAC suffices
      return holdsHighRiskLicence(context);
    },

    // bulk-approve: deny when any candidate in scope is high-risk (or is not this review's candidate).
    // F-237 — resolved from the candidate rows, not from a client-sent `?anyHighRisk=`.
    extraction_high_risk_field_per_field_only: async (context, target) => {
      const reviewId = targetId(target, "id");
      const ids = target.candidateIds;
      if (!reviewId) return false;
      if (!Array.isArray(ids)) return true; // body validation (400) runs in the handler
      const valid = ids.map(uuidOrNull);
      if (valid.some((id) => id === null)) return true; // malformed ⇒ 400 in the handler, nothing written
      const risks = await resolver.loadReviewCandidateRisks(
        context.organizationId,
        reviewId,
        valid as string[],
      );
      return (valid as string[]).every((id) => {
        const risk = risks.get(id);
        return risk !== undefined && risk !== "high";
      });
    },

    // publish a platform template version — must be on the platform team (tenant org_admin cannot, §4.7).
    form_template_publish_authority: async (context) => hasRole(context, "platform_admin"),

    // publish a tenant overlay — must be org_admin for the target org (step-up is a separate `requireStepUp` preHandler on the route, GAP-066, not this predicate).
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
