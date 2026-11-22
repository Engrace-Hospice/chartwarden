// apps/web/src/modules/08-encounters — the IDG action item picker of an IDG follow-up visit's composer (ADR-0114 S5b, VN-D64 to VN-D67). The author chooses the ONE
// IDG action item this visit follows up, or none. The server decides everything: which items this viewer is handed (a Part 2 item a viewer may not read is not in
// the list, and neither is anything without the `idg.act` key), who may change the choice and the cap on changes; this shows the list, sends the one change and
// takes the server's answer. It shows the facts the drafted section states (the meeting date, the decision, the due date, the status) and never an item's title or
// words: the API does not send them.
//
// ONE CHOICE. A radio group plus "No follow-up item"; the checked one is the item the visit is linked to. The linked item is listed even once M14 has closed it
// (the draft still states it), and says so in words. Choosing changes the section the draft states, so a section already confirmed needs confirming again, and the
// caller re-reads the draft after every change here (`onChanged`). The reads, the one change at a time, the focus and the retry are `useSerializedListPicker`'s
// (shared with the plan picker): while a change is saved the radios are `aria-disabled` and do nothing (the one pressed would otherwise drop keyboard focus), and a
// status that was already on the page says "Saving…" and "Saved."
//
// KEYBOARD. A native radio group checks, and so commits, every radio the arrow keys pass. A commit here is a request, so the arrow keys only MOVE the focus
// (round the group) and Space or Enter on the focused radio chooses it.
//
// WHAT THE PANEL SAYS. An empty list says there is no item to choose and that the section is documented below; a role without `idg.act` is told, calmly, that the
// section is not drafted for it (a note, not an error); a visit the server has no list for (no draft switch, not the viewer's, not an IDG follow-up) shows nothing,
// or says so to someone who was waiting on the answer.
//
// CLEARING needs no key and no M14, and it is the only way to end a link the list no longer shows (the server keeps the link when M14 stops handing the item, and a
// sign is refused until it is cleared). The client cannot tell "no link" from "a link that is not shown", so "Clear the follow-up item" is on every panel an author
// can reach without an item to uncheck: no key, M14 not answering, an empty list, and under a list in which no item is linked. The list is read again after a clear
// because the clear's own answer is not the list; until it answers, the picture is the list with nothing linked (`settle`), so nothing flashes and the focus stays.
import { Button, InlineAlert, Panel, formatDateOnly, useApiClient } from "@chartwarden/ui";
import { Fragment, useId, useRef } from "react";
import type { JSX, KeyboardEvent, ReactNode } from "react";
import {
  type IdgActionItem,
  type IdgActionItemsView,
  type Outcome,
  describeDraftRefusal,
  isIdgActionPermissionRefusal,
  loadIdgActionItems,
  setIdgActionItem,
} from "./draft-api";
import { PickerRetryPanel } from "./picker-retry-panel";
import { type PickerLoad, useSerializedListPicker } from "./use-serialized-list-picker";

export interface ComposerIdgActionItemPickerProps {
  readonly encounterId: string;
  /** The choice can change only while the note is a draft. Otherwise the chosen item is shown, without controls. */
  readonly editable: boolean;
  /** The choice changed here (or may have): the draft is built from it, so the caller re-reads the draft. */
  readonly onChanged: () => void;
}

type IdgState =
  /** No list for this visit (no draft switch, not the viewer's visit, not an IDG follow-up): the panel takes no room. */
  | { readonly status: "none" }
  | { readonly status: "empty" }
  /** The same, said to someone who was waiting on the answer (a refused change read again), so the panel and the focus do not vanish. */
  | { readonly status: "unavailable" }
  | { readonly status: "no-access" }
  | { readonly status: "ready"; readonly items: readonly IdgActionItem[] };

/** The statuses that mean "this visit has no IDG list for you" (a 403 with the missing-key code is told apart: it has a note). */
const NOT_SHOWN_STATUSES: readonly number[] = [403, 404, 422];

const TITLE = "IDG follow-up item";
const NO_ITEM_LABEL = "No follow-up item";
const CLEAR_LABEL = "Clear the follow-up item";
const NOT_A_DRAFT_REASON = "The item can change only while the note is a draft.";
const SAVING_REASON = "Saving the change to this visit's follow-up item…";
const NOT_CONFIRMED_WORDS = "Could not confirm the change. Check the choice before you go on.";
const COULD_NOT_LOAD_WORDS =
  "The IDG action items could not be loaded. Your documentation is not affected.";
