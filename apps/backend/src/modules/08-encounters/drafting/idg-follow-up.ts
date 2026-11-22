// apps/backend/src/modules/08-encounters/drafting/idg-follow-up.ts — the IDG follow-up visit's one linked action item (ADR-0114 S5b, VN-D64 to VN-D67): which of
// M14's open action items the author may link the visit to, what the draft states of the linked one, and the key that gates both. Reads M14 only through
// the `IdgFollowUpReader` seam (draft ports), which hands over FACTS and decides 42 CFR Part 2 per viewer (W-SUD-01); nothing here reads an M14 table.
//
// THE KEY (VN-D66). `idg.act` (M14's key for working one's OWN assigned action items, self-scoped to the assignee) is asked ONLY for this section: the draft
// routes never refuse for want of it. A viewer without it gets the section as not drafted and the REST of the draft is as it was, so a tenant whose roles
// lack the key sees no regression. The picker's list and link refuse 403 naming it; CLEARING the link needs neither the key nor M14 (it still passes the
// encounter's own checks: the tenant switch, the template's read keys, the routes' author checks), so a clinician who lost the key can still clear a link
// they made.
//
// FAIL CLOSED. An item the seam does not hand this viewer (reassigned, Part 2 without disclosure, of another patient) is not drafted and cannot be linked,
// never stale text. A CLOSED item is the one difference between the two reads: it is never offered for a NEW link (the candidate list is the open items),
// but the item a visit is already linked to is read by id in any status and still drafted, because M14's own auto-close closes an encounter-kind item
// when the assignee signs ANY visit and the section the author confirmed must survive that. A fact the corpus cannot state (a decision kind with no label,
// an instant that is not one) leaves the item out the same way. A seam that FAILS is a 503 `DRAFT_UNAVAILABLE`, as every other source's failure is.
import type {
  Draft,
  DraftSection,
  DraftSourceRef,
  IdgFollowUpDraftInput,
} from "@chartwarden/hearthnote";
import { draftSourceNeeds } from "@chartwarden/hearthnote";
import { IDG_DECISION_KIND_LABELS } from "@chartwarden/narrative-vocab";
import { localDateInTimeZone } from "@chartwarden/shared/dates";
import { type IdgActionItemStatus, type IdgFollowUpItem, NotFoundError } from "@chartwarden/types";
import { EncounterStateError } from "../lifecycle/errors";
import type { DraftStore } from "./draft-store";
import type { DraftEncounter, DraftPorts, DraftViewer } from "./ports";
import type { ConfirmationRecord, SectionAction, SectionState } from "./section-state";
import { guarded } from "./unavailable";

/** M14's key for working one's own assigned action items (`idg.act`, self-scoped to the assignee): the draft asks it for this section alone. */
export const IDG_ACT_KEY = "idg.act";

/** Whether the viewer may be handed M14's action items. Absent permissions are none. */
export const mayActOnIdgItems = (permissions: ReadonlySet<string> | undefined): boolean =>
  permissions?.has(IDG_ACT_KEY) === true;

