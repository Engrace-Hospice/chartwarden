// apps/backend/src/modules/15-discipline-care-plans/routes/disclosure.ts — M15-T06 (§7.8 / §7.9 / D9).
//
// The two CONFIDENTIALITY gates every M15 read path resolves BEFORE it queries, so the filter can be
// applied in SQL rather than after the fact (§7.8: "SQL-level WHERE filter via the ABAC predicate, not a
// UI hide"; §8.6 Information-disclosure row: "never post-fetch redaction"):
//
//   • SUD (42 CFR Part 2) — a goal with `sud_related = true` or an assessment with `sud_flag = true` is
//     visible only to a caller with a satisfied `42_cfr_part_2_release` consent (M39), or the patient's
//     assigned RN Case Manager (the §7.6 M7 precedent this reuses verbatim).
//   • FAMILY VIOLENCE (§7.9 / D9) — an assessment with `family_violence_flag = true` is visible to the
//     "MSW + RN Case Manager" caseload default only; a portal / caregiver / external-collaborator session
//     never sees it, whatever its roles.
//
// Both verdicts feed the `redacted_categories` response envelope (§7.8) so the UI can say "some content
// has been redacted" WITHOUT revealing which patient facts exist — the count of withheld rows is never
// surfaced either, only the category token.
//
// FAIL-CLOSED (§8.7 / M15-F11): M39 is resolved lazily through the M1 seam registry at CALL time; while it
// is a deny-stub — or if it throws — the gate REDACTS. A consent outage narrows what a clinician sees; it
// never widens it. The one exception is the RN-Case-Manager fast path, which is a role fact from the M2
// session and needs no consent round-trip.
//
// The seam is resolved through `getSeam` and cast to the minimal shape M15 calls (the M25 →
// TerminologyProvider precedent): `ConsentEvaluator` is `unknown` in the leaf SeamContracts, and casting
// structurally keeps M15 off a `@wardenx/consent` import edge it does not have.
import { getSeam } from "../../../bootstrap/index";
import type { M15ReadActor } from "./actor";

/** The M39 surface M15 calls — structurally typed so no `@wardenx/consent` import edge is taken. */
interface ConsentEvaluatorShape {
  evaluate(args: {
    organizationId: string;
    patientId: string;
    consentType: string;
    sessionContext: { sessionClass: string };
    callerModule: string;
    callerRoute?: string;
  }): Promise<{ allowed: boolean }>;
  evaluateForIngressRedaction(args: {
    organizationId: string;
    patientId: string;
    callerModule: string;
  }): Promise<{ redactFamilyViolenceFields: boolean }>;
}

/** The confidentiality categories an M15 read may withhold (§7.8 `redacted_categories`). */
export type RedactedCategory = "sud" | "family_violence";

/** The resolved per-request disclosure posture the read path filters and reports with. */
export interface DisclosureDecision {
  /** May the caller see `sud_related` / `sud_flag` rows? */
  readonly sudAllowed: boolean;
  /** May the caller see `family_violence_flag` rows? */
  readonly familyViolenceAllowed: boolean;
  /** The §7.8 envelope field — categories the caller is NOT cleared for on this patient. */
  readonly redactedCategories: readonly RedactedCategory[];
}

/** The role that reads a patient's Part 2 content without a consent round-trip (§7.6 / M7 precedent). */
const RN_CASE_MANAGER_ROLE = "rn_case_manager";
/** §4.5 / D9 — the family-violence caseload default ("MSW + RN Case Manager only"). */
const FAMILY_VIOLENCE_DEFAULT_ROLES = [
  "msw",
  RN_CASE_MANAGER_ROLE,
  "clinical_supervisor",
  "director_of_nursing",
] as const;
/** Session classes that never receive either category, whatever their roles (§7.9). */
const NON_DISCLOSURE_SESSION_CLASSES = [
  "patient_portal",
  "caregiver_portal",
  "external_collaborator",
] as const;

/** The port the gate resolves M39 through (injected in tests; the seam registry in prod). */
export interface DisclosurePort {
  /** Is a `42_cfr_part_2_release` consent satisfied for this patient/session right now? */
  part2ReleaseActive(input: {
    organizationId: string;
    patientId: string;
    sessionClass: string;
  }): Promise<boolean>;
  /** Does M39 additionally require family-violence content to be redacted for this patient? */
  familyViolenceRedacted(input: { organizationId: string; patientId: string }): Promise<boolean>;
}

