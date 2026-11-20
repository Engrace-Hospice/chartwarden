// apps/web/src/modules/08-encounters/review — where a remedy leads when it is not on the screen that shows it, and how the record hands the
// composer the place in the note to open (`?focus=`). Pure. The query value is user-controlled input: it is parsed against a fixed list
// and the template's own section ids, and anything else is ignored.
import type { NoteTarget } from "./note-target";
import type { Blocker } from "./refusal-model";

/** The composer's query parameter that names the part of the note to open on arrival. */
export const FOCUS_PARAM = "focus";

const SECTION_PREFIX = "section:";

/** The `?focus=` value that opens `target` in the composer, or null for a target the composer is not asked to open on arrival. */
export function focusParamFor(target: NoteTarget): string | null {
  switch (target.kind) {
    case "section":
    case "draft_section":
      return `${SECTION_PREFIX}${target.sectionId}`;
    case "vitals":
      return "vitals";
    case "plan_step":
      return "plan";
    case "note_text":
      return "note";
    default:
      return null;
  }
}

/** The composer path for `target`: the path as given when the target needs no opening, else the path with its `?focus=`. */
export function composeHrefFor(composePath: string, target: NoteTarget): string {
  const focus = focusParamFor(target);
  return focus === null
    ? composePath
    : `${composePath}?${FOCUS_PARAM}=${encodeURIComponent(focus)}`;
}

/** The target a `?focus=` value names, or null when it names nothing the composer has (an unknown word, a section the template lacks). */
export function parseFocusParam(
  raw: string | null,
  sectionIds: ReadonlySet<string>,
): NoteTarget | null {
  if (raw === null) return null;
  if (raw === "vitals") return { kind: "vitals" };
  if (raw === "plan") return { kind: "plan_step" };
  if (raw === "note") return { kind: "note_text" };
  if (!raw.startsWith(SECTION_PREFIX)) return null;
  const sectionId = raw.slice(SECTION_PREFIX.length);
  return sectionIds.has(sectionId) ? { kind: "section", sectionId } : null;
}

/** The screen outside the note that fixes `target` (the patient's assessments or care plan, My Notes), or null when it is not one of them. */
export function externalPathFor(target: NoteTarget, patientId: string): string | null {
  switch (target.kind) {
    case "scales":
      return `/patients/${patientId}/assessments`;
    case "care_plan_review":
      return `/patients/${patientId}/care-plan`;
    case "my_notes":
      return "/work/drafts";
    default:
      return null;
  }
}

/** A blocker's button text on the record: it cannot save the selections, so that remedy opens the composer, where they are saved. */
export const recordRemedyLabel = (blocker: Blocker): string | null =>
  blocker.remedy.kind === "save_selections" ? "Open the composer" : blocker.remedyLabel;
