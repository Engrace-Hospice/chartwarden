// apps/backend/src/modules/08-encounters/drafting/idg-follow-up.ts — the IDG follow-up visit's one linked action item (ADR-0114 S5b, VN-D64 to VN-D67): which of
// M14's open action items the author may link the visit to, what the draft states of the linked one, and the key that gates both. Reads M14 only through
// the `IdgFollowUpReader` seam (draft ports), which hands over FACTS and decides 42 CFR Part 2 per viewer (W-SUD-01); nothing here reads an M14 table.
//
// THE KEY (VN-D66). `idg.act` (M14's key for working one's OWN assigned action items, self-scoped to the assignee) is asked ONLY for this section: the draft
// routes never refuse for want of it. A viewer without it gets the section as not drafted and the REST of the draft is as it was, so a tenant whose roles
// lack the key sees no regression. The picker's list and link refuse 403 naming it; CLEARING the link needs no key, so a clinician who lost it can always
// clear a link they made.
//
// FAIL CLOSED. An item the seam no longer hands this viewer (closed, completed, reassigned, Part 2 without disclosure, of another patient) is not drafted
// and cannot be linked, never stale text; a fact the corpus cannot state (a decision kind with no label, an instant that is not one) leaves the item out
// the same way. A seam that FAILS is a 503 `DRAFT_UNAVAILABLE`, as every other source's failure is.
import type { IdgFollowUpDraftInput } from "@chartwarden/hearthnote";
import { draftSourceNeeds } from "@chartwarden/hearthnote";
import { IDG_DECISION_KIND_LABELS } from "@chartwarden/narrative-vocab";
import { localDateInTimeZone } from "@chartwarden/shared/dates";
import { ForbiddenError } from "@chartwarden/types";
import { EncounterStateError } from "../lifecycle/errors";
import type { DraftEncounter, DraftPorts, DraftViewer } from "./ports";
import { guarded } from "./unavailable";

/** M14's key for working one's own assigned action items (`idg.act`, self-scoped to the assignee): the draft asks it for this section alone. */
export const IDG_ACT_KEY = "idg.act";

/** Whether the viewer may be handed M14's action items. Absent permissions are none. */
export const mayActOnIdgItems = (permissions: ReadonlySet<string> | undefined): boolean =>
  permissions?.has(IDG_ACT_KEY) === true;

/** 403 for a caller who lacks the key; the message names it, as `requirePermission` does. Asked by the picker's list and link, never by a clear. */
export function assertMayActOnIdgItems(permissions: ReadonlySet<string>): void {
  if (!permissions.has(IDG_ACT_KEY))
    throw new ForbiddenError(`requires permission '${IDG_ACT_KEY}'`);
}

/**
 * Only a visit whose note drafts the IDG follow-up's own section has an action item to link: any other template is refused 422, as a section the template
 * does not have is. (It says nothing a caller could not learn from the template.)
 */
export function assertDraftsFromIdgFollowUp(encounter: DraftEncounter): void {
  if (!draftSourceNeeds(encounter.encounterType, encounter.discipline).idgFollowUp) {
    throw new EncounterStateError(
      "UNKNOWN_TEMPLATE_SECTION",
      "this visit's note is not drafted from an IDG action item",
    );
  }
}

/** One action item the viewer may link, as the picker shows it. The Part 2 flag is the link row's, never the wire's. */
export interface IdgFollowUpCandidate {
  readonly actionItemId: string;
  /** Org-local `YYYY-MM-DD` of the meeting. */
  readonly meetingDate: string;
  readonly decisionKind: string;
  /** The fixed label the note states for the kind. */
  readonly decisionLabel: string;
  /** Org-local `YYYY-MM-DD` the item is due, or `null`. */
  readonly dueDate: string | null;
  readonly status: "open" | "in_progress";
  /** M14's verdict, fail-closed: true unless the seam says the literal `false`. */
  readonly part2Derived: boolean;
}

const labelOf = (kind: string): string | undefined =>
  Object.prototype.hasOwnProperty.call(IDG_DECISION_KIND_LABELS, kind)
    ? (IDG_DECISION_KIND_LABELS as Readonly<Record<string, string>>)[kind]
    : undefined;

