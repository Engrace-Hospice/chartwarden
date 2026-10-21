// apps/backend/src/modules/09-assessments/capture-siting.ts — resolve the §3.3 capture SITING
// (`provider_entity_id`/`location_id`) an assessment insert denormalizes at record-time.
//
// SOURCE OF TRUTH. The siting is the capture's ADMISSION anchor — the `admissionId` every
// record/correct already carries — whose PE/location live on the M6-owned `admission` row. M9 may not
// import M6's schema (architecture §11), so the resolution goes through the published M6 seam:
// `getSeam("AdmissionStatusReader").getAdmissionSummary(organizationId, admissionId)` (the M6 Drizzle store answers
// real rows under the consumer's ambient request context / RLS).
//
// WHAT THE SEAM CAN AND CANNOT ANSWER (verified against @chartwarden/types §4.7):
//   · provider_entity_id — carried by AdmissionSummary → resolved here.
//   · location_id — carried by NO published seam today. AdmissionSummary and AdmissionCensusEntry
//     expose only providerEntityId; the M5 patient spine has a `location_id` column but PatientIdentity
//     (the only M5 read seam) carries neither PE nor location. Extending AdmissionSummary is an
//     M6 + @chartwarden/types change outside this module. Until a seam carries it, `location_id` stays
//     NULL — the row is deliberately UNSITED for location rather than an invented value.
//
// FALLBACK. When the seam cannot answer — deny-stub (NotImplementedError), unregistered seam
// (SeamError), unknown/cross-tenant admission (AdmissionNotFoundError / RLS-empty), a draft admission
// whose PE is still null (M6's AdmissionSeamDataGapError), or no ambient request scope
// (withOrgContextFromRequest throws) — the resolver returns the UNSITED sentinel instead of
// propagating: recording clinical data must never be blocked by a reporting denormalization, and a
// NULL siting is the honest "could not resolve" (the M9 seam's latest-read then names the gap loudly
// via AssessmentSeamDataGapError — fail-closed downstream, never fabricated here).
//
// TENANT/PATIENT GUARD. The summary's organizationId/patientId must match the caller's — a mismatch
// (caller sent another patient's admission id) resolves UNSITED rather than mis-siting the row.
import type { AdmissionSummary } from "@chartwarden/types";
import { getSeam } from "../../bootstrap/index";

/** The minimal M39 surface this file calls — structurally typed so M9 takes no `@chartwarden/consent`
 *  import edge (the M7 `seams/drizzle-store.ts` / M16 `ConsentEvaluatorShape` precedent). */
interface ConsentEvaluatorShape {
  evaluate(args: {
    organizationId: string;
    patientId: string;
    consentType: string;
    sessionContext: { sessionClass: string; membershipId?: string };
    callerModule: string;
  }): Promise<{ allowed: boolean }>;
  evaluateForIngressRedaction(args: {
    organizationId: string;
    patientId: string;
    callerModule: string;
    callerRoute?: string;
  }): Promise<{ redactSubstanceUseDisorderFields: boolean }>;
}

/**
 * GAP-016 — the §10 DPOA proxy-attribution fact, through M39's `ConsentEvaluator` seam. Lives beside the
 * admission-anchor resolution because both are the same kind of thing: a cross-module fact the §10 gate
 * chain needs and the route contract does not carry. Deliberately the SAME call shape M7's `dpoa_active`
 * predicate uses (`defaultConsentActiveChecker`, GAP-013) so the two answers cannot drift.
 *
 * Fail-CLOSED on a seam error: a proxy-attributed clinical record whose authorization could not be
 * verified is exactly the write §4.4 wants refused.
 */
export async function dpoaConsentActiveViaSeam(
  organizationId: string,
  patientId: string,
): Promise<boolean> {
  try {
    const evaluator = getSeam("ConsentEvaluator") as unknown as ConsentEvaluatorShape;
    const res = await evaluator.evaluate({
      organizationId,
      patientId,
      consentType: "dpoa_healthcare",
      sessionContext: { sessionClass: "staff" },
      callerModule: "m9",
    });
    return res.allowed;
  } catch {
    return false;
  }
}

