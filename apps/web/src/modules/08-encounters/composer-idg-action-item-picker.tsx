// apps/web/src/modules/08-encounters — the IDG action item picker of an IDG follow-up visit's composer (ADR-0114 S5b, VN-D64 to VN-D67). The author chooses the ONE
// open IDG action item this visit follows up, or none. The server decides everything: which items this viewer is handed (a Part 2 item a viewer may not read is
// not in the list, and neither is anything without the `idg.read` key), who may change the choice and the cap on changes; this shows the list, sends the one
// change and takes the server's answer. It shows the facts the drafted section states (the meeting date, the decision, the due date, the status) and never an
// item's title or words: the API does not send them.
//
// ONE CHOICE. A radio group plus "No follow-up item"; the checked one is the item the visit is linked to. Choosing changes the section the draft states, so a
// section already confirmed needs confirming again, and the caller re-reads the draft after every change here (`onChanged`). A change is one request at a time, and
// a re-read that was served before a change settled never lands over it. While a change is saved the radios are `aria-disabled` and do nothing (the one pressed
// would otherwise drop keyboard focus), and a status that was already on the page says "Saving…" and "Saved." A change the server did not take (a refusal, or an
// answer that is not a list) reads the list again, so the choice never stays where the server no longer has it.
//
// FOCUS (as the plan picker's). When an answer replaces the control that held the focus (a retry button that gives way to the list, an item that was withdrawn, the
// list that gives way to a note) the panel takes the focus, instead of it dropping to the page. Focus that was already elsewhere, or on a control that is still
// there, is never moved. A retry that fails again says "still", with its attempt number so a reader hears the change.
//
// WHAT THE PANEL SAYS. An empty list says there is no item to choose and that the section is documented below; a role without `idg.read` is told, calmly, that the
// section is not drafted for it (a note, not an error); a visit the server has no list for (no draft switch, not the viewer's, not an IDG follow-up) shows nothing.
import { Button, InlineAlert, Panel, formatDateOnly, useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import {
  type IdgActionItem,
  type IdgActionItemsView,
  type Outcome,
  describeDraftRefusal,
  loadIdgActionItems,
  namesIdgRead,
  setIdgActionItem,
} from "./draft-api";
import { useFocusRequest } from "./use-focus-request";
import { useIsMounted } from "./use-is-mounted";

export interface ComposerIdgActionItemPickerProps {
  readonly encounterId: string;
  /** The choice can change only while the note is a draft. Otherwise the chosen item is shown, without controls. */
  readonly editable: boolean;
  /** The choice changed here: the draft is built from it, so the caller re-reads the draft. */
  readonly onChanged: () => void;
}

type Load =
  | { readonly status: "loading" }
  /** No list for this visit (no draft switch, not the viewer's visit, not an IDG follow-up): the panel takes no room. */
  | { readonly status: "none" }
  | { readonly status: "empty" }
  | { readonly status: "no-access" }
  /** `attempt`: 1 for the first failure; a retry that fails again counts up, so its words change and are announced. */
  | { readonly status: "error"; readonly attempt: number }
  | { readonly status: "ready"; readonly items: readonly IdgActionItem[] };

/** A read a person is waiting on: "Try again" was pressed, or a change was refused and the list is read again. */
type WaitedOn = "retry" | "refusal" | null;

/** The statuses that mean "this visit has no IDG list for you" (a 403 that names `idg.read` is told apart: it has a note). */
const NOT_SHOWN_STATUSES: readonly number[] = [403, 404, 422];

const TITLE = "IDG follow-up item";
const NO_ITEM_ID = "idg-follow-up-none";
const RADIO_NAME = "idg-follow-up-item";
const REASON_ID = "idg-follow-up-reason";
const NOTE_ID = "idg-follow-up-note";
const NOT_A_DRAFT_REASON = "The item can change only while the note is a draft.";
const SAVING_REASON = "Saving the change to this visit's follow-up item…";
const NOT_CONFIRMED_WORDS = "Could not confirm the change. Check the choice before you go on.";
const COULD_NOT_LOAD_WORDS =
  "The IDG action items could not be loaded. Your documentation is not affected.";
const stillCouldNotLoadWords = (attempt: number): string =>
  `Still could not load the IDG action items (attempt ${attempt}). Your documentation is not affected.`;
const EMPTY_WORDS =
  "There is no open IDG action item assigned to you for this patient. This section is not drafted: document it in the note below.";
const NO_ACCESS_WORDS =
  "Your role cannot see IDG action items, so this section is not drafted. Document it in the note below.";
const NO_ITEM_LABEL = "No follow-up item";
const NO_ITEM_CHOSEN_WORDS = "No follow-up item was chosen for this visit.";

/** What a refused change says: the picker's own words for the answers that need them, the shared copy for the rest. */
function refusalWords(failure: { readonly status: number; readonly error: unknown }): string {
  if (failure.status === 404) {
    return "That item is no longer available to you, so nothing was changed. The list shows what is available now.";
  }
  if (failure.status === 422) {
    return "This note is not drafted from an IDG action item, so nothing was changed.";
  }
  if (failure.status === 403 && namesIdgRead(failure.error)) {
    return "Your role cannot see IDG action items, so nothing was changed.";
  }
  return describeDraftRefusal(failure).message;
}

const STATUS_WORDS: Readonly<Record<IdgActionItem["status"], string>> = {
  open: "Open",
  in_progress: "In progress",
};

/** One item in words: the team's decision (a label such as "a referral"), then when they met, when it is due and where it stands. */
function ItemWords({ item }: { readonly item: IdgActionItem }): JSX.Element {
  const facts = [
    `Meeting ${formatDateOnly(item.meetingDate)}`,
    item.dueDate === null ? "No due date" : `Due ${formatDateOnly(item.dueDate)}`,
    STATUS_WORDS[item.status],
  ].join(" · ");
  return (
    <>
      <span>Decision: {item.decisionLabel}</span> <span className="wx-row-sub">{facts}</span>
    </>
  );
}

/** What a read found, as the state it gives the panel; null when it failed (an answer that is not a list too) and is to be tried again. */
function readOf(outcome: Outcome<IdgActionItemsView>): Load | null {
  if (outcome.ok) {
    const items = outcome.data?.items;
    if (!Array.isArray(items)) return null;
    return items.length > 0 ? { status: "ready", items } : { status: "empty" };
  }
  if (outcome.status === 403 && namesIdgRead(outcome.error)) return { status: "no-access" };
  return NOT_SHOWN_STATUSES.includes(outcome.status) ? { status: "none" } : null;
}

export function ComposerIdgActionItemPicker({
  encounterId,
  editable,
  onChanged,
}: ComposerIdgActionItemPickerProps): JSX.Element | null {
  const client = useApiClient();
  const mounted = useIsMounted();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [readKey, setReadKey] = useState(0);
  // A read is out. After a failure the panel stays (waiting) while it is read again; the first read shows nothing.
  const [reading, setReading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const [anchor, focusAnchor] = useFocusRequest<HTMLFieldSetElement>();
  // Moves when a change begins and again when it settles, so a read that began in between is told apart from the one held.
  const changeEpoch = useRef(0);
  const saveInFlight = useRef(false);
  const readOwed = useRef(false);
  // Set when a read is being waited on, and spent by the read that settles (whatever it finds): a later read that nobody waits on never moves the focus.
  const waitedOn = useRef<WaitedOn>(null);
  const failedReads = useRef(0);
  // Whether the focus sat inside the panel when the answer that replaces its content was taken; spent after the commit.
  const heldInside = useRef(false);
  const showLoad = useCallback(
    (next: Load): void => {
      heldInside.current = anchor.current?.contains(document.activeElement) ?? false;
      setLoad(next);
    },
    [anchor],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `load` is the commit this runs after, not read in the body.
  useEffect(() => {
    if (!heldInside.current) return;
    heldInside.current = false;
    if (!anchor.current?.contains(document.activeElement)) focusAnchor();
  }, [load, anchor, focusAnchor]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `readKey` is the re-read trigger, not read in the body.
  useEffect(() => {
    let active = true;
    const begunAt = changeEpoch.current;
    // The list known stays known while it is read again, and so does the failure (its retry button keeps the focus).
    setReading(true);
    void loadIdgActionItems(client, encounterId).then((outcome) => {
      if (!active) return;
      if (saveInFlight.current || changeEpoch.current !== begunAt) {
        // Read before a change committed, answered after it: older than the list held. Read again once the change has settled.
        if (saveInFlight.current) readOwed.current = true;
        else setReadKey((key) => key + 1);
        return;
      }
      setReading(false);
      const waited = waitedOn.current;
      waitedOn.current = null;
      const found = readOf(outcome);
      if (found === null) {
        failedReads.current = waited === "retry" ? failedReads.current + 1 : 1;
        showLoad({ status: "error", attempt: failedReads.current });
        return;
      }
      failedReads.current = 0;
      // A retry that was answered settles a refusal that stood beside the failure: the list shown now is the truth about it.
      if (waited === "retry") setProblem(null);
      // Someone was waiting for this answer and it is "no list": the panel they were in says so, instead of vanishing with their focus.
      showLoad(found.status === "none" && waited !== null ? { status: "empty" } : found);
    });
    return () => {
      active = false;
    };
  }, [client, encounterId, readKey, showLoad]);

  if (load.status === "loading" || load.status === "none") return null;
  if (load.status === "empty" || load.status === "no-access") {
    return (
      <fieldset ref={anchor} tabIndex={-1} className="wx-fieldset-reset" aria-describedby={NOTE_ID}>
        <legend className="wx-sr-only">{TITLE}</legend>
        <Panel title={TITLE} icon="calendar-check" stack>
          {/* A note that is already there when the panel mounts: the panel is described by it for the reader the focus moves to. */}
          <div id={NOTE_ID}>
            <InlineAlert tone="info" live={false}>
              {load.status === "empty" ? EMPTY_WORDS : NO_ACCESS_WORDS}
            </InlineAlert>
          </div>
          {problem && load.status === "empty" ? (
            <InlineAlert tone="error">{problem}</InlineAlert>
          ) : null}
        </Panel>
      </fieldset>
    );
  }
  if (load.status === "error") {
    return (
      <fieldset ref={anchor} tabIndex={-1} className="wx-fieldset-reset">
        <legend className="wx-sr-only">{TITLE}</legend>
        <Panel title={TITLE} icon="calendar-check" stack>
          {/* One region for the first failure and the next: its text changing is what a reader who cannot see the button is told. */}
          <InlineAlert tone="warning">
            {load.attempt > 1 ? stillCouldNotLoadWords(load.attempt) : COULD_NOT_LOAD_WORDS}
          </InlineAlert>
          {/* A refused change whose re-read failed too: the person is still told the change was not saved. */}
          {problem ? <InlineAlert tone="error">{problem}</InlineAlert> : null}
          <div>
            <Button
              tone="secondary"
              size="sm"
              aria-disabled={reading || undefined}
              onClick={() => {
                if (reading) return;
                waitedOn.current = "retry";
                setReadKey((key) => key + 1);
              }}
            >
              {reading ? "Trying again…" : "Try again"}
            </Button>
          </div>
        </Panel>
      </fieldset>
    );
  }

  const { items } = load;
  const linked = items.find((item) => item.linked);
  const reason = !editable ? NOT_A_DRAFT_REASON : isSaving ? SAVING_REASON : null;

  const choose = async (actionItemId: string | null): Promise<void> => {
    if (!editable || isSaving) return;
    setIsSaving(true);
    setProblem(null);
    setSaid("");
    changeEpoch.current += 1;
    saveInFlight.current = true;
    const outcome = await setIdgActionItem(client, encounterId, actionItemId);
    saveInFlight.current = false;
    changeEpoch.current += 1;
    if (!mounted.current) return;
    setIsSaving(false);
    if (readOwed.current) {
      readOwed.current = false;
      setReadKey((key) => key + 1);
    }
    if (!outcome.ok) {
      // The server did not take the change: what it holds may differ from the choice (an item closed since), so the list is read again.
      setProblem(refusalWords(outcome));
      waitedOn.current = "refusal";
      setReadKey((key) => key + 1);
      return;
    }
    if (Array.isArray(outcome.data?.items)) {
      const { items: answered } = outcome.data;
      showLoad(answered.length > 0 ? { status: "ready", items: answered } : { status: "empty" });
      setSaid(actionItemId === null ? "Follow-up item cleared." : "Follow-up item saved.");
    } else {
      setProblem(NOT_CONFIRMED_WORDS);
      waitedOn.current = "refusal";
      setReadKey((key) => key + 1);
    }
    onChanged();
  };

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
        name={RADIO_NAME}
        checked={checked}
        aria-disabled={isSaving || undefined}
        aria-describedby={reason ? REASON_ID : undefined}
        onChange={() => void choose(actionItemId)}
      />
      <label htmlFor={id}>{label}</label>
    </div>
  );

  return (
    <fieldset ref={anchor} tabIndex={-1} className="wx-fieldset-reset">
      <legend className="wx-sr-only">{TITLE}</legend>
      <Panel
        title={TITLE}
        icon="calendar-check"
        description="Choose the one IDG action item this visit follows up. The drafted section states its meeting date, decision and due date."
        stack
      >
        {/* Always on the page (a region mounted with its text is not announced): says the change is being saved, and that it was. */}
        <output className="wx-sr-only">{isSaving ? "Saving…" : said}</output>
        {editable ? (
          <div className="wx-form-stack">
            {items.map((item) =>
              option(
                `idg-follow-up-${item.actionItemId}`,
                item.linked,
                item.actionItemId,
                <ItemWords item={item} />,
              ),
            )}
            {option(NO_ITEM_ID, linked === undefined, null, NO_ITEM_LABEL)}
          </div>
        ) : (
          <p>{linked ? <ItemWords item={linked} /> : NO_ITEM_CHOSEN_WORDS}</p>
        )}
        {/* After the list: it comes and goes with every save, and above it it would move every row under the person's pointer. */}
        {reason ? (
          <p id={REASON_ID} className="wx-row-sub">
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
