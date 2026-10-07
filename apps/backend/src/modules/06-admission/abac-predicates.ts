// apps/backend/src/modules/06-admission/abac-predicates.ts — M6-T06 (spec §4.6).
//
// The TWELVE named ABAC predicate resolvers M6 OWNS and registers into M3's named-predicate registry
// (M3 §3.4). Each is a typed `(context, target) => boolean` evaluated server-side AFTER RBAC passes;
// M6 never authorizes by reading the request body — the resource's owner facts are loaded through the
// injected `AdmissionAbacResolver` (org-scoped, RLS-backstopped). `patient.scope` (route 8) is M5's
// re-used predicate — M6 does not own or register it.
//
// THREE of the ten are pure over `context.roles` (no resolver, no closure) — `f2f.is_hospice_md_or_np`,
// `f2f.window_override`, `compliance.window_override`. `discharge.is_order_signer` (route 40) replaced the
// role-only `discharge.is_medical_director` for 42 CFR 418.26(b) (FY 2027): it loads the discharge's date
// and chart and admits the medical director, the physician designee, or the physician member of THIS
// patient's IDG (medical director only for a pre-2026-10-01 discharge and for an external-death
// attestation). The remaining six are resource-bound (scope + signer-identity).
//
// Registration is idempotent: the shared registry is single-owner / no-clear, so re-boot (tests)
// is idempotent via registerPredicateIdempotent.
import {
  type AbacContext,
  type AbacTarget,
  INTAKE_ROLE_KEYS,
  hasAdmittingClinicianRole,
  registerPredicateIdempotent,
} from "@wardenx/auth";
import { getSeam } from "../../bootstrap/index";
import { F2F_PERFORMER_ROLE_KEYS } from "./certification/f2f-performer";
import {
  MEDICAL_DIRECTOR_ROLE_KEY,
  PHYSICIAN_DESIGNEE_ROLE_KEY,
  type PhysicianAuthorityPort,
  type PhysicianSignerCapacity,
  dischargeOrderCapacities,
  heldSignerCapacities,
} from "./physician-authority";
import type { AdmissionAbacResolver } from "./routes/service";

/** The §4.6 predicate names M6 owns (registered into M3). `patient.scope` is excluded — it is M5's. */
export const M6_ABAC_PREDICATES = [
  "referral.scope",
  "admission.scope",
  "cti.is_hospice_md",
  "cti.is_attending",
  "f2f.is_hospice_clinician",
  "f2f.is_hospice_md_or_np",
  "f2f.window_override",
  "discharge.is_order_signer",
  "compliance.scope",
  "compliance.window_override",
  "admission_intake_scope",
  "admission_clinical_site_scope",
] as const;

/** The four §4.6 predicates the routes wire via `requireAbac` (pure over `context.roles`). */
export const M6_ROLE_PREDICATE_NAMES = {
  f2fAttest: "f2f.is_hospice_md_or_np",
  f2fWindowOverride: "f2f.window_override",
  dischargeOrderSigner: "discharge.is_order_signer",
  complianceWindowOverride: "compliance.window_override",
} as const;

// GAP-022 — 42 CFR 418.22 / spec R-F2F-01: only a hospice physician or NP attests the F2F. RN and
// RN case manager are NOT admitted (they were: an RN scheduled as performer could attest a recert F2F).
const MD_OR_NP = F2F_PERFORMER_ROLE_KEYS;

const UNSITED_ADMISSION_ROLES = [
  "intake_coordinator",
  "intake_supervisor",
  "admissions_team",
  "org_admin",
  "tenant_admin",
] as const;

/**
 * `admission_intake_scope` — the intake roles (M6 spec §6.1/§6.2). The SAME two keys
 * `INTAKE_DEFAULT_GRANTS` (packages/auth) grants the readmission-flow permissions to.
 */
const INTAKE_ROLES: readonly string[] = INTAKE_ROLE_KEYS;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidField = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && UUID.test(value) ? value : null;
};

