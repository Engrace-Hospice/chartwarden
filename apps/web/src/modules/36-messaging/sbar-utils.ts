// M36 WP 3.3 - SBAR helpers shared by the form, the sender and the composer: the flag key, fixed wording, building the
// RichSbar document from the four textareas (plain paragraphs split on blank lines), and reading server field errors.
import {
  RICH_BODY_SCHEMA_VERSION,
  type RichBody,
  type RichInline,
  type RichParagraph,
  SBAR_SECTION_KEYS,
  type SbarIssue,
  type SbarSectionKey,
  type SbarSections,
  type SbarUrgencyHint,
  richBodySbar,
} from "@wardenx/types";
import type { ChannelKind } from "./messaging-types";

export const SBAR_FLAG_KEY = "messaging.sbar";

/** Always shown in the form; the second line only while "urgent" is chosen. */
export const SBAR_EMERGENCY_NOTE =
  "Messaging is not the emergency path. For critical symptoms follow the agency telephone/emergency procedure.";
export const SBAR_URGENT_NOTE = "Marking urgent does not page or escalate anyone.";

export const SBAR_URGENCY_LABEL: Readonly<Record<SbarUrgencyHint, string>> = {
  routine: "Routine",
  important: "Important",
  urgent: "Urgent",
};

/** Platform guidance per section; a tenant may re-word it. Display only. */
export const SBAR_DEFAULT_HINTS: Readonly<Record<SbarSectionKey, string>> = {
  situation: "What is happening with the patient right now?",
  background: "Relevant history and context.",
  assessment: "What you think the problem is.",
  recommendation: "What you need, and by when.",
};

export type SbarSectionText = Readonly<Record<SbarSectionKey, string>>;
export interface SbarFormValues {
  readonly sections: SbarSectionText;
  readonly urgency: SbarUrgencyHint;
}

/** SBAR is a clinical hand-off: never in a broadcast or a bereavement conversation (the server enforces the same). */
export function sbarAllowedInChannel(kind: ChannelKind): boolean {
  return kind !== "announcement" && kind !== "bereavement";
}

/** A tenant that requires a patient channel limits SBAR to care-team conversations. */
export function sbarOfferedInChannel(kind: ChannelKind, requirePatientChannel: boolean): boolean {
  return sbarAllowedInChannel(kind) && (!requirePatientChannel || kind === "care_team");
}

export const defaultSbarUrgency = (kind: ChannelKind): SbarUrgencyHint =>
  kind === "on_call" ? "important" : "routine";

export const emptySbarValues = (kind: ChannelKind): SbarFormValues => ({
  sections: { situation: "", background: "", assessment: "", recommendation: "" },
  urgency: defaultSbarUrgency(kind),
});

function paragraphOf(block: string): RichParagraph {
  const content: RichInline[] = [];
  for (const [index, line] of block.split("\n").entries()) {
    if (index > 0) content.push({ type: "hardBreak" });
    if (line) content.push({ type: "text", text: line });
  }
  return { type: "paragraph", content };
}

/** Blank lines separate paragraphs; a single newline is a line break inside one. */
function sectionBlocks(text: string): RichParagraph[] {
  return text
    .replaceAll("\r\n", "\n")
    .split(/\n[ \t]*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map(paragraphOf);
}

export function buildSbarBody(values: SbarFormValues): RichBody {
  const [situation, background, assessment, recommendation] = SBAR_SECTION_KEYS.map((key) =>
    sectionBlocks(values.sections[key]),
  );
  return {
    schemaVersion: RICH_BODY_SCHEMA_VERSION,
    doc: {
      type: "doc",
      content: [
        {
          type: "sbar",
          urgencyHint: values.urgency,
          situation: situation ?? [],
          background: background ?? [],
          assessment: assessment ?? [],
          recommendation: recommendation ?? [],
        },
      ],
    },
  };
}

/** The same trimmed projection length the validator measures, for the live "n / min" counter. */
export function sectionLength(values: SbarFormValues, key: SbarSectionKey): number {
  return richBodySbar(buildSbarBody(values))?.sections[key].length ?? 0;
}

/** True when this body is an SBAR message (so the thread must not touch the ordinary draft after sending it). */
export const isSbarBody = (body: RichBody | undefined): boolean =>
  body !== undefined && richBodySbar(body) !== null;

/** Field errors of a 422 SBAR_INVALID envelope: `error.details[{field:'sbar.situation', code, message}]`. */
export function sbarIssuesFromError(error: unknown): SbarIssue[] {
  const details = (error as { error?: { details?: unknown } } | null)?.error?.details;
  if (!Array.isArray(details)) return [];
  const issues: SbarIssue[] = [];
  for (const entry of details as { field?: unknown; code?: unknown; message?: unknown }[]) {
    const key = typeof entry?.field === "string" ? entry.field.replace(/^sbar\./, "") : "";
    if (!(SBAR_SECTION_KEYS as readonly string[]).includes(key)) continue;
    issues.push({
      field: `sbar.${key as SbarSectionKey}`,
      code: entry.code === "TOO_SHORT" || entry.code === "TOO_LONG" ? entry.code : "REQUIRED",
      message: typeof entry.message === "string" ? entry.message : "needs attention",
    });
  }
  return issues;
}

/** Short send-failure text per SBAR code; says what the code means and nothing about why. */
export const SBAR_SEND_ERRORS: Readonly<Record<string, string>> = {
  SBAR_INVALID: "Some SBAR sections need attention. Your text is still here.",
  SBAR_NOT_ALLOWED_IN_CHANNEL: "SBAR messages can't be sent in this conversation.",
  SBAR_NOT_AVAILABLE: "SBAR messages aren't available right now.",
};

/** True when every section is blank: the urgency alone is not content, so it never keeps a draft alive. */
export const isBlankSbar = (sbar: SbarSections | null | undefined): boolean =>
  !sbar || SBAR_SECTION_KEYS.every((key) => (sbar.sections[key] ?? "").trim() === "");

/** Every section present, in canonical order (a server draft may omit or reorder keys). */
export const normaliseSbar = (sbar: SbarSections): SbarSections => ({
  urgencyHint: sbar.urgencyHint,
  sections: Object.fromEntries(
    SBAR_SECTION_KEYS.map((key) => [key, sbar.sections[key] ?? ""]),
  ) as SbarSections["sections"],
});

/** The form as the server draft holds it (WP 2.5), or null when it has nothing worth keeping. */
export function sbarDraftOf(values: SbarFormValues): SbarSections | null {
  const sbar: SbarSections = { urgencyHint: values.urgency, sections: values.sections };
  return isBlankSbar(sbar) ? null : sbar;
}

/** A restored server draft back into form values (no draft: an empty form for this channel kind). */
export const sbarValuesOf = (kind: ChannelKind, sbar: SbarSections | null): SbarFormValues =>
  sbar ? { urgency: sbar.urgencyHint, sections: sbar.sections } : emptySbarValues(kind);