/** 403 `IDG_ACTION_PERMISSION_REQUIRED` for a caller who lacks the key (the message still names it). Asked by the picker's list and link, never by a clear. */
export function assertMayActOnIdgItems(permissions: ReadonlySet<string>): void {
  if (!permissions.has(IDG_ACT_KEY)) {
    throw new EncounterStateError(
      "IDG_ACTION_PERMISSION_REQUIRED",
      `requires permission '${IDG_ACT_KEY}'`,
    );
  }
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
  /** The candidates are open or in progress; the item a visit is linked to keeps the status it has now (M14's auto-close may have closed it). */
  readonly status: IdgActionItemStatus;
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

/** One item M14 handed over as a candidate, or `null` when the note cannot state it (no label for its kind, an instant that is not one). */
function candidateOf(item: IdgFollowUpItem, timeZone: string): IdgFollowUpCandidate | null {
  const decisionLabel = labelOf(item.decisionKind);
  const meetingDate = localDateOf(item.meetingAt, timeZone);
  const dueDate = item.dueAt === null ? null : localDateOf(item.dueAt, timeZone);
  if (
    decisionLabel === undefined ||
    meetingDate === null ||
    (item.dueAt !== null && dueDate === null)
  ) {
    return null;
  }
  return {
    actionItemId: item.actionItemId,
    meetingDate,
    decisionKind: item.decisionKind,
    decisionLabel,
    dueDate,
    status: item.status,
    part2Derived: item.sudRelated !== false,
  };
}

/** Newest meeting first, then the greater id: the order M14's own read answers in. */
const newestFirst = (a: IdgFollowUpItem, b: IdgFollowUpItem): number =>
  a.meetingAt === b.meetingAt
    ? b.actionItemId.localeCompare(a.actionItemId)
    : b.meetingAt.localeCompare(a.meetingAt);

/** The ONE item a visit is linked to, by id and in any status, as M14 hands it to this viewer: the same facts, the same Part 2 verdict. `null` when it hands nothing. */
async function readLinkedItem(
  ports: Pick<DraftPorts, "linkedIdgFollowUpItem">,
  encounter: DraftEncounter,
  viewer: DraftViewer,
  linkedActionItemId: string,
): Promise<IdgFollowUpItem | null> {
  const item = await guarded("the linked IDG action item", () =>
    ports.linkedIdgFollowUpItem(
      encounter.organizationId,
      encounter.patientId,
      linkedActionItemId,
      viewer,
    ),
  );
  // An item the seam answers for another id is not the linked one, however it came to be returned.
  return item !== null && item.actionItemId === linkedActionItemId ? item : null;
}

/**
 * The action items M14 hands this viewer for the visit's patient, as candidates: open or in progress, assigned to the viewer, linked to an encounter. An
 * item M14 handed over that the note cannot state (no label for its kind, an instant that is not one) is left out. The viewer must hold `idg.act`
 * (a caller that did not check it gets nothing). `linkedActionItemId` is the item the visit is already linked to: when M14 no longer lists it as open (its own
 * auto-close closes an encounter-kind item when the assignee signs ANY visit) it is read by id and listed too, with the status it has now, so the author
 * can see, keep or clear what they linked. Only a LISTED item can be newly linked, so an item that is closed and not the linked one is never offered.
 */
export async function readIdgFollowUpCandidates(
  ports: Pick<DraftPorts, "idgFollowUpItems" | "linkedIdgFollowUpItem">,
  encounter: DraftEncounter,
  viewer: DraftViewer,
  timeZone: string,
  linkedActionItemId: string | null = null,
): Promise<readonly IdgFollowUpCandidate[]> {
  if (!mayActOnIdgItems(viewer.permissions)) return [];
  const open = await guarded("the IDG action items", () =>
    ports.idgFollowUpItems(encounter.organizationId, encounter.patientId, viewer),
  );
  const missing =
    linkedActionItemId !== null && !open.some((i) => i.actionItemId === linkedActionItemId);
  const linked = missing
    ? await readLinkedItem(ports, encounter, viewer, linkedActionItemId)
    : null;
  // M14 answers newest meeting first; the linked item, merged in, takes its place in that order.
  const items = linked === null ? open : [...open, linked].sort(newestFirst);
  return items.flatMap((item) => candidateOf(item, timeZone) ?? []);
}

/**
 * Whether an item the link route has just filed still reads as Part 2 when M14 is asked about it again BY ID (and fails closed: an item M14 no longer hands this
 * viewer, for whatever reason, counts as Part 2). The candidate list and its verdict are read on M14's own pooled transactions, beside the write transaction
 * that holds the encounter's row lock, so the item can turn Part 2 (its packet rebuilt or flagged, the patient flagged, the item reassigned) between that read
 * and the insert of its row; the route asks once more after the insert and raises the row in the same unit (the raise's own audit image is scrubbed).
 */
export async function linkedItemNeedsPart2(
  ports: Pick<DraftPorts, "linkedIdgFollowUpItem">,
  encounter: DraftEncounter,
  viewer: DraftViewer,
  actionItemId: string,
): Promise<boolean> {
  const item = await readLinkedItem(ports, encounter, viewer, actionItemId);
  return item === null || item.sudRelated !== false;
}

/**
 * What the draft states of the linked action item: its facts, or `null` (the section is then not drafted) when the viewer lacks `idg.act`, nothing is
 * linked, or M14 hands this viewer nothing for the linked item (reassigned, Part 2 without disclosure, no recorded decision, no label for its kind). The link
 * is read from the store (a snapshot port), the facts from M14 BY ID in any status: the draft does not depend on the item staying open, so a section the
 * author confirmed is still drafted after M14's auto-close has closed the item.
 */
export async function readIdgFollowUp(
  ports: Pick<DraftPorts, "linkedIdgFollowUpItem" | "linkedIdgActionItemId">,
  encounter: DraftEncounter,
  viewer: DraftViewer,
  timeZone: string,
): Promise<IdgFollowUpDraftInput | null> {
  if (!mayActOnIdgItems(viewer.permissions)) return null;
  const linked = await guarded("the linked IDG action item", () =>
    ports.linkedIdgActionItemId(encounter.id),
  );
  if (linked === null) return null;
  const found = await readLinkedItem(ports, encounter, viewer, linked);
  const item = found === null ? null : candidateOf(found, timeZone);
  if (item === null) return null;
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
  readonly status: IdgActionItemStatus;
  readonly linked: boolean;
}

export interface IdgFollowUpItemsView {
  /** The encounter's patient: the audited read is accountable against it (§164.528). */
  readonly patientId: string;
  readonly items: readonly IdgFollowUpItemView[];
}

/** The picker's answer: the viewer's candidates, newest meeting first as M14 orders them, the linked one marked (and listed even when no longer open). No title, no body, no Part 2 flag. */
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

/**
 * The 404 for an action item the viewer is not handed (absent, closed and not the linked one, reassigned, another patient's, or Part 2 without disclosure): ONE
 * answer for all of them, the same `NotFoundError` as an absent id. A subclass only so the service can tell it from the encounter's own 404 and audit the refusal.
 */
export class IdgActionItemNotOffered extends NotFoundError {
  constructor() {
    super("action item");
    this.name = "IdgActionItemNotOffered";
  }
}

/** The audited reason of a refused link, or `null` for any other failure (the encounter's own 404, a signed note, M14 being down). */
export function linkRefusalOf(error: unknown): "not_offered" | "link_limit" | null {
  if (error instanceof IdgActionItemNotOffered) return "not_offered";
  if (error instanceof EncounterStateError && error.code === "IDG_ACTION_ITEM_LINK_LIMIT") {
    return "link_limit";
  }
  return null;
}

/** The id of the section the IDG follow-up's linked action item feeds. */
export const IDG_FOLLOW_UP_SECTION_ID = "idg_followup";

/** Whether a draft source is the IDG follow-up's linked action item. */
export const isIdgActionItemRef = (ref: DraftSourceRef): boolean => ref.kind === "idg_action_item";

/**
 * Raises the live link row of a DRAFTED, Part 2 derived IDG follow-up section to Part 2 (a flag only goes up; the store's one statement matches no row once it
 * is up). The row's flag is otherwise written only by the link route, so a patient flagged (or an item M14 judges Part 2) AFTER the author linked it would
 * leave the action item id filed in the plain audit class on every later write on the row, and in the eraser's delete image. Used by every recompute that
 * sees the section: a section's resolution and `settleIdgSection` (finalize, sign, an addendum's).
 */
export async function raiseIdgLinkPart2Of(
  store: Pick<DraftStore, "raiseIdgLinkPart2">,
  encounter: DraftEncounter,
  section: DraftSection | undefined,
): Promise<void> {
  if (section?.state !== "drafted" || !section.part2Derived) return;
  for (const ref of section.sourceRefs.filter(isIdgActionItemRef)) {
    await store.raiseIdgLinkPart2(encounter.id, ref.id);
  }
}

/**
 * What an IDG follow-up recompute (a section's resolution, finalize, sign) does about its own section, against the stored confirmations (S5b):
 *
 *  - Raises the live link row to Part 2 when the section is drafted and Part 2 derived (`raiseIdgLinkPart2Of`); a recompute that finds the rows already right
 *    writes nothing.
 *  - Returns the section as STALE when the author confirmed it, the viewer holds `idg.act` and a link stands, yet the recompute does not draft it (the item
 *    was reassigned, M14 no longer clears the viewer for a Part 2 item, M14 hands nothing for it): a confirmed section that drops out of the note without a word
 *    is refused, so sign and finalize answer 409 / 422 `DRAFT_SECTION_STALE` naming `idg_followup` (no item detail), and the author clears the link and signs
 *    again. A viewer without `idg.act` gets the section as not drafted, by design (VN-D66): nothing is refused for them.
 */
export async function settleIdgSection(
  store: Pick<DraftStore, "linkedIdgActionItemId" | "raiseIdgLinkPart2">,
  encounter: DraftEncounter,
  viewer: DraftViewer,
  draft: Draft,
  states: readonly SectionState[],
  confirmations: readonly ConfirmationRecord[],
): Promise<readonly SectionAction[]> {
  if (!draftSourceNeeds(encounter.encounterType, encounter.discipline).idgFollowUp) return [];
  const section = draft.sections.find((s) => s.sectionId === IDG_FOLLOW_UP_SECTION_ID);
  if (section?.state === "drafted") {
    await raiseIdgLinkPart2Of(store, encounter, section);
    return [];
  }
  const confirmed = confirmations.some(
    (c) => c.sectionId === IDG_FOLLOW_UP_SECTION_ID && c.resolution === "confirmed",
  );
  const notDrafted = states.some(
    (s) => s.sectionId === IDG_FOLLOW_UP_SECTION_ID && s.state === "not_drafted",
  );
  if (!confirmed || !notDrafted || !mayActOnIdgItems(viewer.permissions)) return [];
  const linked = await guarded("the linked IDG action item", () =>
    store.linkedIdgActionItemId(encounter.id),
  );
  return linked === null ? [] : [{ sectionId: IDG_FOLLOW_UP_SECTION_ID, reason: "stale" }];
}