/** The production port — lazy `getSeam` per call (registration order is irrelevant), fail-CLOSED on throw. */
export const seamDisclosurePort: DisclosurePort = {
  async part2ReleaseActive({ organizationId, patientId, sessionClass }) {
    try {
      const evaluator = getSeam("ConsentEvaluator") as ConsentEvaluatorShape;
      const verdict = await evaluator.evaluate({
        organizationId,
        patientId,
        consentType: "42_cfr_part_2_release",
        sessionContext: { sessionClass },
        callerModule: "m15",
      });
      return verdict.allowed === true;
    } catch {
      return false; // §8.7 — an unbound/erroring M39 REDACTS, never discloses
    }
  },
  async familyViolenceRedacted({ organizationId, patientId }) {
    try {
      const evaluator = getSeam("ConsentEvaluator") as ConsentEvaluatorShape;
      const verdict = await evaluator.evaluateForIngressRedaction({
        organizationId,
        patientId,
        callerModule: "m15",
      });
      return verdict.redactFamilyViolenceFields === true;
    } catch {
      return true; // §8.7 — treat an M39 outage as "redact"
    }
  },
};

/**
 * Resolve the §7.8 / §7.9 disclosure posture for one actor reading one patient's discipline content.
 * Called ONCE per read request; the verdict then drives the SQL predicates (`sud_related = false`,
 * `family_violence_flag = false`) and the `redacted_categories` envelope — the rows a caller may not see
 * are never fetched, so they cannot leak through a serializer or a log line.
 */
export async function resolveDisclosure(
  actor: M15ReadActor,
  patientId: string,
  port: DisclosurePort = seamDisclosurePort,
): Promise<DisclosureDecision> {
  const restrictedSession = NON_DISCLOSURE_SESSION_CLASSES.includes(actor.sessionClass as never);
  const isRnCaseManager = actor.roles.includes(RN_CASE_MANAGER_ROLE);

  // The fail-CLOSED posture is enforced HERE, not only inside the default port: an injected or future
  // port that throws must still REDACT, never 500 the read and never fall through to "allowed" (§8.7).
  const probe = async (run: () => Promise<boolean>, onError: boolean): Promise<boolean> => {
    try {
      return await run();
    } catch {
      return onError;
    }
  };

  const sudAllowed = restrictedSession
    ? false
    : isRnCaseManager ||
      (await probe(
        () =>
          port.part2ReleaseActive({
            organizationId: actor.organizationId,
            patientId,
            sessionClass: actor.sessionClass,
          }),
        false, // no consent verdict → not disclosable
      ));

  const familyViolenceRoleDefault = FAMILY_VIOLENCE_DEFAULT_ROLES.some((r) =>
    actor.roles.includes(r),
  );
  const familyViolenceAllowed =
    !restrictedSession &&
    familyViolenceRoleDefault &&
    !(await probe(
      () => port.familyViolenceRedacted({ organizationId: actor.organizationId, patientId }),
      true, // no verdict → treat as "redact"
    ));

  const redactedCategories: RedactedCategory[] = [];
  if (!sudAllowed) redactedCategories.push("sud");
  if (!familyViolenceAllowed) redactedCategories.push("family_violence");
  return { sudAllowed, familyViolenceAllowed, redactedCategories };
}

/**
 * The patient-summary posture (route 3, §4.1 "loosened `caseload_or_scope`"): the shareable summary is
 * ALWAYS stripped of both confidential categories, whoever reads it — a portal user and a surveyor get
 * the same body (§7.9). Declared as its own function so the summary route cannot accidentally inherit the
 * full-read gate.
 */
export const SUMMARY_DISCLOSURE: DisclosureDecision = {
  sudAllowed: false,
  familyViolenceAllowed: false,
  redactedCategories: ["sud", "family_violence"],
};

/**
 * §4.1 `caseload_or_scope` for the M15 read surface. M7 owns the registered predicate and keys it on ITS
 * plan id, so M15 resolves the same underlying fact — the M5/M17 `CaseloadProvider` seam — directly.
 * Org-wide scope roles (compliance/survey/medical-director) read without a caseload, exactly as the shared
 * predicate does; everyone else must be on the patient's care team. Fail-CLOSED when the seam throws.
 */
const ORG_WIDE_SCOPE_ROLES = [
  "medical_director",
  "compliance_officer",
  "survey_coordinator",
  "director_of_nursing",
] as const;

export interface CaseloadPort {
  isInCaseload(input: {
    organizationId: string;
    userId: string;
    patientId: string;
  }): Promise<boolean>;
}

/** The production caseload port — lazy `getSeam` per call, fail-CLOSED on throw (§8.7). */
export const seamCaseloadPort: CaseloadPort = {
  async isInCaseload(input) {
    try {
      return await getSeam("CaseloadProvider").isInCaseload(input);
    } catch {
      return false;
    }
  },
};

/** True when the actor may read this patient's discipline content at all (§4.1 `caseload_or_scope`). */
export async function actorMayReadPatient(
  actor: M15ReadActor,
  patientId: string,
  port: CaseloadPort = seamCaseloadPort,
): Promise<boolean> {
  if (ORG_WIDE_SCOPE_ROLES.some((r) => actor.roles.includes(r))) return true;
  return port.isInCaseload({
    organizationId: actor.organizationId,
    userId: actor.userId,
    patientId,
  });
}