/** Deps for M6's ABAC predicate resolvers (the slice injects an in-memory resolver + caseload stub). */
export interface AdmissionAbacDeps {
  /** Loads a resource's org-scoped owner facts (in-memory in the slice; Drizzle in prod). */
  readonly resolver: AdmissionAbacResolver;
  /** Caseload membership check (defaults to the boot-registered M5 `CaseloadProvider` seam). */
  readonly isInCaseload?: (q: {
    organizationId: string;
    userId: string;
    patientId: string;
  }) => Promise<boolean>;
  /** 42 CFR 418.26(b) — the IDG care-team fact for the route-40 signer (absent = role capacities only). */
  readonly physicianAuthority?: PhysicianAuthorityPort;
}

const hasRole = (context: AbacContext, role: string): boolean => context.roles.includes(role);

/**
 * `admission_clinical_site_scope`'s site test: the LOCATION decides when both the caller and the subject know one
 * (a nurse scoped to one location of a provider entity does not reach the entity's other locations); otherwise the
 * provider entity decides. A subject with no site at all never matches here.
 */
function inCallerSite(
  context: AbacContext,
  providerEntityId: string | null,
  locationId: string | null,
): boolean {
  if (locationId && context.locationIds.length > 0) return context.locationIds.includes(locationId);
  return providerEntityId !== null && context.providerEntityIds.includes(providerEntityId);
}
const targetId = (target: AbacTarget): string | null =>
  typeof target.id === "string" && target.id.length > 0 ? target.id : null;

/**
 * GAP-011 — the resource kinds `admission.scope`'s target `:id` may name. A route whose path param is
 * literally an admission id (the majority) omits `resourceKind` (defaults to `"admission"`); a route
 * keyed by a CHILD resource (election period/statement, CTI, F2F, LOC period, compliance window) sets
 * it explicitly via `requireAbac`'s `getTarget` (admission-routes.ts) so the predicate resolves scope
 * through the resource's OWNING admission rather than treating the child id as an admission id.
 */
export type AdmissionScopeResourceKind =
  | "admission"
  | "electionPeriod"
  | "electionStatement"
  | "cti"
  | "f2f"
  | "loc"
  | "complianceWindow";

function resourceKindOf(target: AbacTarget): AdmissionScopeResourceKind {
  const kind = target.resourceKind;
  return kind === "electionPeriod" ||
    kind === "electionStatement" ||
    kind === "cti" ||
    kind === "f2f" ||
    kind === "loc" ||
    kind === "complianceWindow"
    ? kind
    : "admission";
}

/**
 * Build M6's ten §4.6 predicate resolvers + `admission_intake_scope` + `admission_clinical_site_scope` over injected deps (pure factory — unit-tested with a fresh
 * registry; the boot path registers these into the shared registry via {@link registerAdmissionAbacPredicates}).
 */