/**
 * GAP-017 — the D10 / M09-F05 chart-read disclosure gate: must this patient's SUD-context content stay
 * redacted for an in-org chart read? Answered by M39's `evaluateForIngressRedaction`, whose
 * `redactSubstanceUseDisorderFields` flips to `false` exactly when an active `42_cfr_part_2_release`
 * is on file for the patient — the un-redaction condition §4.4/§9.1 specifies.
 *
 * The AIMS gate was a BLANKET, unconditional redaction: `scaleType === "aims" && sudContext` with no
 * consent read at all, so a Part 2 release the patient had signed, and the org had recorded, changed
 * nothing — the row stayed hidden from every caller forever. That is the safe direction to fail, but a
 * gate that cannot open is not a gate.
 *
 * PATIENT-SCOPED, NOT ACTOR-SCOPED — still deliberate, but no longer because it is the only thing M39
 * can answer. When this was written it was: `evaluateForDisclosure` keys on an EXTERNAL recipient, and
 * M39 modelled no internal staff actor as a Part 2 recipient, so "may THIS clinician see it" had no
 * backing fact. `workforce_member` recipients (mig 0209) + `evaluateForInternalAccess` built that fact,
 * and the per-actor decision now lives one layer up, in the `sud_disclosure_allowed` predicate M7
 * registers and M9's routes compose (abac-predicates.ts) — the same seam call, resolved where the actor
 * actually is.
 *
 * It stays patient-scoped HERE because the M9 read service's signatures carry no actor at all
 * (`listAssessments(organizationId, patientId)`), and the honest choices are to thread one through the
 * whole `AssessmentRouteService` interface or to let the route gate own the actor question. Threading a
 * `null` membership instead would be the worst of both: against a workforce-restricted release it reads
 * as `actor_unidentified` and redacts the chart from the very clinicians the patient named. So this
 * layer answers "is disclosure of this patient's SUD content authorized in this org at all", and the
 * route's RBAC + `sud_disclosure_allowed` + `caseload_or_scope` answer "by whom".
 *
 * Fail-CLOSED on any seam error (unregistered, deny-stub, evaluator throw): redact.
 */
export async function sudRedactionRequiredViaSeam(
  organizationId: string,
  patientId: string,
): Promise<boolean> {
  try {
    const evaluator = getSeam("ConsentEvaluator") as unknown as ConsentEvaluatorShape;
    const res = await evaluator.evaluateForIngressRedaction({
      organizationId,
      patientId,
      callerModule: "m9",
    });
    return res.redactSubstanceUseDisorderFields;
  } catch {
    return true;
  }
}

/** The resolved (nullable) siting pair an insert denormalizes onto `clinical_assessment`. */
export interface ResolvedCaptureSiting {
  readonly providerEntityId: string | null;
  readonly locationId: string | null;
}

/** The documented "could not resolve — leave the row unsited" outcome (never an invented siting). */
export const UNSITED_CAPTURE: ResolvedCaptureSiting = { providerEntityId: null, locationId: null };

/**
 * The §10 admission-anchor FACTS the record/correct gate chain needs (GAP-016) — `null` when the anchor
 * could not be resolved at all (absent seam, unknown admission, or an admission belonging to another
 * org/patient). Carried on the SAME `AdmissionSummary` the siting is projected from, so both come from
 * one seam call rather than two round-trips per write.
 */
export interface ResolvedAdmissionAnchor {
  readonly status: string;
  /** LocalDate (`YYYY-MM-DD`) of activation; null while the admission is still pre-activation. */
  readonly activatedAt: string | null;
}

