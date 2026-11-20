// apps/backend/src/modules/08-encounters/drafting/note-draft.ts — the draft as the sign gate and sign see it (S1 PR C2b2; VN-D7, VN-D12,
// VN-D17, design §3.2 "Gate" and "Sign"). Orchestration over the seams and the store; no database and no clock of its own.
//
// `null` when the tenant has the draft switched off, or when the encounter's template has no drafted section (the corpus decides, before
// any read): then the gate and sign are today's, exactly. Otherwise the
// draft is recomputed for the VIEWER given (the signer, never the author unless they are the same member), as of the visit time, and set
// against the stored confirmations. Nothing is cached, so the viewer's own Part 2 redaction decides what they are confirming.
//
// Fail closed: a switch that cannot be read, a source that cannot be read or a draft that cannot be compiled is
// `COMPLIANCE_GATE_UNAVAILABLE` (503, the check did not run), never a pass and never "the draft is off". The one exception is a stored
// selection the Layer-1 assembly itself refuses (`UNKNOWN_VOCAB_CODE`, `VOCAB_VERSION_MISMATCH`, `INVALID_ENCOUNTER_DISCIPLINE_PAIR`):
// those are the codes the clinician's own save and finalize already answer with, and they stay as they are.
import { templateHasDraftedSection } from "@chartwarden/hearthnote";
import { EncounterStateError } from "../lifecycle/errors";
import { assertMayReadAdmissionFacts } from "./admission-reads";
import { type ComputedDraft, computeDraft } from "./compute";
import type { DraftUnit } from "./draft-store";
import type { DraftEncounter, DraftPorts, DraftReader, DraftSeamPorts } from "./ports";
import {
  type SectionAction,
  type SectionState,
  sectionStates,
  sectionsNeedResolving,
  unresolvedSections,
} from "./section-state";

export interface NoteDraft {
  readonly computed: ComputedDraft;
  /** One state per template section, against the viewer's recomputed draft. */
  readonly states: readonly SectionState[];
  /** The drafted sections that still need the clinician: never confirmed, or no longer current. Empty when the note may sign. */
  readonly actions: readonly SectionAction[];
}

function unavailable(what: string, cause: unknown): EncounterStateError {
  return new EncounterStateError(
    "COMPLIANCE_GATE_UNAVAILABLE",
    `the visit-note draft check could not be decided: ${what}`,
    undefined,
    { cause },
  );
}

/** The assembly codes the clinician's own save already answers with stay as they are; everything else did not run. */
const KEEPS_ITS_CODE = new Set([
  "UNKNOWN_VOCAB_CODE",
  "VOCAB_VERSION_MISMATCH",
  "INVALID_ENCOUNTER_DISCIPLINE_PAIR",
]);

export async function readNoteDraft(
  unit: Pick<DraftUnit, "enabled" | "store">,
  seams: DraftSeamPorts,
  encounter: DraftEncounter,
  viewer: DraftReader,
  now: Date,
): Promise<NoteDraft | null> {
  // S1 scope: a template the corpus does not draft has no draft, so nothing is read, not even the switch (the same `null` as a tenant
  // with the switch off): the gate check does not run and finalize and sign are what they were. A pair with no template falls here too.
  if (!templateHasDraftedSection(encounter.encounterType, encounter.discipline)) return null;
  let enabled: boolean;
  try {
    enabled = await unit.enabled();
  } catch (cause) {
    throw unavailable("the tenant's draft switch could not be read", cause);
  }
  if (!enabled) return null;
  // The same by-template rule the draft routes apply: a recompute (finalize, sign, an addendum's) names the sections it holds back, which says what
  // the admission holds, so it asks for the same M6 read keys, after the switch and before any source is read.
  assertMayReadAdmissionFacts(encounter.encounterType, viewer.permissions);
  try {
    const ports: DraftPorts = { ...seams, ...unit.store };
    const computed = await computeDraft(ports, encounter, viewer, now);
    const states = sectionStates(computed.draft, await unit.store.confirmations(encounter.id));
    return { computed, states, actions: unresolvedSections(states) };
  } catch (cause) {
    if (cause instanceof EncounterStateError && KEEPS_ITS_CODE.has(cause.code)) throw cause;
    throw unavailable("the draft could not be computed", cause);
  }
}

/**
 * Sign's own check on the signer's draft: 409 `DRAFT_SECTION_STALE` naming every drafted section that is unresolved or no longer matches
 * its confirmation, so the client refetches and resolves them again. `null` (the draft is off) passes: sign is then what it always was.
 */
export function assertResolved(draft: NoteDraft | null): void {
  if (draft !== null && draft.actions.length > 0) throw sectionsNeedResolving(draft.actions);
}

/**
 * The drafted sections the clinician CONFIRMED against the draft as it stands now: their text is what the note will say, so gate check 1
 * counts each as populated (a deselected, unresolved or stale section is not, and an undrafted one has nothing to count). `undefined`
 * when the draft is off, so that check 1 is as it was.
 */
export function confirmedSectionIds(draft: NoteDraft | null): ReadonlySet<string> | undefined {
  if (draft === null) return undefined;
  return new Set(draft.states.filter((s) => s.state === "confirmed").map((s) => s.sectionId));
}
