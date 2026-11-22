// packages/hearthnote/src/draft/scope.ts — which templates draft at all (S1 rollout scope, design §3.2).
//
// ONE predicate, read off the corpus: a section is drafted for an (encounter type x discipline) pair when the pair's template has it, the
// sources feed it (`draftSectionPhrases`, one map per template), and EVERY phrase it is built from is tagged for the pair in
// `@chartwarden/narrative-vocab`. Today that is the RN routine, recertification and admission visits, the face-to-face visit by a
// physician or nurse practitioner, the LPN visits, the aide visit, the social-work and chaplain visits and the IDG follow-up of all six disciplines;
// tagging phrases for another pair (a later slice) is what makes that pair draft, with no list of templates to keep in step.
//
// The backend asks this BEFORE it reads any source: a template with no drafted section reads nothing, drafts nothing and asks the
// clinician nothing, so finalize, sign, the gate and the draft routes behave as they do with the tenant's switch off. The compiler obeys
// the same answer, so supplying every source for an undrafted template still yields an all-empty draft.
import { type VocabEntry, entriesFor } from "@chartwarden/narrative-vocab";
import type { EncounterDiscipline, EncounterType } from "@chartwarden/types";
import { HearthnoteAssemblyError } from "../assembly/assemble";
import { resolveTemplate } from "../templates/registry";
import { templateKey } from "../templates/types";
import { draftSectionPhrases, sourceNeedsOf } from "./sources";
import type { Draft, DraftSourceNeeds, EmptyDraftSection } from "./types";

/**
 * The ids of the sections of the pair's template that can be drafted. `entries` is the corpus the pair is read against (the entries
 * tagged for it); the default is the shipped corpus, a test passes another to prove the answer follows the tags.
 */
export function draftedSectionIds(
  encounterType: EncounterType,
  discipline: EncounterDiscipline,
  entries: readonly VocabEntry[] = entriesFor(encounterType, discipline),
): ReadonlySet<string> {
  const template = resolveTemplate(encounterType, discipline);
  if (template === undefined) return new Set();
  const tagged = new Set(entries.map((entry) => entry.code));
  const phrases = draftSectionPhrases(template.key);
  return new Set(
    template.sections
      .map((section) => section.id)
      .filter((id) => phrases[id]?.every((code) => tagged.has(code)) ?? false),
  );
}

/**
 * The sources (care plan, vitals, medication changes, scales, and the discipline's own plan) the pair's draft is built from: the union over the
 * sections it drafts. A template that drafts nothing needs none. The backend reads, and asks the read keys of, only these (S3, VN-D42; S4).
 */
export function draftSourceNeeds(
  encounterType: EncounterType,
  discipline: EncounterDiscipline,
): DraftSourceNeeds {
  return sourceNeedsOf(
    templateKey(encounterType, discipline),
    draftedSectionIds(encounterType, discipline),
  );
}

/** Whether a visit's draft reads the benefit period it falls in (S2): the recertification and the face-to-face visit (`md`, `np`). */
export function readsBenefitPeriod(encounterType: EncounterType): boolean {
  return encounterType === "recert_visit" || encounterType === "face_to_face";
}

/**
 * Whether a visit's draft reads the admission record (S2b): the caregivers on record and the advance directive acknowledgment. Today the RN
 * admission visit alone; every other visit reads none of it.
 */
export function readsAdmissionRecord(encounterType: EncounterType): boolean {
  return encounterType === "admission_visit";
}

/**
 * Whether a visit's draft reads the orders in effect (S2b, S5): the RN admission visit and the face-to-face visit by a physician or nurse
 * practitioner, whose `med_reconciliation` states them. Nothing else of the admission record is read for the face-to-face visit.
 */
export function readsActiveOrders(encounterType: EncounterType): boolean {
  return encounterType === "admission_visit" || encounterType === "face_to_face";
}

/** Whether the pair's template has any drafted section. `false` for a pair with no template. */
export function templateHasDraftedSection(
  encounterType: EncounterType,
  discipline: EncounterDiscipline,
): boolean {
  return draftedSectionIds(encounterType, discipline).size > 0;
}

/**
 * The draft of a template that drafts nothing: every section empty, `asOf` as given. No source is read, so there is no sourced text and
 * no hash. Throws `TEMPLATE_NOT_FOUND` for a pair with no template, as `compileDraft` does.
 */
export function emptyDraft(
  encounterType: EncounterType,
  discipline: EncounterDiscipline,
  asOf: string,
): Draft {
  const template = resolveTemplate(encounterType, discipline);
  if (template === undefined) {
    throw new HearthnoteAssemblyError(
      "TEMPLATE_NOT_FOUND",
      `no template for '${templateKey(encounterType, discipline)}'`,
    );
  }
  return {
    templateKey: template.key,
    asOf,
    sections: template.sections.map(
      (section): EmptyDraftSection => ({
        sectionId: section.id,
        state: "empty",
        reason: "nothing_to_draft_from",
      }),
    ),
  };
}
