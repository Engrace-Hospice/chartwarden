// apps/backend/src/modules/16-bereavement/routes/disclosure.ts — M16-T06 (§7.13, D10, §4.3.4).
//
// Two per-request confidentiality postures the M16 read + recompute paths resolve BEFORE they query, so the
// filter is applied at the source rather than after the fact:
//
//   • SUD (42 CFR Part 2), §7.13 — the decedent's Part 2 protection does NOT lapse at death. The
//     `active_substance_use` rubric factor and any SUD-derived MSW finding are visible only to a caller
//     with a satisfied `42_cfr_part_2_release` consent (M39). The verdict is also what M16 passes to
//     `gatherRiskEvidence` as `sudDisclosureAllowed`, so a recompute run by an uncleared caller scores the
//     factor as `unknown` — never as `false`, which would silently LOWER a survivor's tier (the D17
//     rejected alternative).
//   • VOLUNTEER REDUCED-PHI SCOPE (D10) — a bereavement volunteer sees the contact's name, preferred
//     modality and schedule, and nothing clinical: no risk tier, no score, no narrative. That is a
//     row-shape decision, not a 403, which is why it lives here next to the SUD verdict rather than as a
//     route guard.
//
// FAIL-CLOSED (§8.7): M39 is resolved lazily through the M1 seam registry at CALL time; while it is a
// deny-stub — or if it throws — the gate REDACTS. A consent outage narrows what a clinician sees; it never
// widens it. The fail-closed posture is enforced in {@link resolveBereavementDisclosure} itself, not only
// inside the default port, so an injected or future port that throws still redacts instead of 500ing the
// read (the M15-T06 lesson, carried forward verbatim).
//
// The seam is resolved through `getSeam` and cast to the minimal shape M16 calls (the M15 →
// ConsentEvaluator precedent): `ConsentEvaluator` is `unknown` in the leaf SeamContracts, and casting
// structurally keeps M16 off a `@chartwarden/consent` import edge it does not have.
import { getSeam } from "../../../bootstrap/index";
import { BEREAVEMENT_VOLUNTEER_DISCIPLINE, disciplineForRoleKeys } from "../abac-predicates";
import type { M16ReadActor } from "./actor";

/** The M39 surface M16 calls — structurally typed so no `@chartwarden/consent` import edge is taken. */
interface ConsentEvaluatorShape {
  evaluate(args: {
    organizationId: string;
    patientId: string;
    consentType: string;
    sessionContext: { sessionClass: string };
    callerModule: string;
    callerRoute?: string;
  }): Promise<{ allowed: boolean }>;
}

/** The confidentiality categories an M16 read may withhold (§7.13). */
export type BereavementRedactedCategory = "sud" | "clinical_risk";

/** The resolved per-request disclosure posture the read path filters and reports with. */
export interface BereavementDisclosureDecision {
  /** May the caller see SUD-derived content (the `active_substance_use` factor, SUD MSW findings)? */
  readonly sudAllowed: boolean;
  /** D10 — false when the caller is a bereavement VOLUNTEER, whose scope excludes clinical risk content. */
  readonly clinicalRiskAllowed: boolean;
  /** The response-envelope field — categories the caller is NOT cleared for on this plan. */
  readonly redactedCategories: readonly BereavementRedactedCategory[];
}

/** The role that reads a decedent's Part 2 content without a consent round-trip (§7.6 / M7 precedent). */
const RN_CASE_MANAGER_ROLE = "rn_case_manager";

/** Session classes that never receive either category, whatever their roles. */
const NON_DISCLOSURE_SESSION_CLASSES = [
  "patient_portal",
  "caregiver_portal",
  "bereaved_portal",
  "external_collaborator",
] as const;

/** The port the gate resolves M39 through (injected in tests; the seam registry in prod). */
export interface BereavementDisclosurePort {
  /** Is a `42_cfr_part_2_release` consent satisfied for this decedent / session right now? */
  part2ReleaseActive(input: {
    organizationId: string;
    patientId: string;
    sessionClass: string;
  }): Promise<boolean>;
}

/** The production port — lazy `getSeam` per call (registration order is irrelevant), fail-CLOSED on throw. */
export const seamBereavementDisclosurePort: BereavementDisclosurePort = {
  async part2ReleaseActive({ organizationId, patientId, sessionClass }) {
    try {
      const evaluator = getSeam("ConsentEvaluator") as ConsentEvaluatorShape;
      const verdict = await evaluator.evaluate({
        organizationId,
        patientId,
        consentType: "42_cfr_part_2_release",
        sessionContext: { sessionClass },
        callerModule: "m16",
      });
      return verdict.allowed === true;
    } catch {
      return false; // §8.7 — an unbound/erroring M39 REDACTS, never discloses
    }
  },
};

/** D10 — is the caller acting as a bereavement VOLUNTEER (the reduced-PHI scope)? */
export function isBereavementVolunteer(actor: M16ReadActor): boolean {
  return disciplineForRoleKeys(actor.roles) === BEREAVEMENT_VOLUNTEER_DISCIPLINE;
}

/**
 * Resolve the §7.13 / D10 disclosure posture for one actor reading one decedent's bereavement content.
 * Called ONCE per read request; the verdict then drives the row projection and the `redacted_categories`
 * envelope, and is passed to the D17 evidence gather as `sudDisclosureAllowed`.
 */
export async function resolveBereavementDisclosure(
  actor: M16ReadActor,
  patientId: string,
  port: BereavementDisclosurePort = seamBereavementDisclosurePort,
): Promise<BereavementDisclosureDecision> {
  const restrictedSession = NON_DISCLOSURE_SESSION_CLASSES.includes(actor.sessionClass as never);
  const isRnCaseManager = actor.roles.includes(RN_CASE_MANAGER_ROLE);

  const sudAllowed = restrictedSession
    ? false
    : isRnCaseManager ||
      (await (async () => {
        try {
          return await port.part2ReleaseActive({
            organizationId: actor.organizationId,
            patientId,
            sessionClass: actor.sessionClass,
          });
        } catch {
          return false; // no consent verdict → not disclosable
        }
      })());

  const clinicalRiskAllowed = !restrictedSession && !isBereavementVolunteer(actor);

  const redactedCategories: BereavementRedactedCategory[] = [];
  if (!sudAllowed) redactedCategories.push("sud");
  if (!clinicalRiskAllowed) redactedCategories.push("clinical_risk");
  return { sudAllowed, clinicalRiskAllowed, redactedCategories };
}

/** The posture a bereaved person's OWN portal session gets: their row, nothing clinical, nothing Part 2. */
export const PORTAL_SELF_DISCLOSURE: BereavementDisclosureDecision = {
  sudAllowed: false,
  clinicalRiskAllowed: false,
  redactedCategories: ["sud", "clinical_risk"],
};