const stillCouldNotLoadWords = (attempt: number): string =>
  `Still could not load the IDG action items (attempt ${attempt}). Your documentation is not affected.`;
const DOCUMENT_BELOW = " Document it in the note below.";
const EMPTY_WORDS =
  "There is no open IDG action item assigned to you for this patient. This section is not drafted.";
const NO_ACCESS_WORDS =
  "Your role cannot work with IDG action items, so this section is not drafted.";
const UNAVAILABLE_WORDS = "There are no IDG action items to show for this visit.";
const NO_ITEM_CHOSEN_WORDS = "No follow-up item was chosen for this visit.";
/** What the status line says after a clear: true whether or not anything was linked (the answer does not say which). */
const CLEARED_WORDS = "No follow-up item is linked now.";
/** The refusal for a link by a role that has lost the key: the no-key note already says it, so it is not repeated beside it as an error. */
const LOST_KEY_REFUSAL_WORDS =
  "Your role cannot work with IDG action items, so nothing was changed.";
const LINKED_CLOSED_WORDS =
  "The item this visit follows up is closed. The drafted section still states it.";
const CHANGE_CLOSED_WORDS = " Choose another item, or no item, to change that.";
const DESCRIPTION_WORDS =
  "The IDG action item this visit follows up. The drafted section states its meeting date, decision and due date.";
const CHOOSE_WORDS =
  " Choose the one item to follow up. The arrow keys move between the choices without choosing; Space or Enter chooses.";

/** What a refused change says: the picker's own words for the answers that need them, the shared copy for the rest. */
function refusalWords(failure: { readonly status: number; readonly error: unknown }): string {
  if (failure.status === 404) {
    return "That item is no longer available to you, so nothing was changed. The list shows what is available now.";
  }
  if (failure.status === 422) {
    return "This note is not drafted from an IDG action item, so nothing was changed.";
  }
  if (failure.status === 403 && isIdgActionPermissionRefusal(failure.error)) {
    return LOST_KEY_REFUSAL_WORDS;
  }
  return describeDraftRefusal(failure).message;
}

/** In words, never blank: a closed item says it is closed (and how), and a status this screen does not know says so. */
const STATUS_WORDS: Readonly<Record<string, string>> = {
  open: "Open",
  in_progress: "In progress",
  completed: "Closed (completed)",
  cancelled: "Closed (cancelled)",
  auto_closed: "Closed (automatically)",
};
const statusWords = (status: string): string => STATUS_WORDS[status] ?? "Status unknown";
const isOpen = (item: IdgActionItem): boolean =>
  item.status === "open" || item.status === "in_progress";

/** An element of the answer that has what a row shows (the status is any text: an unknown one is said, not hidden). */
function isItem(value: unknown): value is IdgActionItem {
  if (value === null || typeof value !== "object") return false;
  const item = value as Partial<Record<keyof IdgActionItem, unknown>>;
  return (
    typeof item.actionItemId === "string" &&
    item.actionItemId !== "" &&
    typeof item.meetingDate === "string" &&
    typeof item.decisionLabel === "string" &&
    (item.dueDate === null || typeof item.dueDate === "string") &&
    typeof item.status === "string" &&
    typeof item.linked === "boolean"
  );
}

/** What an answer is: a list, an empty one, a role without the key, a visit with no list, or a failure to try again (an element that is not an item is one). */
function classifyIdg(outcome: Outcome<IdgActionItemsView>, waited: boolean): IdgState | null {
  if (outcome.ok) {
    const items: unknown = outcome.data?.items;
    if (!Array.isArray(items) || !items.every(isItem)) return null;
    return items.length > 0 ? { status: "ready", items } : { status: "empty" };
  }
  if (outcome.status === 403 && isIdgActionPermissionRefusal(outcome.error)) {
    return { status: "no-access" };
  }
  return NOT_SHOWN_STATUSES.includes(outcome.status)
    ? { status: waited ? "unavailable" : "none" }
    : null;
}

/** The item the draft is built from: when a read finds it changed, the draft is read again. */
const linkedIdOf = (state: IdgState): string | undefined => {
  if (state.status === "empty") return "";
  if (state.status !== "ready") return undefined;
  return state.items.find((item) => item.linked)?.actionItemId ?? "";
};

