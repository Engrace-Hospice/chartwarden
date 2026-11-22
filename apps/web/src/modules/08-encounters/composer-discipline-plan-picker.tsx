// apps/web/src/modules/08-encounters — the plan picker of a social-work or chaplain visit's composer (ADR-0114 S4b, VN-D60, VN-D63). The goals and
// interventions of the discipline's own plan in effect at the visit, each kept in this visit's statement of the plan or left out. The server decides
// everything: what this viewer is handed (a Part 2 item a viewer may not read is not in the list), who may change it, and the one change per box; this
// shows the list, sends the one change and takes the server's answer.
//
// KEPT. A box is ticked when the visit keeps the element (the default: nothing is left out until the clinician says so). Unticking leaves it out of the
// drafted section, which changes the section, so a section already confirmed needs confirming again; ticking it brings it back. Confirming or deselecting a
// drafted section does the same to the section's items, so the caller re-reads the draft after every change here (`onChanged`) and this re-reads the list
// when a draft resolve changed it (`revision`). A change is one request at a time, and a re-read that was served before a change settled never lands over it.
// A box that cannot act says why beside it, because a disabled control cannot be focused to find the reason: while a change is saved the boxes are
// `aria-disabled` and do nothing (the one pressed would otherwise drop keyboard focus), and a status that was already on the page says "Saving…" and
// "Saved." for a reader who cannot see the box. A change the server did not take (a refusal, or an answer that is not a list) reads the list again, so a
// box never stays where the server no longer has it. After a failed read, "Try again" keeps the panel on the page (the focused button is not unmounted
// for a blank one) and the panel takes the focus when the list arrives.
//
// FOCUS. When an answer replaces the control that held the focus (a retry button that gives way to the list, a box whose item was withdrawn, the list
// that gives way to the error or the "nothing to show" panel) the panel takes the focus, instead of it dropping to the page. Focus that was already
// elsewhere, or on a control that is still there, is never moved. A read that finds nothing to show says so while someone waits on it; a retry that
// fails again says "still", with its attempt number so a reader hears the change; a refusal stays on the page when the re-read fails too.
//
// NO EMPTY FRAME: a visit with no plan list (not drafted from the discipline's plan, or a viewer who may not read it) or an empty plan shows nothing.
import { Button, InlineAlert, Panel, useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import {
  type DisciplinePlanElement,
  describeDraftRefusal,
  loadDisciplinePlanElements,
  setDisciplinePlanElement,
} from "./draft-api";
import { disciplinePlanTitle } from "./draft-model";
import { useFocusRequest } from "./use-focus-request";
import { useIsMounted } from "./use-is-mounted";

export interface ComposerDisciplinePlanPickerProps {
  readonly encounterId: string;
  /** Names the panel (a social worker's plan, a chaplain's), so it is not mistaken for the care plan's panel beside it. */
  readonly discipline: string;
  /** Items can change only while the note is a draft. */
  readonly editable: boolean;
  /** Bumped when a draft resolve changed which items the visit keeps, so the list re-reads. */
  readonly revision: number;
  /** An item was kept or left out here: the draft is built from them, so the caller re-reads it. */
  readonly onChanged: () => void;
}

type Load =
  | { readonly status: "loading" }
  | { readonly status: "none" }
  /** A read someone was waiting on (a retry, or after a refused change) found nothing to show: the panel stays and says so. */
  | { readonly status: "nothing" }
  /** `attempt`: 1 for the first failure; a retry that fails again counts up, so its words change and are announced. */
  | { readonly status: "error"; readonly attempt: number }
  | { readonly status: "ready"; readonly elements: readonly DisciplinePlanElement[] };

/** A read a person is waiting on: "Try again" was pressed, or a change was refused and the list is read again. */
type WaitedOn = "retry" | "refusal" | null;

/** The statuses that mean "this visit has no plan list for you": the panel then takes no room. */
const NOT_SHOWN_STATUSES: readonly number[] = [403, 404, 422];

const NOT_A_DRAFT_REASON = "Items can change only while the note is a draft.";
const SAVING_REASON = "Saving the change to this visit's plan items…";
const REASON_ID = "discipline-plan-picker-reason";
const NOT_CONFIRMED_WORDS = "Could not confirm the change. Check the list before you go on.";
const COULD_NOT_LOAD_WORDS =
  "The plan items could not be loaded. Your documentation is not affected.";
const stillCouldNotLoadWords = (attempt: number): string =>
  `Still could not load the plan items (attempt ${attempt}). Your documentation is not affected.`;
const NOTHING_ID = "discipline-plan-picker-nothing";
const NOTHING_TO_SHOW_WORDS = "There are no plan items to show for this visit.";

/** What a refused change says: the picker's own words for the two answers the shared copy words for the addendum, the shared copy for the rest. */
function refusalWords(failure: { readonly status: number; readonly error: unknown }): string {
  if (failure.status === 404) {
    return "That item is no longer in this visit's plan, so nothing was changed.";
  }
  if (failure.status === 422) {
    return "This note is not drafted from a plan, so its items cannot be changed here.";
  }
  return describeDraftRefusal(failure).message;
}

export function ComposerDisciplinePlanPicker({
  encounterId,
  discipline,
  editable,
  revision,
  onChanged,
}: ComposerDisciplinePlanPickerProps): JSX.Element | null {
  const client = useApiClient();
  const mounted = useIsMounted();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [readKey, setReadKey] = useState(0);
  // A read is out. After a failure the panel stays (waiting) while it is read again; the first read shows nothing.
  const [reading, setReading] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const [anchor, focusAnchor] = useFocusRequest<HTMLFieldSetElement>();
  const title = disciplinePlanTitle(discipline);
  // Moves when a change begins and again when it settles, so a read that began in between is told apart from the one held.
  const changeEpoch = useRef(0);
  const saving = useRef(false);
  const readOwed = useRef(false);
  // Set when a read is being waited on, and spent by the read that settles (whatever it finds): a later read that nobody waits on never moves the focus.
  const waitedOn = useRef<WaitedOn>(null);
  const failedReads = useRef(0);
  // Whether the focus sat inside the panel when the answer that replaces its content was taken (see FOCUS above); spent after the commit.
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` and `readKey` are the re-read triggers, not read in the body.
  useEffect(() => {
    let active = true;
    const begunAt = changeEpoch.current;
    // The list known stays known while it is read again, and so does the failure (its retry button keeps the focus); the first time nothing is known.
    setLoad((current) =>
      current.status === "ready" || current.status === "error" ? current : { status: "loading" },
    );
    setReading(true);
    void loadDisciplinePlanElements(client, encounterId).then((outcome) => {
      if (!active) return;
      if (saving.current || changeEpoch.current !== begunAt) {
        // Read before a change committed, answered after it: older than the list held. Read again once the change has settled.
        if (saving.current) readOwed.current = true;
        else setReadKey((key) => key + 1);
        return;
      }
      setReading(false);
      const waited = waitedOn.current;
      waitedOn.current = null;
      const read = outcome.ok ? outcome.data?.elements : undefined;
      const listed = Array.isArray(read) && read.length > 0;
      const hidden = outcome.ok ? Array.isArray(read) : NOT_SHOWN_STATUSES.includes(outcome.status);
      if (!listed && !hidden) {
        failedReads.current = waited === "retry" ? failedReads.current + 1 : 1;
        showLoad({ status: "error", attempt: failedReads.current });
        return;
      }
      failedReads.current = 0;
      // A retry that was answered settles a refusal that stood beside the failure: the list shown now is the truth about it.
      if (waited === "retry") setProblem(null);
      if (listed) {
        showLoad({ status: "ready", elements: read });
        return;
      }
      // Someone was waiting for this answer and it is "no list": the panel they were in says so, instead of vanishing with their focus.
      showLoad(waited === null ? { status: "none" } : { status: "nothing" });
    });
    return () => {
      active = false;
    };
  }, [client, encounterId, revision, readKey, showLoad]);

  if (load.status === "loading" || load.status === "none") return null;
  if (load.status === "nothing") {
    return (
      <fieldset
        ref={anchor}
        tabIndex={-1}
        className="wx-fieldset-reset"
        aria-describedby={NOTHING_ID}
      >
        <legend className="wx-sr-only">{title}</legend>
        <Panel title={title} icon="clipboard-list" stack>
          {/* The message mounts with the panel, so it is not announced as a region: the panel is described by it for the reader the focus moves to. */}
          <div id={NOTHING_ID}>
            <InlineAlert tone="info">{NOTHING_TO_SHOW_WORDS}</InlineAlert>
          </div>
          {problem ? <InlineAlert tone="error">{problem}</InlineAlert> : null}
        </Panel>
      </fieldset>
    );
  }
  if (load.status === "error") {
    return (
      <fieldset ref={anchor} tabIndex={-1} className="wx-fieldset-reset">
        <legend className="wx-sr-only">{title}</legend>
        <Panel title={title} icon="clipboard-list" stack>
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

  const { elements } = load;
  if (elements.length === 0) return null;
  const reason = !editable ? NOT_A_DRAFT_REASON : pendingId !== null ? SAVING_REASON : null;

  const toggle = async (element: DisciplinePlanElement): Promise<void> => {
    if (!editable || pendingId !== null) return;
    setPendingId(element.elementId);
    setProblem(null);
    setSaid("");
    changeEpoch.current += 1;
    saving.current = true;
    const outcome = await setDisciplinePlanElement(
      client,
      encounterId,
      element.elementId,
      !element.kept,
    );
    saving.current = false;
    changeEpoch.current += 1;
    if (!mounted.current) return;
    setPendingId(null);
    if (readOwed.current) {
      readOwed.current = false;
      setReadKey((key) => key + 1);
    }
    if (!outcome.ok) {
      // The server did not take the change: what it holds may differ from the box (an item withdrawn since), so the list is read again.
      setProblem(refusalWords(outcome));
      waitedOn.current = "refusal";
      setReadKey((key) => key + 1);
      return;
    }
    if (Array.isArray(outcome.data?.elements)) {
      // An emptied plan reads as it does on the first read: the panel says so instead of vanishing under the box that was pressed.
      const { elements: answered } = outcome.data;
      showLoad(
        answered.length > 0 ? { status: "ready", elements: answered } : { status: "nothing" },
      );
      setSaid("Saved.");
    } else {
      setProblem(NOT_CONFIRMED_WORDS);
      waitedOn.current = "refusal";
      setReadKey((key) => key + 1);
    }
    onChanged();
  };

  const group = (legend: string, kind: DisciplinePlanElement["kind"]): JSX.Element | null => {
    const rows = elements.filter((element) => element.kind === kind);
    if (rows.length === 0) return null;
    return (
      <fieldset className="wx-form-stack wx-fieldset-reset">
        <legend>{legend}</legend>
        {rows.map((element) => {
          const inputId = `discipline-plan-${element.kind}-${element.elementId}`;
          return (
            <div key={inputId} className="wx-action-check">
              <input
                id={inputId}
                type="checkbox"
                checked={element.kept}
                disabled={!editable}
                aria-disabled={pendingId !== null || undefined}
                aria-describedby={reason ? REASON_ID : undefined}
                onChange={() => void toggle(element)}
              />
              <label htmlFor={inputId}>{element.text}</label>
            </div>
          );
        })}
      </fieldset>
    );
  };

  return (
    <fieldset ref={anchor} tabIndex={-1} className="wx-fieldset-reset">
      <legend className="wx-sr-only">{title}</legend>
      <Panel
        title={title}
        icon="clipboard-list"
        description="Untick what this visit does not keep. The plan itself is never changed."
        stack
      >
        {/* Always on the page (a region mounted with its text is not announced): says the change is being saved, and that it was. */}
        <output className="wx-sr-only">{pendingId !== null ? "Saving…" : said}</output>
        {group("Goals", "goal")}
        {group("Interventions", "intervention")}
        {/* After the lists: it comes and goes with every save, and above them it would move every row under the person's pointer. */}
        {reason ? (
          <p id={REASON_ID} className="wx-row-sub">
            {reason}
          </p>
        ) : null}
        <p className="wx-row-sub">
          Confirming a drafted section keeps its items here. Deselecting it leaves them out.
        </p>
        {problem ? <InlineAlert tone="error">{problem}</InlineAlert> : null}
      </Panel>
    </fieldset>
  );
}