export function buildAdmissionAbacPredicates(
  deps: AdmissionAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;
  const isInCaseload = deps.isInCaseload ?? ((q) => getSeam("CaseloadProvider").isInCaseload(q));

  /**
   * The §6.8 clinician arm of `admission.scope` for an UNSITED admission (see admissionScopeFor): an admitting
   * clinician reaches it only when (a) they opened it (`createdByUserId`, POST /admissions) or (c) the patient's chart
   * is sited at their site. A chart that has never been sited grants NOTHING here — otherwise every clinician with any
   * site scope reached every other site's pending admission of a brand-new patient. (No intended site is recorded at
   * creation — POST /admissions carries none — so there is no (b) arm.)
   */
  const unsitedAdmissionAtCallerSite = async (
    context: AbacContext,
    facts: { patientId: string; createdByUserId?: string | null },
  ): Promise<boolean> => {
    if (!hasAdmittingClinicianRole(context.roles)) return false;
    if (context.userId && facts.createdByUserId && facts.createdByUserId === context.userId)
      return true;
    if (context.providerEntityIds.length === 0 && context.locationIds.length === 0) return false;
    const chart = await resolver.loadPatientIntakeFacts(context.organizationId, facts.patientId);
    if (!chart) return false;
    return inCallerSite(context, chart.providerEntityId, chart.locationId);
  };

  /** Caseload-or-scope over an admission's patient (medical_director = org-wide). §4.6 admission.scope. */
  const admissionScopeFor = async (
    context: AbacContext,
    facts: { patientId: string; providerEntityId: string | null; createdByUserId?: string | null },
  ): Promise<boolean> => {
    if (hasRole(context, "medical_director")) return true; // org-wide
    if (
      facts.providerEntityId === null &&
      UNSITED_ADMISSION_ROLES.some((role) => hasRole(context, role))
    )
      return true;
    if (facts.providerEntityId && context.providerEntityIds.includes(facts.providerEntityId))
      return true;
    // An admitting clinician (§6.8) and an UNSITED admission — a new admission stays unsited until its election is
    // drafted, so without this the nurse / physician who just opened it could not reach it. Narrower than the
    // unsited-admission roles above (which reach every unsited admission of the org): only the clinician who opened
    // it, or one at the site the patient's chart is sited at. A SITED admission keeps the provider-entity arm alone.
    if (facts.providerEntityId === null && (await unsitedAdmissionAtCallerSite(context, facts)))
      return true;
    if (!context.userId) return false;
    return isInCaseload({
      organizationId: context.organizationId,
      userId: context.userId,
      patientId: facts.patientId,
    });
  };

  return {
    "referral.scope": async (context, target) => {
      const id = targetId(target);
      if (!id) return false;
      const facts = await resolver.loadReferral(context.organizationId, id);
      if (!facts) return false; // fail-closed (absent / cross-tenant)
      const orgWide = context.locationIds.length === 0; // no location restriction = org-wide
      if (orgWide) return true;
      // A null location is a referral's DOCUMENTED steady state ("org-level until an admission
      // activates them" — referrals.ts header): no write path assigns location_id at intake, so an
      // org-level referral is visible to every org member, location-scoped or not. Denying null here
      // 404'd every referral for every location-scoped user (2026-08-14 review). The location test
      // only bites once a location IS assigned.
      return facts.locationId === null || context.locationIds.includes(facts.locationId);
    },
    "admission.scope": async (context, target) => {
      const id = targetId(target);
      if (!id) return false;
      const facts = await (async () => {
        switch (resourceKindOf(target)) {
          case "admission":
            return resolver.loadAdmission(context.organizationId, id);
          case "electionPeriod":
            return resolver.loadElectionPeriodScope(context.organizationId, id);
          case "electionStatement":
            return resolver.loadElectionStatementScope(context.organizationId, id);
          case "cti":
            return resolver.loadCtiScope(context.organizationId, id);
          case "f2f":
            return resolver.loadF2fScope(context.organizationId, id);
          case "loc":
            return resolver.loadLocScope(context.organizationId, id);
          case "complianceWindow":
            return resolver.loadComplianceWindow(context.organizationId, id);
        }
      })();
      if (!facts) return false; // fail-closed (absent / cross-tenant)
      return admissionScopeFor(context, facts);
    },
    // The identity halves of the two CTI sign gates compare `context.userId` (a Better Auth user
    // id) against the CTI's `hospice_md_id`/`attending_md_id` — M40 physician-DIRECTORY uuids with
    // no FK (or join anywhere in the schema) to `users`. Until a user↔M40-physician link exists
    // that comparison can never be true in production, so the ROLE escape is the live path and must
    // name role keys that actually exist. The previous escapes (`acting_medical_director`,
    // `attending_physician_collaborator`) existed in no template, seed, or tenant — no CTI could be
    // signed, so no admission could be certified, in any org (2026-08-14 review). The keys below
    // follow the repo-wide clinical role-key convention (seed-staff-personas.ts, MD_OR_NP above).
    "cti.is_hospice_md": async (context, target) => {
      const id = targetId(target);
      if (!id) return false;
      const facts = await resolver.loadCti(context.organizationId, id);
      if (!facts) return false;
      // §418.22(c): the hospice side is certified by the medical director or the physician
      // designee (hospice physician) — NPs may never certify terminal illness.
      return (
        context.userId === facts.hospiceMedicalDirectorId ||
        hasRole(context, "medical_director") ||
        hasRole(context, "hospice_physician")
      );
    },
    "cti.is_attending": async (context, target) => {
      const id = targetId(target);
      if (!id) return false;
      const facts = await resolver.loadCti(context.organizationId, id);
      if (!facts) return false;
      // The attending signature is also a physician certification (§418.22(c)); when the patient's
      // chosen attending is the hospice's own physician, that user holds `hospice_physician`.
      return (
        (facts.attendingPhysicianId !== null && context.userId === facts.attendingPhysicianId) ||
        hasRole(context, "md") ||
        hasRole(context, "hospice_physician")
      );
    },
    "f2f.is_hospice_clinician": async (context, target) => {
      const id = targetId(target);
      if (!id) return false;
      const facts = await resolver.loadF2f(context.organizationId, id);
      if (!facts) return false;
      return context.userId === facts.scheduledClinicianId || hasRole(context, "medical_director");
    },
    "f2f.is_hospice_md_or_np": async (context) => MD_OR_NP.some((r) => hasRole(context, r)),
    "f2f.window_override": async (context) => hasRole(context, "compliance_officer"),
    "discharge.is_order_signer": async (context, target) => {
      const id = targetId(target);
      const facts = id ? await resolver.loadDischargeSigning(context.organizationId, id) : null;
      // An unknown / cross-tenant discharge: admit a physician-role caller so the service answers 404
      // (the pre-418.26 predicate was role-only and never turned "absent" into 403).
      if (!facts)
        return (
          hasRole(context, MEDICAL_DIRECTOR_ROLE_KEY) ||
          hasRole(context, PHYSICIAN_DESIGNEE_ROLE_KEY)
        );
      const allowed: readonly PhysicianSignerCapacity[] = facts.externalDeath
        ? ["medical_director"]
        : dischargeOrderCapacities(facts.dischargeDate);
      const idgPhysicianOfPatient =
        allowed.includes("idg_physician_member") &&
        facts.patientId !== null &&
        !!context.userId &&
        deps.physicianAuthority !== undefined
          ? (
              await deps.physicianAuthority.signerFacts(
                context.organizationId,
                context.userId,
                facts.patientId,
              )
            ).idgPhysicianOfPatient
          : false;
      return heldSignerCapacities({ roleKeys: context.roles, idgPhysicianOfPatient }).some((c) =>
        allowed.includes(c),
      );
    },
    "compliance.scope": async (context, target) => {
      if (hasRole(context, "compliance_officer")) return true; // org-wide
      const id = targetId(target);
      if (!id) return false;
      const facts = await resolver.loadComplianceWindow(context.organizationId, id);
      if (!facts) return false;
      return admissionScopeFor(context, {
        patientId: facts.patientId,
        providerEntityId: facts.providerEntityId,
        createdByUserId: facts.createdByUserId ?? null,
      });
    },
    "compliance.window_override": async (context) => hasRole(context, "compliance_officer"),
    // An intake user reaches a patient who is NOT on their caseload for the new-admission / readmission work
    // only: the caller holds an intake role (`context.roles`, server-assembled from M3 grants — never a
    // header), the patient is a patient of the caller's org (absent / cross-tenant → deny), and the patient has
    // no `active` / `on_hold` admission (an ongoing stay belongs to its care team). Target: `patientId`, or
    // `admissionId` (the readmission-context route, keyed by the earlier stay) resolved to its patient.
    // Composed (OR) beside the routes' own scope predicate on exactly the readmission-flow routes.
    admission_intake_scope: async (context, target) => {
      if (!INTAKE_ROLES.some((role) => hasRole(context, role))) return false;
      const admissionId = uuidField(target, "admissionId");
      const patientId = admissionId
        ? ((await resolver.loadAdmission(context.organizationId, admissionId))?.patientId ?? null)
        : uuidField(target, "patientId");
      if (!patientId) return false;
      const facts = await resolver.loadPatientIntakeFacts(context.organizationId, patientId);
      return facts !== null && !facts.hasActiveOrOnHoldAdmission;
    },
    // A nurse, physician, NP or PA (ADMITTING_CLINICIAN_ROLE_KEYS, packages/auth — the same roles migration 0379
    // grants `admission.create` to) opens a new admission or a readmission for a patient of THEIR OWN SITE:
    //   • an admitting clinician role in `context.roles` (server-assembled from M3 grants — never a header), and a
    //     site scope (`context.providerEntityIds` / `.locationIds`, from the membership);
    //   • the patient is a patient of the caller's org (absent / cross-tenant → deny) with no `active` / `on_hold`
    //     admission (an ongoing stay is its care team's, reached through `caseload_or_scope`);
    //   • the patient's site — M5 stamps the chart from the activated admission — is the caller's ({@link inCallerSite}).
    //     A chart with no site falls back to the named earlier stay's site (a legacy unsited chart); a BRAND-NEW
    //     patient (no admission in this org at all, so never sited) is placed by their latest site-naming referral;
    //     only a patient with no site anywhere (no referral site either) is reachable by any admitting clinician who
    //     has a site scope — create-time only: the pending admission is then reachable by its creator alone.
    // Target: `patientId`, and/or `admissionId` (the readmission-context route, keyed by the earlier stay) /
    // `priorAdmissionId` (POST /admissions' `readmittedFromAdmissionId`). When both a patient and a stay are named the
    // stay must be THAT patient's (a stay can never lend its site to another chart). Composed (OR) beside the routes'
    // own scope predicate and `admission_intake_scope` on exactly the new-admission / readmission routes.
    admission_clinical_site_scope: async (context, target) => {
      if (!hasAdmittingClinicianRole(context.roles)) return false;
      if (context.providerEntityIds.length === 0 && context.locationIds.length === 0) return false;
      const stayField = target.admissionId !== undefined ? "admissionId" : "priorAdmissionId";
      const stayId = uuidField(target, stayField);
      if (target[stayField] !== undefined && !stayId) return false;
      const stay = stayId ? await resolver.loadAdmission(context.organizationId, stayId) : null;
      if (stayId && !stay) return false; // absent / cross-tenant stay
      if (target.patientId !== undefined && !uuidField(target, "patientId")) return false;
      const patientId = uuidField(target, "patientId") ?? stay?.patientId ?? null;
      if (!patientId) return false;
      if (stay && stay.patientId !== patientId) return false;
      const facts = await resolver.loadPatientIntakeFacts(context.organizationId, patientId);
      if (!facts || facts.hasActiveOrOnHoldAdmission) return false;
      if (facts.providerEntityId !== null || facts.locationId !== null)
        return inCallerSite(context, facts.providerEntityId, facts.locationId);
      if (stay) return inCallerSite(context, stay.providerEntityId, stay.locationId ?? null);
      if (facts.hasAnyAdmission) return false;
      // A never-admitted patient: placed at the site of their latest site-naming referral when there is one.
      if (facts.referralProviderEntityId !== null || facts.referralLocationId !== null)
        return inCallerSite(context, facts.referralProviderEntityId, facts.referralLocationId);
      // No site anywhere (a chart registered directly, no referral): create-time reach for any admitting clinician
      // with a site scope. Once opened, the admission is reachable only by its creator until it is sited.
      return true;
    },
  };
}

/**
 * Register M6's ten §4.6 ABAC predicate resolvers + `admission_intake_scope` into M3's shared registry (M6-T06; idempotent).
 * Call at boot after the M5 `CaseloadProvider` seam is registered (admission/compliance scope resolve
 * caseload through it). Re-boot (tests) skips already-registered names (single-owner / no-clear).
 */
export function registerAdmissionAbacPredicates(deps: AdmissionAbacDeps): void {
  const predicates = buildAdmissionAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
}