/** What a cleared choice looks like before the list is read again: the same items, none linked, and a closed one (listed only for being linked) gone. */
function afterClear(load: PickerLoad<IdgState>): IdgState | undefined {
  if (load.status !== "ready") return undefined;
  const open = load.items.filter(isOpen).map((item) => ({ ...item, linked: false }));
  return open.length > 0 ? { status: "ready", items: open } : { status: "empty" };
}

/** One item in words: the team's decision (a label such as "a referral"), then when they met, when it is due and where it stands. */
function ItemWords({ item }: { readonly item: IdgActionItem }): JSX.Element {
  const facts = [
    `Meeting ${formatDateOnly(item.meetingDate)}`,
    item.dueDate === null ? "No due date" : `Due ${formatDateOnly(item.dueDate)}`,
    statusWords(item.status),
  ];
  return (
    <>
      <span>Decision: {item.decisionLabel}</span>
      <span className="wx-sr-only">. </span>
      <span className="wx-row-sub">
        {facts.map((fact, index) => (
          <Fragment key={fact}>
            {/* The dot is for the eye; a reader is given a comma, so the name does not read "Meeting … dot Due …". */}
            {index > 0 ? <span aria-hidden="true"> · </span> : null}
            {index > 0 ? <span className="wx-sr-only">, </span> : null}
            {fact}
          </Fragment>
        ))}
      </span>
    </>
  );
}

const ARROW_STEP: Readonly<Record<string, number>> = {
  ArrowDown: 1,
  ArrowRight: 1,
  ArrowUp: -1,
  ArrowLeft: -1,
};

/** The arrow keys move the focus round the group without checking; Enter chooses the focused radio (Space does natively). */
function moveOrChoose(event: KeyboardEvent<HTMLInputElement>, group: HTMLElement | null): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.key === "Enter") {
    event.preventDefault();
    event.currentTarget.click();
    return;
  }
  const step = ARROW_STEP[event.key];
  if (step === undefined || group === null) return;
  const radios = Array.from(group.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
  const at = radios.indexOf(event.currentTarget);
  if (at < 0) return;
  event.preventDefault();
  radios[(at + step + radios.length) % radios.length]?.focus();
}

