// apps/backend/src/modules/08-encounters/routes/selections.ts — the HearthNote selection tree, the authoring menu and the Layer-1
// assembly helpers of the M8 route service (§2.6, #114, WF09): the DTOs of the selections routes, the pure functions that turn a stored
// tree into the `SelectionState` the assembler takes, the menu a composer renders, and the draft-save / finalize validation. Pure: no
// IO. Re-exported by ./service, which the Drizzle service and the in-memory slice both import them from.
import {
  type AssemblyContext,
  HearthnoteAssemblyError,
  type LinkedFall,
  type PriorRecordedAdl,
  type RecordedAdl,
  type RecordedNutrition,
  type RecordedVitals,
  type RecordedWound,
  type SelectionState,
  assemble,
  templateKey as hearthnoteTemplateKey,
  resolveTemplate,
} from "@chartwarden/hearthnote";
import {
  DRAFT_VOCAB_CODES,
  type SlotSpec,
  VOCAB_VERSION,
  entriesFor,
  entrySlots,
  validateSelectionTree,
} from "@chartwarden/narrative-vocab";
import type { EncounterDiscipline, EncounterType } from "@chartwarden/types";
import type { GateSectionSelection } from "../gate/index";
import { ASSEMBLY_ERROR_CODE, EncounterStateError } from "../lifecycle/errors";
import type { FallLink } from "./fall-link";

/**
 * One selectable vocabulary entry as the AUTHORING MENU offers it (F-063).
 *
 * `@chartwarden/narrative-vocab`'s own header calls `entriesFor(encounterType, discipline)` "the entries a
 * menu surfaces … so the selection UI and the template engine see the same deterministic ordering" —
 * and no route ever surfaced it, so there was no selection UI to see anything. `PATCH .../selections`
 * takes `sectionId` and `code` as free strings at the boundary and the server rejects an unknown one,
 * which means an authoring client without this menu could only guess.
 *
 * `slots` is the phrase's `${…}` placeholders MINUS the ones the server fills from the assembly context
 * (`patient`, `serviceDate`) — i.e. exactly the keys the client must supply as `params`. Derived here
 * rather than published as a static list so a corpus edit cannot leave the client asking for a slot the
 * phrase no longer has.
 */
export interface VocabMenuEntry {
  readonly code: string;
  readonly label: string;
  readonly category: string;
  readonly bodySystem: string | null;
  readonly slots: readonly string[];
  /** Constraint per slot; a slot absent here is free text. The composer renders its input from this. */
  readonly slotSpecs: Readonly<Record<string, SlotSpec>>;
  /** Statements sharing a group contradict each other; `assertSelectionsValid` refuses two in one note. */
  readonly exclusiveGroup: string | null;
}

/** One template section with the entries a clinician may pick into it. */
export interface TemplateSectionView {
  readonly sectionId: string;
  readonly heading: string;
  /** A `required` section must carry ≥1 selection before the §2.6 Layer-3 gate lets the note finalize. */
  readonly required: boolean;
  readonly allowedCategories: readonly string[];
  /**
   * The structured record the composer offers inside this section, whose values the note states by a fixed sentence (WF09): the visit's
   * ADLs, its nutrition and hydration, or the wounds assessed on it. `null` = a plain selection section.
   */
  readonly recordedPanel: "adl" | "nutrition" | "wounds" | null;
  readonly entries: readonly VocabMenuEntry[];
}

/**
 * The authoring menu for one encounter: its resolved HearthNote template, section by section, each with
 * the vocabulary entries eligible for this (encounterType × discipline) pair.
 *
 * Served from the server rather than shipped to the browser as a package, deliberately: `resolveTemplate`
 * + `entriesFor` + the `allowedCategories` scoping ARE the resolution rules `assembleSelections` enforces
 * on the way back in, and a second copy in the client is a second copy free to disagree with them.
 */
export interface EncounterTemplateView {
  readonly encounterId: string;
  readonly templateKey: string;
  readonly vocabVersion: string;
  readonly encounterType: EncounterType;
  readonly discipline: EncounterDiscipline;
  readonly sections: readonly TemplateSectionView[];
}

