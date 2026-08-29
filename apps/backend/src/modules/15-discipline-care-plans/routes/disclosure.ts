// apps/backend/src/modules/15-discipline-care-plans/routes/disclosure.ts — M15-T06 (§7.8 / §7.9 / D9).
//
// The two CONFIDENTIALITY gates every M15 read path resolves BEFORE it queries, so the filter can be
// applied in SQL rather than after the fact (§7.8: "SQL-level WHERE filter via the ABAC predicate, not a
// UI hide"; §8.6 Information-disclosure row: "never post-fetch redaction"):
//
//   • SUD (42 CFR Part 2) — a goal with `sud_related = true` or an assessment with `sud_flag = true` is
//     visible only to a caller M39 clears PER ACTOR against the patient's `42_cfr_part_2_release`, or
//     the patient's RN Case Manager (the §7.6 M7 precedent this reuses verbatim — including its
//     ordering: the role path does not override a release restricted to named workforce members).
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
// never widens it, and that now includes the RN-Case-Manager path: it used to skip the consent
// round-trip entirely (a pure role fact from the M2 session), but a release can now name individual
// workforce members, and whether one does is a fact the role path has to have before it can apply.
//
// The seam is resolved through `getSeam` and cast to the minimal shape M15 calls (the M25 →
// TerminologyProvider precedent): `ConsentEvaluator` is `unknown` in the leaf SeamContracts, and casting
// structurally keeps M15 off a `@wardenx/consent` import edge it does not have.
import { hasOrgWideScope } from "@wardenx/auth";
import { getSeam } from "../../../bootstrap/index";
import type { M15ReadActor } from "./actor";

/** The M39 surface M15 calls — structurally typed so no `@wardenx/consent` import edge is taken. */
interface ConsentEvaluatorShape {
  evaluateForIngressRedaction(args: {
    organizationId: string;
    patientId: string;
    callerModule: string;
  }): Promise<{ redactFamilyViolenceFields: boolean }>;
  evaluateForInternalAccess(args: {
    organizationId: string;
    patientId: string;
    actor: { membershipId: string | null };
    callerModule: string;
  }): Promise<{ redactSubstanceUseDisorderFields: boolean; basis: string }>;
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
  /**
   * May THIS actor see the patient's Part 2 content right now? Per-actor since M39 gained
   * `workforce_member` recipients — `restrictedToNamedWorkforce` says the patient's release names
   * workforce members and this actor is not one, which is the one case the §7.6 RN-Case-Manager path
   * below may NOT override.
   */
  part2ReleaseActive(input: {
    organizationId: string;
    patientId: string;
    sessionClass: string;
    membershipId: string | null;
  }): Promise<{ allowed: boolean; restrictedToNamedWorkforce: boolean }>;
  /** Does M39 additionally require family-violence content to be redacted for this patient? */
  familyViolenceRedacted(input: { organizationId: string; patientId: string }): Promise<boolean>;
}

/** The production port — lazy `getSeam` per call (registration order is irrelevant), fail-CLOSED on throw. */
export const seamDisclosurePort: DisclosurePort = {
  async part2ReleaseActive({ organizationId, patientId, membershipId }) {
    // `evaluate()` IGNORES its `sessionContext` entirely — it answers "does a release of this type
    // exist for this patient", never "for this caller" — so passing the session class through it was
    // always answering a patient-scope question with a per-actor shape. `evaluateForInternalAccess`
    // is the per-actor one (mig 0209's `workforce_member` recipients made it answerable).
    try {
      const evaluator = getSeam("ConsentEvaluator") as ConsentEvaluatorShape;
      const verdict = await evaluator.evaluateForInternalAccess({
        organizationId,
        patientId,
        actor: { membershipId },
        callerModule: "m15",
      });
      return {
        allowed: !verdict.redactSubstanceUseDisorderFields,
        restrictedToNamedWorkforce:
          verdict.basis === "release_names_others" || verdict.basis === "actor_unidentified",
      };
    } catch {
      // §8.7 — an unbound/erroring M39 REDACTS, never discloses. Fail-closed in BOTH fields: an
      // outage must not read as "no restriction exists" and hand the role path a disclosure.
      return { allowed: false, restrictedToNamedWorkforce: true };
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
  const probe = async <T>(run: () => Promise<T>, onError: T): Promise<T> => {
    try {
      return await run();
    } catch {
      return onError;
    }
  };

  // M39 is consulted BEFORE the RN-Case-Manager path, not after: the role path is a treatment
  // carve-out (an intra-program read is not a §2.31 disclosure) and it still applies when no release
  // is on file, but it may not override a release the patient restricted to NAMED workforce members.
  // That restriction exists precisely to exclude other staff, and a role key cannot outrank it.
  const part2 = restrictedSession
    ? { allowed: false, restrictedToNamedWorkforce: true }
    : await probe(
        () =>
          port.part2ReleaseActive({
            organizationId: actor.organizationId,
            patientId,
            sessionClass: actor.sessionClass,
            membershipId: actor.membershipId,
          }),
        // no consent verdict → not disclosable, and not readable as "unrestricted" either
        { allowed: false, restrictedToNamedWorkforce: true },
      );
  const sudAllowed =
    !restrictedSession && (part2.allowed || (!part2.restrictedToNamedWorkforce && isRnCaseManager));

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
 * Org-wide scope roles read without a caseload, exactly as the shared predicate does — through
 * `hasOrgWideScope`, which IS that shared decision (F-096) rather than a fifth copy of it. This file's
 * literal happened to carry the correct four names; M8's, M9's and M10's did not, which is the argument
 * against a literal that happens to be right. Everyone else must be on the patient's care team.
 * Fail-CLOSED when the seam throws.
 */

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
  if (hasOrgWideScope(actor.roles)) return true;
  return port.isInCaseload({
    organizationId: actor.organizationId,
    userId: actor.userId,
    patientId,
  });
}