export function ComposerIdgActionItemPicker({
  encounterId,
  editable,
  onChanged,
}: ComposerIdgActionItemPickerProps): JSX.Element | null {
  const client = useApiClient();
  const { load, anchor, reading, isSaving, problem, said, retry, save } = useSerializedListPicker<
    IdgActionItemsView,
    IdgState
  >({
    read: () => loadIdgActionItems(client, encounterId),
    readOn: [client, encounterId],
    classify: classifyIdg,
    // A note (nothing to choose, no key, no list) stays while the list is read again after a clear: it is not blanked, and the focus on it is not lost.
    keepWhileReading: ["empty", "no-access", "unavailable"],
    signatureOf: linkedIdOf,
    onChanged,
  });
  const uid = useId();
  const noteId = `${uid}-note`;
  const reasonId = `${uid}-reason`;
  const descriptionId = `${uid}-description`;
  const group = useRef<HTMLDivElement>(null);

  const choose = (actionItemId: string | null): void => {
    if (!editable) return;
    const words = { refusalWords, notConfirmedWords: NOT_CONFIRMED_WORDS };
    void save(
      () => setIdgActionItem(client, encounterId, actionItemId),
      actionItemId === null
        ? {
            ...words,
            savedWords: CLEARED_WORDS,
            settle: () => afterClear(load),
            rereadAfter: true,
          }
        : { ...words, savedWords: "Follow-up item saved." },
    );
  };
  /** Always on the page (a region mounted with its text is not announced): says the change is being saved, and that it was. */
  const status = <output className="wx-sr-only">{isSaving ? "Saving…" : said}</output>;
  const clearButton = editable ? (
    <Button
      tone="tertiary"
      size="sm"
      aria-disabled={isSaving || undefined}
      onClick={() => choose(null)}
    >
      {CLEAR_LABEL}
    </Button>
  ) : null;

  if (load.status === "loading" || load.status === "none") return null;
  if (load.status === "error") {
    return (
      <PickerRetryPanel
        anchor={anchor}
        title={TITLE}
        icon="calendar-check"
        words={load.attempt > 1 ? stillCouldNotLoadWords(load.attempt) : COULD_NOT_LOAD_WORDS}
        problem={problem}
        reading={reading}
        onRetry={retry}
      >
        {clearButton}
        {status}
      </PickerRetryPanel>
    );
  }
  if (load.status !== "ready") {
    const words =
      load.status === "unavailable"
        ? UNAVAILABLE_WORDS
        : `${load.status === "empty" ? EMPTY_WORDS : NO_ACCESS_WORDS}${editable ? DOCUMENT_BELOW : ""}`;
    return (
      <fieldset ref={anchor} tabIndex={-1} className="wx-fieldset-reset" aria-describedby={noteId}>
        <legend className="wx-sr-only">{TITLE}</legend>
        <Panel title={TITLE} icon="calendar-check" stack>
          {status}
          {/* A note that is already there when the panel mounts: the panel is described by it for the reader the focus moves to. */}
          <div id={noteId}>
            <InlineAlert tone="info" live={false}>
              {words}
            </InlineAlert>
          </div>
          {problem && !(load.status === "no-access" && problem === LOST_KEY_REFUSAL_WORDS) ? (
            <InlineAlert tone="error">{problem}</InlineAlert>
          ) : null}
          {/* Clearing needs no key and no M14, and a link the list no longer shows (reassigned, Part 2) can only be ended here. */}
          {(load.status === "no-access" || load.status === "empty") && clearButton ? (
            <div>{clearButton}</div>
          ) : null}
        </Panel>
      </fieldset>
    );
  }

  const { items } = load;
  const linked = items.find((item) => item.linked);
  const reason = !editable ? NOT_A_DRAFT_REASON : isSaving ? SAVING_REASON : null;

  const option = (
    id: string,
    checked: boolean,
    actionItemId: string | null,
    label: ReactNode,
  ): JSX.Element => (
    <div key={id} className="wx-action-check">
      <input
        id={id}
        type="radio"
        name={uid}
        checked={checked}
        aria-disabled={isSaving || undefined}
        aria-describedby={reason ? reasonId : undefined}
        onChange={() => choose(actionItemId)}
        onKeyDown={(event) => moveOrChoose(event, group.current)}
      />
      <label htmlFor={id}>{label}</label>
    </div>
  );

  return (
    <fieldset
      ref={anchor}
      tabIndex={-1}
      className="wx-fieldset-reset"
      aria-describedby={descriptionId}
    >
      <legend className="wx-sr-only">{TITLE}</legend>
      <Panel
        title={TITLE}
        icon="calendar-check"
        description={
          <span id={descriptionId}>
            {editable ? `${DESCRIPTION_WORDS}${CHOOSE_WORDS}` : DESCRIPTION_WORDS}
          </span>
        }
        stack
      >
        {status}
        {editable ? (
          <div ref={group} className="wx-form-stack">
            {items.map((item) =>
              option(
                `${uid}-${item.actionItemId}`,
                item.linked,
                item.actionItemId,
                <ItemWords item={item} />,
              ),
            )}
            {option(`${uid}-none`, linked === undefined, null, NO_ITEM_LABEL)}
          </div>
        ) : (
          <p>{linked ? <ItemWords item={linked} /> : NO_ITEM_CHOSEN_WORDS}</p>
        )}
        {/* No listed item is linked, yet the visit may still be linked to one the list no longer shows: only a clear can end that (it needs no key and no M14). */}
        {editable && linked === undefined ? <div>{clearButton}</div> : null}
        {linked && !isOpen(linked) ? (
          <p className="wx-row-sub">
            {LINKED_CLOSED_WORDS}
            {editable ? CHANGE_CLOSED_WORDS : ""}
          </p>
        ) : null}
        {/* After the list: it comes and goes with every save, and above it it would move every row under the person's pointer. */}
        {reason ? (
          <p id={reasonId} className="wx-row-sub">
            {reason}
          </p>
        ) : null}
        {editable ? (
          <p className="wx-row-sub">
            Changing the item changes the drafted section, so confirm it again.
          </p>
        ) : null}
        {problem ? <InlineAlert tone="error">{problem}</InlineAlert> : null}
      </Panel>
    </fieldset>
  );
}
