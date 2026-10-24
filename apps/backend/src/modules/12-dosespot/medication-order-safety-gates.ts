// apps/backend/src/modules/12-dosespot/medication-order-safety-gates.ts — GAP-036: the two clinical-safety
// gates `requestSignature` owes (§2.2 D2: "allergy-check passes; SUD-consent gate passes for SUD-treatment
// meds"). The production backend used to hard-code both to `true`.
//
// Both gates are pure over injected ports and FAIL CLOSED on every uncertainty (a throw, an unregistered
// seam, a malformed verdict, unreadable patient data): an unanswerable safety question denies the signature
// request, it never reads as "safe".
//
//   · SUD consent (§7.8 / 42 CFR Part 2) — for an SUD-treatment medication, M39's `ConsentEvaluator`
//     `evaluateForInternalAccess` answers the PER-ACTOR question "may THIS staff member handle this patient's
//     Part 2 content" (the same method every internal Part 2 gate resolves through). The actor is the
//     SESSION's membership id, never a body field. M12 `dependsOn` has no M39 edge, so the seam is read
//     opaquely through the M1 registry and cast to the locally-declared minimum {@link ConsentGatePort}.
//   · Allergy — M5's `PatientAllergyReader` seam. Every non-`entered_in_error` row counts, UNVERIFIED rows
//     included. Matching is by normalized generic (brand -> generic), by drug class ("opioids",
//     "penicillins") and by documented cross-reactivity — the pure matcher in `@chartwarden/dosespot`
//     (`allergy/`). A conflict is NOT a hard stop: a prescriber-eligible actor with a FRESH step-up may
//     acknowledge it with a written reason (spec §6 "Allergy banner"); unreadable data is never overridable.
import { isSudTreatmentDrug } from "@chartwarden/dosespot";
import { type AllergyMatch, matchDrugToAllergy } from "@chartwarden/dosespot";
import { ChartWardenError, type PatientAllergyReader } from "@chartwarden/types";
import { getSeam } from "../../bootstrap/index";

/** The M12-side structural projection of M39's `ConsentEvaluator.evaluateForInternalAccess`. */
export interface ConsentGatePort {
  evaluateForInternalAccess(args: {
    organizationId: string;
    patientId: string;
    actor: { membershipId: string | null };
    callerModule: string;
    callerRoute?: string;
  }): Promise<{ redactSubstanceUseDisorderFields: boolean }>;
}

/** The `callerModule` token M12 identifies itself with on the M39 audit trail. */
const CONSENT_CALLER_MODULE = "m12";
const CONSENT_CALLER_ROUTE = "POST /api/v1/medication-orders/:id/request-signature";

/**
 * SUD-treatment medications (the §7.8 / spec §6 Part 2 table): the list lives in `@chartwarden/dosespot`
 * (`classes/sud-treatment-drugs.ts`, the single source of truth shared with the 0340 backfill migration);
 * `medication_order.is_sud_treatment` is derived from it.
 */
export { isSudTreatmentDrug };

/** Default resolver: the registered M39 evaluator, read opaquely (a boot without M39 resolves the deny-stub, which throws). */
export const resolveConsentGatePort = (): ConsentGatePort =>
  getSeam("ConsentEvaluator") as ConsentGatePort;

/** Default resolver: M5's allergy reader (the deny-stub throws until M5 registers the real one). */
export const resolveAllergyReader = (): PatientAllergyReader => getSeam("PatientAllergyReader");

/**
 * §7.8 — is the SUD-treatment-medication consent gate satisfied for this actor? A non-SUD order passes
 * without consulting M39. For an SUD order the evaluator must answer an explicit `false` on
 * `redactSubstanceUseDisorderFields`; anything else (no release, a release naming other staff, an
 * unidentified actor, a throw, an unresolvable seam, a malformed verdict) denies.
 */
export async function sudConsentSatisfied(input: {
  readonly isSudTreatment: boolean;
  readonly organizationId: string;
  readonly patientId: string;
  /** The SESSION's membership id (server-derived) — never read off the request body. */
  readonly actorMembershipId: string | null;
  readonly resolveEvaluator?: () => ConsentGatePort;
}): Promise<boolean> {
  if (!input.isSudTreatment) return true;
  try {
    const evaluator = (input.resolveEvaluator ?? resolveConsentGatePort)();
    const verdict = await evaluator.evaluateForInternalAccess({
      organizationId: input.organizationId,
      patientId: input.patientId,
      actor: { membershipId: input.actorMembershipId },
      callerModule: CONSENT_CALLER_MODULE,
      callerRoute: CONSENT_CALLER_ROUTE,
    });
    return verdict?.redactSubstanceUseDisorderFields === false;
  } catch {
    return false; // fail-closed — consent not confirmable ⇒ no signature request
  }
}

/** One recorded allergy that conflicts with the ordered drug (non-PHI projection: class wording, never the allergy text). */
export interface AllergyGateMatch {
  readonly kind: AllergyMatch["kind"];
  readonly classId: string | null;
  readonly label: string | null;
  readonly severity: "mild" | "moderate" | "severe" | "unknown" | null;
}

export type AllergyGateResult =
  | { readonly status: "clear" }
  | { readonly status: "conflict"; readonly matches: readonly AllergyGateMatch[] }
  | { readonly status: "unreadable" };

/** Does one free-text allergy line conflict with this drug (class, brand/generic, cross-reactivity, name)? */
export function drugConflictsWithAllergy(drugName: string, allergenText: string): boolean {
  return matchDrugToAllergy(drugName, allergenText) !== null;
}