/** What one seam call yields: the denormalization siting AND the gate facts. */
export interface ResolvedCaptureAnchor {
  readonly siting: ResolvedCaptureSiting;
  readonly anchor: ResolvedAdmissionAnchor | null;
  /**
   * #44 — set when the seam REFUSED to project the admission (a missing required fact), as opposed
   * to the admission being absent or another tenant's. Both used to collapse into `anchor: null`,
   * so the §10 gate reported "Patient's admission is not active" for an admission whose status was
   * verifiably `active` — telling a clinician something false about the chart and hiding the real
   * cause. The siting half stays fail-OPEN regardless; only the gate distinguishes them.
   */
  readonly projectionGap?: string;
}

/** Port the route service resolves siting + anchor facts through (seam-backed in prod; injectable). */
export interface AssessmentSitingResolver {
  resolve(
    organizationId: string,
    patientId: string,
    admissionId: string,
  ): Promise<ResolvedCaptureSiting>;
  /**
   * GAP-016 — siting AND the §10 gate facts from one `getAdmissionSummary` call. Separate from
   * {@link resolve} so the existing siting-only callers (and their tests) keep their contract.
   */
  resolveAnchor(
    organizationId: string,
    patientId: string,
    admissionId: string,
  ): Promise<ResolvedCaptureAnchor>;
}

/**
 * The seam's own refusal message when it declines to project a row (`AdmissionSeamDataGapError`), or
 * `undefined` for any other throw. Matched structurally by `name` rather than by importing M6's
 * error class — M9 may not import M6's internals, and a seam contract is what it publishes.
 */
function gapReason(error: unknown): string | undefined {
  const named = error as { name?: unknown; message?: unknown } | null;
  if (named?.name !== "AdmissionSeamDataGapError") return undefined;
  return typeof named.message === "string" ? named.message : "admission projection gap";
}

/**
 * The production resolver over M6's published `AdmissionStatusReader` seam (lazy `getSeam` per call —
 * boot order safe). See the file header for the exact chain + why `locationId` is always null today.
 */
export function createSeamAssessmentSitingResolver(): AssessmentSitingResolver {
  async function load(
    organizationId: string,
    patientId: string,
    admissionId: string,
  ): Promise<{ summary: AdmissionSummary | null; gap?: string }> {
    let summary: AdmissionSummary;
    try {
      const reader = getSeam("AdmissionStatusReader");
      // Keep compatibility with older one-argument test/adaptor readers while production readers
      // use the tenant-explicit two-argument contract.
      summary =
        reader.getAdmissionSummary.length < 2
          ? await (
              reader.getAdmissionSummary as unknown as (id: string) => Promise<AdmissionSummary>
            )(admissionId)
          : await reader.getAdmissionSummary(organizationId, admissionId);
    } catch (error) {
      // Keep WHY. A projection gap (the store refusing to fabricate a missing fact) is an entirely
      // different operational problem from an unknown admission, and callers must be able to say so.
      return { summary: null, gap: gapReason(error) };
    }
    // An admission that is not this org's/patient's is treated as unresolvable — it must never site a
    // row, and (GAP-016) it must never satisfy the anchor gate either.
    if (summary.organizationId !== organizationId || summary.patientId !== patientId) {
      return { summary: null };
    }
    return { summary };
  }

  const resolveAnchor: AssessmentSitingResolver["resolveAnchor"] = async (
    organizationId,
    patientId,
    admissionId,
  ) => {
    const { summary, gap } = await load(organizationId, patientId, admissionId);
    if (!summary) {
      return { siting: UNSITED_CAPTURE, anchor: null, ...(gap ? { projectionGap: gap } : {}) };
    }
    return {
      // task-11 — AdmissionSummary carries the admission's location anchor (optional field; honestly
      // null until activation sites the admission).
      siting: {
        providerEntityId: summary.providerEntityId,
        locationId: summary.locationId ?? null,
      },
      anchor: { status: summary.status, activatedAt: summary.activatedAt ?? null },
    };
  };

  return {
    async resolve(organizationId, patientId, admissionId) {
      return (await resolveAnchor(organizationId, patientId, admissionId)).siting;
    },
    resolveAnchor,
  };
}