/** An ISO instant as the organization's calendar date, or `null` for something that is not an instant. */
function localDateOf(instant: unknown, timeZone: string): string | null {
  const ms = typeof instant === "string" ? Date.parse(instant) : Number.NaN;
  return Number.isNaN(ms) ? null : localDateInTimeZone(new Date(ms), timeZone);
}

/**
 * The action items M14 hands this viewer for the visit's patient, as candidates: open or in progress, assigned to the viewer, linked to an encounter. An
 * item M14 handed over that the note cannot state (no label for its kind, an instant that is not one) is left out. The viewer must hold `idg.act`
 * (a caller that did not check it gets nothing).
 */
export async function readIdgFollowUpCandidates(
  ports: Pick<DraftPorts, "idgFollowUpItems">,
  encounter: DraftEncounter,
  viewer: DraftViewer,
  timeZone: string,
): Promise<readonly IdgFollowUpCandidate[]> {
  if (!mayActOnIdgItems(viewer.permissions)) return [];
  const items = await guarded("the IDG action items", () =>
    ports.idgFollowUpItems(encounter.organizationId, encounter.patientId, viewer),
  );
  return items.flatMap((item): IdgFollowUpCandidate[] => {
    const decisionLabel = labelOf(item.decisionKind);
    const meetingDate = localDateOf(item.meetingAt, timeZone);
    const dueDate = item.dueAt === null ? null : localDateOf(item.dueAt, timeZone);
    if (
      decisionLabel === undefined ||
      meetingDate === null ||
      (item.dueAt !== null && dueDate === null) ||
      (item.status !== "open" && item.status !== "in_progress")
    ) {
      return [];
    }
    return [
      {
        actionItemId: item.actionItemId,
        meetingDate,
        decisionKind: item.decisionKind,
        decisionLabel,
        dueDate,
        status: item.status,
        part2Derived: item.sudRelated !== false,
      },
    ];
  });
}

/**
 * What the draft states of the linked action item: its facts, or `null` (the section is then not drafted) when the viewer lacks `idg.act`, nothing is
 * linked, or M14 no longer hands this viewer the linked item. The link is read from the store (a snapshot port), the facts from M14.
 */
export async function readIdgFollowUp(
  ports: Pick<DraftPorts, "idgFollowUpItems" | "linkedIdgActionItemId">,
  encounter: DraftEncounter,
  viewer: DraftViewer,
  timeZone: string,
): Promise<IdgFollowUpDraftInput | null> {
  if (!mayActOnIdgItems(viewer.permissions)) return null;
  const linked = await guarded("the linked IDG action item", () =>
    ports.linkedIdgActionItemId(encounter.id),
  );
  if (linked === null) return null;
  const candidates = await readIdgFollowUpCandidates(ports, encounter, viewer, timeZone);
  const item = candidates.find((candidate) => candidate.actionItemId === linked);
  if (item === undefined) return null;
  return {
    id: item.actionItemId,
    meetingOn: item.meetingDate,
    decisionKind: item.decisionKind,
    dueOn: item.dueDate,
    sudRelated: item.part2Derived,
  };
}

/** One candidate as the picker shows it: the facts the note would state, and whether the visit is linked to it. */
export interface IdgFollowUpItemView {
  readonly actionItemId: string;
  readonly meetingDate: string;
  readonly decisionKind: string;
  readonly decisionLabel: string;
  readonly dueDate: string | null;
  readonly status: "open" | "in_progress";
  readonly linked: boolean;
}

export interface IdgFollowUpItemsView {
  /** The encounter's patient: the audited read is accountable against it (§164.528). */
  readonly patientId: string;
  readonly items: readonly IdgFollowUpItemView[];
}

/** The picker's answer: the viewer's candidates, newest meeting first as M14 orders them, the linked one marked. No title, no body, no Part 2 flag. */
export function idgFollowUpItemsView(
  encounter: DraftEncounter,
  candidates: readonly IdgFollowUpCandidate[],
  linkedActionItemId: string | null,
): IdgFollowUpItemsView {
  return {
    patientId: encounter.patientId,
    items: candidates.map(
      ({ actionItemId, meetingDate, decisionKind, decisionLabel, dueDate, status }) => ({
        actionItemId,
        meetingDate,
        decisionKind,
        decisionLabel,
        dueDate,
        status,
        linked: actionItemId === linkedActionItemId,
      }),
    ),
  };
}
