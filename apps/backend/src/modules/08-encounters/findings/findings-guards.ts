// apps/backend/src/modules/08-encounters/findings/findings-guards.ts — WF09: when an encounter may take an ADL or nutrition record.
//
// Two rules, shared by the Drizzle and in-memory services so they cannot differ:
//   1. DRAFT ONLY. Finalize pins the note text (the ADLs and nutrition it states included), so a record written after that would
//      disagree with the note that gets signed. Signed, cosigned and void refuse as IMMUTABLE_AFTER_SIGN, finalized as
//      NOTE_PINNED_AT_FINALIZE; both are 409.
//   2. THE NOTE MUST STATE IT. A template states ADLs / nutrition only in the section flagged `adlSummary` / `nutritionSummary`.
//      A visit whose template has none (ADLs on an SLP or social-work note, nutrition on a PT or CHHA note) would save the record
//      and then leave it out of the signed note without a word, so it is refused up front (422 FINDING_NOT_IN_NOTE).
import { resolveTemplate } from "@chartwarden/hearthnote";
import type { EncounterDiscipline, EncounterStatus, EncounterType } from "@chartwarden/types";
import { EncounterStateError } from "../lifecycle/errors";
import { checkMutableForEdit } from "../lifecycle/validation";

export type FindingKind = "adl" | "nutrition";

const STATING_SECTION_FLAG = { adl: "adlSummary", nutrition: "nutritionSummary" } as const;
const FINDING_LABEL: Readonly<Record<FindingKind, string>> = {
  adl: "functional status (ADLs)",
  nutrition: "nutrition and hydration",
};

/** 409 unless the encounter is a draft (see the file header). */
export function assertDraftForFinding(status: EncounterStatus): void {
  checkMutableForEdit({ status });
  if (status === "draft") return;
  throw new EncounterStateError(
    "NOTE_PINNED_AT_FINALIZE",
    `encounter is '${status}'; its note text is pinned, so this record can no longer change. Record it before finalizing, or amend the note with an addendum`,
  );
}

/** 422 unless the encounter's template has a section that states `kind`. */
export function assertNoteStatesFinding(
  encounterType: EncounterType,
  discipline: EncounterDiscipline,
  kind: FindingKind,
): void {
  const flag = STATING_SECTION_FLAG[kind];
  const states = resolveTemplate(encounterType, discipline)?.sections.some((s) => s[flag] === true);
  if (states === true) return;
  throw new EncounterStateError(
    "FINDING_NOT_IN_NOTE",
    `a ${discipline} ${encounterType} note has no section for ${FINDING_LABEL[kind]}, so it would not appear in the signed note and is not recorded`,
  );
}