const isAllergyRow = (a: unknown): a is { allergenText: string; severity?: unknown } =>
  typeof a === "object" &&
  a !== null &&
  typeof (a as { allergenText?: unknown }).allergenText === "string";

const SEVERITIES = new Set(["mild", "moderate", "severe", "unknown"]);

/**
 * Evaluate the allergy gate for this order. FAIL-CLOSED: unreadable allergy data (a `null` for an unknown
 * patient, a throw, an unresolvable seam, a malformed row, a blank drug name) is `unreadable`, never
 * `clear`. A recorded allergy that conflicts blocks, verified or not. An empty list for a readable patient
 * is `clear` (M5 has no separate "allergies reviewed" attestation yet).
 */
export async function evaluateAllergyGate(input: {
  readonly organizationId: string;
  readonly patientId: string;
  readonly drugName: string;
  readonly resolveReader?: () => PatientAllergyReader;
}): Promise<AllergyGateResult> {
  if (input.drugName.trim().length === 0) return { status: "unreadable" };
  try {
    const reader = (input.resolveReader ?? resolveAllergyReader)();
    const allergies = await reader.activeAllergies({
      organizationId: input.organizationId,
      patientId: input.patientId,
    });
    if (allergies === null || !Array.isArray(allergies)) return { status: "unreadable" };
    const matches: AllergyGateMatch[] = [];
    for (const a of allergies) {
      if (!isAllergyRow(a)) return { status: "unreadable" };
      const m = matchDrugToAllergy(input.drugName, a.allergenText);
      if (m === null) continue;
      const severity =
        typeof a.severity === "string" && SEVERITIES.has(a.severity) ? a.severity : null;
      matches.push({
        kind: m.kind,
        classId: m.classId,
        label: m.label,
        severity: severity as AllergyGateMatch["severity"],
      });
    }
    return matches.length === 0 ? { status: "clear" } : { status: "conflict", matches };
  } catch {
    return { status: "unreadable" };
  }
}

/** Boolean view of {@link evaluateAllergyGate}: true only for `clear`. */
export async function allergyCheckPasses(
  input: Parameters<typeof evaluateAllergyGate>[0],
): Promise<boolean> {
  return (await evaluateAllergyGate(input)).status === "clear";
}

/**
 * Minimum acknowledgement-reason length. The M12 spec requires "reason text" without a length; this matches
 * the module's other clinician-reason floor (`denialReason` minLength 10) until the spec states one.
 */
export const ALLERGY_OVERRIDE_MIN_REASON_LENGTH = 10;
export const ALLERGY_OVERRIDE_MAX_REASON_LENGTH = 1000;

export type AllergyOverrideDecision =
  | { readonly outcome: "proceed"; readonly override: null }
  | {
      readonly outcome: "proceed";
      readonly override: { readonly reason: string; readonly matches: readonly AllergyGateMatch[] };
    }
  | {
      readonly outcome: "blocked";
      readonly gate: Extract<AllergyGateResult, { status: "conflict" }>;
    }
  | { readonly outcome: "step_up_required" }
  | { readonly outcome: "unreadable" };

/**
 * Decide the gate verdict + the supplied acknowledgement. The caller has ALREADY established that the actor
 * is prescriber-eligible (the lifecycle machine refuses otherwise); `stepUpFresh` is resolved server-side
 * from the session, never a body claim. An unreadable list is never overridable (nothing was seen to
 * acknowledge); a conflict proceeds only with a trimmed reason of the minimum length AND a fresh step-up.
 */
export function resolveAllergyOverride(
  gate: AllergyGateResult,
  supplied: { readonly reason: string; readonly stepUpFresh: boolean } | undefined,
): AllergyOverrideDecision {
  if (gate.status === "clear") return { outcome: "proceed", override: null };
  if (gate.status === "unreadable") return { outcome: "unreadable" };
  const reason = supplied?.reason.trim() ?? "";
  if (supplied === undefined || reason.length < ALLERGY_OVERRIDE_MIN_REASON_LENGTH)
    return { outcome: "blocked", gate };
  if (!supplied.stepUpFresh) return { outcome: "step_up_required" };
  return { outcome: "proceed", override: { reason, matches: gate.matches } };
}

/** The 422 for an unacknowledged conflict / unreadable list. Class wording only: the allergy text is PHI. */
export function allergyGateError(
  gate: Exclude<AllergyGateResult, { status: "clear" }>,
): ChartWardenError {
  if (gate.status === "unreadable")
    return new ChartWardenError(
      "ALLERGY_CHECK_NOT_PASSED",
      "the patient's allergy list could not be read, so the allergy check cannot pass",
      422,
    );
  const labels = [...new Set(gate.matches.map((m) => m.label ?? "the ordered drug"))];
  const severe = gate.matches.some((m) => m.severity === "severe");
  return new ChartWardenError(
    "ALLERGY_CHECK_NOT_PASSED",
    `the ordered drug conflicts with a recorded allergy (${labels.join(", ")}${severe ? "; severe" : ""}); ` +
      `a prescriber may acknowledge it by supplying allergyOverrideReason (minimum ${ALLERGY_OVERRIDE_MIN_REASON_LENGTH} characters, recent step-up required)`,
    422,
    [
      {
        field: "allergyOverrideReason",
        code: "ACKNOWLEDGEMENT_REQUIRED",
        message: `allergy class: ${labels.join(", ")}`,
      },
    ],
  );
}
