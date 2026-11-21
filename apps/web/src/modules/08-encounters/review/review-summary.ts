// apps/web/src/modules/08-encounters/review — the read-only summary of what the visit note will state (WF09 WP3). Pure: built only from what
// the composer already holds (the template, the author's selections, the draft's section states, which saved records exist). It says what
// has an entry and what the entry rests on. It never says a section is complete or ready: the server decides that when the note is
// finalized, and it counts some things the composer cannot see (recorded vitals do not fill a prose section, scales and the care-plan
// review are not in the note at all).
import type { DraftSectionState, DraftView } from "../draft-api";
import { confirmedSectionIds, draftedStateOf } from "../draft-model";
import {
  type DraftSections,
  type TemplateSection,
  type TemplateView,
  isSectionPopulated,
  sectionHasEmptySlots,
  sectionsFilledByRecords,
} from "../encounters-api";
import { type NoteTarget, VISIT_REASON_SECTION_ID } from "./note-target";

/** What an entry in a section rests on: the author's selections, their own text, a saved record, or drafted text they confirmed. */
export type EntryBasis = "selection" | "own_text" | "saved_record" | "confirmed_draft";

export interface SectionSummary {
  readonly sectionId: string;
  readonly heading: string;
  readonly required: boolean;
  /** The labels of the statements the author selected (never their own text). */
  readonly statements: readonly string[];
  readonly basis: readonly EntryBasis[];
  readonly hasEntry: boolean;
  /** A selected statement still has an empty detail. */
  readonly needsDetails: boolean;
  /** The state of the section's drafted text, when something was drafted for it. */
  readonly draftState: DraftSectionState | null;
  readonly edit: NoteTarget;
}

type FindingId = "vitals" | "adl" | "nutrition" | "wounds" | "fall" | "care_plan";

export interface FindingSummary {
  readonly id: FindingId;
  readonly label: string;
  /** `unknown`: the composer does not hold it, so the row says where to look instead of guessing. */
  readonly status: "recorded" | "none" | "unknown";
  readonly detail: string;
  readonly edit: NoteTarget;
}

export interface NoteSummary {
  readonly sections: readonly SectionSummary[];
  readonly findings: readonly FindingSummary[];
}

export interface SummaryInput {
  readonly template: TemplateView;
  readonly draft: DraftSections;
  /** The visit-note draft, or null when the tenant switch is off. */
  readonly drafted: DraftView | null;
  /** Whether a saved record exists, per recorded panel; a key left out is not known here. */
  readonly recorded: {
    readonly adl?: boolean;
    readonly nutrition?: boolean;
    readonly wounds?: boolean;
  };
  /** The fall-follow-up link, or null when the visit is not a fall follow-up. */
  readonly fall?: { readonly linked: boolean } | null;
  /** The care-plan items linked to the visit, when the composer knows the count. */
  readonly carePlanLinks?: number;
}

function entryBasis(
  draft: DraftSections,
  sectionId: string,
  filledByRecord: ReadonlySet<string>,
  confirmed: ReadonlySet<string>,
): readonly EntryBasis[] {
  const own = draft[sectionId];
  const basis: EntryBasis[] = [];
  if ((own?.entries.length ?? 0) > 0) basis.push("selection");
  if ((own?.freeText.trim().length ?? 0) > 0) basis.push("own_text");
  if (filledByRecord.has(sectionId)) basis.push("saved_record");
  if (confirmed.has(sectionId)) basis.push("confirmed_draft");
  return basis;
}

function sectionSummary(
  section: TemplateSection,
  input: SummaryInput,
  filledByRecord: ReadonlySet<string>,
  confirmed: ReadonlySet<string>,
): SectionSummary {
  const picked = input.draft[section.sectionId]?.entries ?? [];
  const basis = entryBasis(input.draft, section.sectionId, filledByRecord, confirmed);
  return {
    sectionId: section.sectionId,
    heading: section.heading,
    required: section.required,
    statements: picked.map(
      (entry) =>
        section.entries.find((offered) => offered.code === entry.code)?.label ?? entry.code,
    ),
    basis,
    hasEntry:
      isSectionPopulated(input.draft, section.sectionId, confirmed) ||
      filledByRecord.has(section.sectionId),
    needsDetails: sectionHasEmptySlots(input.template, input.draft, section.sectionId),
    draftState: draftedStateOf(input.drafted, section.sectionId) ?? null,
    edit: { kind: "section", sectionId: section.sectionId },
  };
}

const RECORDED_LABEL = { adl: "ADLs", nutrition: "Nutrition", wounds: "Wounds" } as const;
const RECORDED_DETAIL = {
  adl: "A saved ADL record is on this visit.",
  nutrition: "A saved nutrition record is on this visit.",
  wounds: "A saved wound record is on this visit.",
} as const;

function recordedFinding(
  kind: "adl" | "nutrition" | "wounds",
  sectionId: string,
  saved: boolean | undefined,
): FindingSummary {
  const base = {
    id: kind,
    label: RECORDED_LABEL[kind],
    edit: { kind: "section", sectionId },
  } as const;
  if (saved === undefined) {
    return {
      ...base,
      status: "unknown",
      detail: `Open ${RECORDED_LABEL[kind]} to see what is saved.`,
    };
  }
  return saved
    ? { ...base, status: "recorded", detail: RECORDED_DETAIL[kind] }
    : { ...base, status: "none", detail: "Nothing is saved yet." };
}

function carePlanFinding(links: number | undefined): FindingSummary {
  const base = { id: "care_plan", label: "Care-plan items", edit: { kind: "plan_step" } } as const;
  if (links === undefined) {
    return { ...base, status: "unknown", detail: "Open the plan of care to see the linked items." };
  }
  if (links === 0) {
    return { ...base, status: "none", detail: "No care-plan items are linked to this visit." };
  }
  return {
    ...base,
    status: "recorded",
    detail: `${links} care-plan ${links === 1 ? "item" : "items"} linked`,
  };
}

function findingsOf(input: SummaryInput): readonly FindingSummary[] {
  const vitals: FindingSummary = {
    id: "vitals",
    label: "Visit vitals",
    status: "unknown",
    detail: "Open visit vitals to see what is recorded for this visit.",
    edit: { kind: "vitals" },
  };
  const panels = (["adl", "nutrition", "wounds"] as const).flatMap((kind): FindingSummary[] => {
    const section = input.template.sections.find((s) => s.recordedPanel === kind);
    return section ? [recordedFinding(kind, section.sectionId, input.recorded[kind])] : [];
  });
  const fall: FindingSummary[] = input.fall
    ? [
        {
          id: "fall",
          label: "Fall follow-up link",
          status: input.fall.linked ? "recorded" : "none",
          detail: input.fall.linked
            ? "A recorded fall is linked to this visit."
            : "No recorded fall is chosen yet.",
          edit: { kind: "section", sectionId: VISIT_REASON_SECTION_ID },
        },
      ]
    : [];
  return [vitals, ...panels, ...fall, carePlanFinding(input.carePlanLinks)];
}

export function buildNoteSummary(input: SummaryInput): NoteSummary {
  const filledByRecord = sectionsFilledByRecords(input.template, {
    adl: input.recorded.adl === true,
    nutrition: input.recorded.nutrition === true,
  });
  const confirmed = confirmedSectionIds(input.drafted);
  return {
    sections: input.template.sections.map((section) =>
      sectionSummary(section, input, filledByRecord, confirmed),
    ),
    findings: findingsOf(input),
  };
}
