// apps/backend/src/modules/08-encounters/drafting/section-state.ts — where each drafted section stands against
// the clinician's confirmations (S1 PR C2a; VN-D7, VN-D12, design §3.2). Pure: no store, no clock.
import type { Draft } from "@chartwarden/hearthnote";
import { EncounterStateError } from "../lifecycle/errors";

/**
 * What the clinician did with a drafted section, as the store will keep it. Defined here, not imported from the
 * schema, so this core stays free of any table. `contentHash` and `corpusVersion` are the draft's values at the
 * moment of the confirmation (what the clinician saw).
 */
export interface ConfirmationRecord {
  readonly sectionId: string;
  readonly resolution: "confirmed" | "deselected";
  readonly contentHash: string;
  readonly corpusVersion: string;
}

export type SectionStateName =
  | "not_drafted"
  | "unresolved"
  | "confirmed"
  | "deselected"
  | "needs_reconfirmation";

export interface SectionState {
  readonly sectionId: string;
  readonly state: SectionStateName;
}

export type ActionReason = "unresolved" | "stale";

export interface SectionAction {
  readonly sectionId: string;
  readonly reason: ActionReason;
}

/**
 * One state per section of `draft`, in template order. An empty section is `not_drafted` (VN-D9; a confirmation
 * kept for it is ignored). A drafted section with no confirmation is `unresolved`; with one, it is `confirmed` or
 * `deselected` only while the confirmation still matches the recomputed content hash AND the draft's corpus
 * version, else `needs_reconfirmation` (VN-D12). A stale `deselected` is stale too: the sentences it left out
 * are not the sentences now drafted. When the store holds several confirmations for a section, the last one wins.
 */
export function sectionStates(
  draft: Draft,
  confirmations: readonly ConfirmationRecord[],
): readonly SectionState[] {
  const bySection = new Map(confirmations.map((c) => [c.sectionId, c]));
  return draft.sections.map((section): SectionState => {
    if (section.state === "empty") return { sectionId: section.sectionId, state: "not_drafted" };
    const confirmation = bySection.get(section.sectionId);
    if (confirmation === undefined) return { sectionId: section.sectionId, state: "unresolved" };
    const current =
      confirmation.contentHash === section.contentHash &&
      confirmation.corpusVersion === section.corpusVersion;
    return {
      sectionId: section.sectionId,
      state: current ? confirmation.resolution : "needs_reconfirmation",
    };
  });
}

/** The sections that still need the clinician, with why: never confirmed (`unresolved`) or no longer current (`stale`). */
export function unresolvedSections(states: readonly SectionState[]): readonly SectionAction[] {
  return states.flatMap((s): SectionAction[] => {
    if (s.state === "unresolved") return [{ sectionId: s.sectionId, reason: "unresolved" }];
    if (s.state === "needs_reconfirmation") return [{ sectionId: s.sectionId, reason: "stale" }];
    return [];
  });
}

/** The remediation code each reason carries: in the gate's 422 list and in the sign refusal's details. */
export const ACTION_CODE: Readonly<Record<ActionReason, string>> = {
  unresolved: "DRAFT_SECTION_UNRESOLVED",
  stale: "DRAFT_SECTION_STALE",
};

/**
 * The refusal when a note is signed (or its text is built) while a drafted section still needs the clinician: 409 `DRAFT_SECTION_STALE`
 * naming every such section in `details`. The caller refetches the draft, reviews and resolves those sections again.
 */
export function sectionsNeedResolving(actions: readonly SectionAction[]): EncounterStateError {
  return new EncounterStateError(
    "DRAFT_SECTION_STALE",
    `${actions.length} drafted section(s) are not resolved against the draft as it stands now: refetch the draft, review it and resolve them again`,
    actions.map((action) => ({
      field: action.sectionId,
      code: ACTION_CODE[action.reason],
      message:
        action.reason === "unresolved"
          ? `section '${action.sectionId}' has not been confirmed or deselected`
          : `section '${action.sectionId}' changed since it was resolved`,
    })),
  );
}