// ── HearthNote selections (§2.6, #114) ──────────────────────────────────────────────────────────────

/** One selected vocabulary entry with its resolved `${slot}` params (the wire shape of `EntrySelection`). */
export interface SelectionEntryInput {
  readonly code: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

/** One section's selections plus the clinician's verbatim prose for it. */
export interface SelectionSectionInput {
  readonly sectionId: string;
  readonly entries: readonly SelectionEntryInput[];
  readonly freeText?: string;
}

/**
 * What a selections PATCH carries. SECTIONS ONLY — `templateKey` / `vocabVersion` / the pair are derived
 * server-side from the encounter row, so a caller cannot assemble a note against a template its
 * encounter's discipline may not use.
 */
export interface SelectionsInput {
  readonly sections: readonly SelectionSectionInput[];
  /**
   * The recorded fall a follow-up-after-a-fall visit follows up. Absent keeps the link as it is; `null` clears it. It is only
   * accepted while the reason for the visit is that follow-up, and the fall must be one recorded for this patient (WF09).
   */
  readonly fallIncidentId?: string | null;
  /**
   * The author's own edit of the note text (WF09). Absent keeps the edit as it is; `null` discards it, so the note reads as
   * generated; a string stores it beside the generated text, flagged, and it is what gets signed.
   */
  readonly editedNarrative?: string | null;
}

/** The stored tree read back, with the Layer-1 assembly of it (routes 3b / 23b). */
export interface SelectionsView {
  /** The visit's patient: attributes the read to them in the §164.528 accounting (the route's read-audit takes it from this body). */
  readonly patientId: string;
  readonly templateKey: string;
  readonly vocabVersion: string;
  readonly sections: readonly SelectionSectionInput[];
  readonly layer1Preview: string;
  readonly version: number;
  /** The recorded fall this visit is linked to, or null (a draft's selections read only; absent on an addendum). */
  readonly fallIncident?: FallLink | null;
  /** The author's edit of the note text, or null (a draft's selections read only). */
  readonly editedNarrative?: string | null;
  /** True when the selections or vitals changed after the edit was made, so the edited text needs the author's review. */
  readonly editedNarrativeStale?: boolean;
}

/**
 * The `${patient}` slot Layer-1 interpolates.
 *
 * `AssemblyContext.patient` is documented as "the real name" at Layer 1, and M8 cannot resolve one: it
 * consumes no M5 reader (manifest `dependsOn: [1, 6, 7, 36, 38]`), and adding a cross-module dependency
 * to fill a narrative slot is a bigger decision than this fix. `Patient` is the safe resolution rather
 * than a placeholder — the assembled prose reads as ordinary clinical documentation ("Patient is
 * cardiovascularly stable…"), and it is PHI-minimal by construction. Named here so the day M8 does
 * consume a patient reader, there is exactly one line to change.
 */
export const ASSEMBLY_PATIENT_SLOT = "Patient";

/** Build the `SelectionState` the pure assembler takes from the stored tree + the encounter's own facts. */
/**
 * The §2.6 gate's view of a selection tree: presence only (how many entries, and whether the clinician
 * attached prose) — never the content. The Drizzle service derives the same shape from the STORED tree,
 * where the prose lives inside the DEK envelope and only a `hasFreeText` marker sits beside the codes.
 */
export function toGateSections(sections: readonly SelectionSectionInput[]): GateSectionSelection[] {
  return sections.map((s) => ({
    sectionId: s.sectionId,
    entryCount: s.entries.length,
    hasFreeText: (s.freeText?.length ?? 0) > 0,
  }));
}

export function toSelectionState(
  encounterType: EncounterType,
  discipline: EncounterDiscipline,
  sections: readonly SelectionSectionInput[],
  vocabVersion: string = VOCAB_VERSION,
): SelectionState {
  return {
    templateKey: hearthnoteTemplateKey(encounterType, discipline),
    vocabVersion,
    encounterType,
    discipline,
    sections: sections.map((s) => ({
      sectionId: s.sectionId,
      entries: s.entries.map((e) => ({ code: e.code, ...(e.params ? { params: e.params } : {}) })),
      ...(s.freeText === undefined ? {} : { freeText: s.freeText }),
    })),
  };
}

/**
 * Assemble the Layer-1 narrative for a selection tree, refusing anything that cannot become a note.
 *
 * Two failures are checked, and neither is allowed to pass silently:
 *
 *   · An unknown SECTION id. `assembleLayer1` walks the TEMPLATE's sections and looks each one up in the
 *     selection, so a section the template does not have is simply never visited — the content would be
 *     stored and then vanish from every render, which is the same class of silent loss as the discarded
 *     PATCH itself. Rejected here instead.
 *   · An unknown vocabulary CODE, an illegal (encounterType × discipline) pair, or a vocab-version
 *     mismatch — `assemble`'s own guards, surfaced as the §2.7 codes above rather than a 500.
 *
 * Nothing is caught and turned into `""`. A note that cannot be assembled must say so; returning an
 * empty string for it is the defect this whole path is being fixed for.
 */
/**
 * Build the authoring menu for one (encounterType × discipline) pair — the pure half of `getTemplate`.
 *
 * The two resolution rules live HERE, beside `assembleSelections`, because they are the same rules read
 * in the other direction: `resolveTemplate` decides which sections exist (and `assembleSelections`
 * refuses a `sectionId` outside them), and `entriesFor` decides which vocabulary entries this pair may
 * use (and `assemble` refuses a code outside the corpus). A section's `allowedCategories` narrows the
 * menu further; an empty list is a prose-only section that offers no statements. The scoping is the MENU's:
 * a write is not refused for naming a statement outside its section, only for the slot and contradiction
 * rules in `assertSelectionsValid`.
 *
 * Slots are derived from each phrase rather than declared, minus the two the assembly context supplies
 * (`patient`, `serviceDate`) — so the client is asked for exactly the `params` keys interpolation needs,
 * and a corpus edit cannot leave it asking for one the phrase no longer has. Each slot's constraint
 * (`slotSpecs`) and each statement's `exclusiveGroup` ride along so the client renders the same rules
 * `assertSelectionsValid` enforces.
 *
 * `draftWording` is the tenant's visit-note draft switch (ADR-0114 VN-D17): the draft phrases of `narrative-vocab@2026.11.0` are
 * unreviewed wording, so they are offered only where the switch is on (it cannot be turned on while the corpus review is pending).
 * Off, the menu is exactly what it was before that corpus: no draft phrase, and the RN routine visit's three formerly uncategorized
 * sections as open as they were. The default is off, so a caller that does not know the tenant never leaks the draft wording.
 */
export function buildTemplateMenu(
  encounterType: EncounterType,
  discipline: EncounterDiscipline,
  options: { readonly draftWording?: boolean } = {},
): Omit<EncounterTemplateView, "encounterId"> {
  const draftWording = options.draftWording === true;
  const template = resolveTemplate(encounterType, discipline, { draftWording });
  if (template === undefined) {
    throw new EncounterStateError(
      "INVALID_ENCOUNTER_DISCIPLINE_PAIR",
      `no HearthNote template for '${hearthnoteTemplateKey(encounterType, discipline)}'`,
    );
  }
  const eligible = entriesFor(encounterType, discipline).filter(
    (e) => draftWording || !DRAFT_VOCAB_CODES.has(e.code),
  );
  return {
    templateKey: template.key,
    vocabVersion: VOCAB_VERSION,
    encounterType,
    discipline,
    sections: template.sections.map((section) => {
      const allowed = section.allowedCategories;
      return {
        sectionId: section.id,
        heading: section.heading,
        required: section.required,
        allowedCategories: [...allowed],
        recordedPanel: section.adlSummary
          ? "adl"
          : section.nutritionSummary
            ? "nutrition"
            : section.woundSummary
              ? "wounds"
              : null,
        entries: eligible
          .filter((e) => allowed.includes(e.category))
          .map((e) => ({
            code: e.code,
            label: e.label,
            category: e.category,
            bodySystem: e.bodySystem ?? null,
            slots: entrySlots(e),
            slotSpecs: e.slotSpecs ?? {},
            exclusiveGroup: e.exclusiveGroup ?? null,
          })),
      };
    }),
  };
}

/**
 * Refuse a selection tree whose slot values or statement pairs cannot make a sound note (WF09 step 1).
 *
 * Run on every WRITE that stores selections (draft save, addendum save) with `requireComplete: false`, and
 * again at finalize with `true` — a draft may be half-filled, a finalized note may not (an empty slot
 * assembles into "has  dependent edema"). Never run on a READ: a signed note must stay readable even if
 * a rule tightens after it was signed. `details` carries one `{ field: sectionId, code, message }` per
 * problem so the composer can point at the section to fix.
 */
export function assertSelectionsValid(
  sections: readonly SelectionSectionInput[],
  options: { readonly requireComplete: boolean },
): void {
  const issues = validateSelectionTree(sections, options);
  const [first] = issues;
  if (first === undefined) return;
  const message =
    issues.length === 1
      ? first.message
      : `${issues.length} problems in the note's statements. First: ${first.message}`;
  throw new EncounterStateError(
    "INVALID_SELECTION",
    message,
    issues.map((i) => ({ field: i.sectionId, code: i.code, message: i.message })),
  );
}

/** What a note states about the visit beyond the clinician's own selections: what was recorded on it, and the fall it follows up. */
export interface NoteFacts {
  readonly recordedVitals?: RecordedVitals;
  readonly recordedAdl?: RecordedAdl;
  /** The ADL levels of the patient's previous signed visit, so the functional-status sentence can state the change since then. */
  readonly priorAdl?: PriorRecordedAdl;
  readonly recordedNutrition?: RecordedNutrition;
  readonly recordedWounds?: readonly RecordedWound[];
  readonly linkedFall?: LinkedFall;
}

export function assembleSelections(
  encounterType: EncounterType,
  discipline: EncounterDiscipline,
  serviceDate: string,
  sections: readonly SelectionSectionInput[],
  vocabVersion: string = VOCAB_VERSION,
  facts: NoteFacts = {},
): string {
  const template = resolveTemplate(encounterType, discipline);
  if (template === undefined) {
    throw new EncounterStateError(
      "INVALID_ENCOUNTER_DISCIPLINE_PAIR",
      `no HearthNote template for '${hearthnoteTemplateKey(encounterType, discipline)}'`,
    );
  }
  const known = new Set(template.sections.map((t) => t.id));
  for (const s of sections) {
    if (!known.has(s.sectionId)) {
      throw new EncounterStateError(
        "UNKNOWN_TEMPLATE_SECTION",
        `section '${s.sectionId}' is not part of template '${template.key}'`,
      );
    }
  }
  const context: AssemblyContext = {
    patient: ASSEMBLY_PATIENT_SLOT,
    serviceDate,
    ...(facts.recordedVitals === undefined ? {} : { recordedVitals: facts.recordedVitals }),
    ...(facts.recordedAdl === undefined ? {} : { recordedAdl: facts.recordedAdl }),
    ...(facts.priorAdl === undefined ? {} : { priorAdl: facts.priorAdl }),
    ...(facts.recordedNutrition === undefined
      ? {}
      : { recordedNutrition: facts.recordedNutrition }),
    ...(facts.recordedWounds === undefined ? {} : { recordedWounds: facts.recordedWounds }),
    ...(facts.linkedFall === undefined ? {} : { linkedFall: facts.linkedFall }),
  };
  try {
    return assemble(toSelectionState(encounterType, discipline, sections, vocabVersion), context)
      .narrative;
  } catch (e) {
    if (e instanceof HearthnoteAssemblyError) {
      throw new EncounterStateError(ASSEMBLY_ERROR_CODE[e.code], e.message);
    }
    throw e;
  }
}
