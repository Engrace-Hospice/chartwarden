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
// box never stays where the server no longer has it.
//
// FOCUS, THE RETRY AND THE ORDER OF READS AND CHANGES are `useSerializedListPicker`'s (shared with the IDG action item picker). A read that finds nothing to
// show says so while someone waits on it; a retry that fails again says "still", with its attempt number so a reader hears the change; a refusal stays
// on the page when the re-read fails too.
//
// NO EMPTY FRAME: a visit with no plan list (not drafted from the discipline's plan, or a viewer who may not read it) or an empty plan shows nothing.
import { InlineAlert, Panel, useApiClient } from "@chartwarden/ui";
import type { JSX } from "react";
import {
  type DisciplinePlanElement,
  type DisciplinePlanElementsView,
  type Outcome,
  describeDraftRefusal,
  loadDisciplinePlanElements,
  setDisciplinePlanElement,
} from "./draft-api";
import { disciplinePlanTitle } from "./draft-model";
import { PickerRetryPanel } from "./picker-retry-panel";
import { useSerializedListPicker } from "./use-serialized-list-picker";

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

type PlanState =
  /** A visit with no plan list (not drafted from the discipline's plan, or a viewer who may not read it), or an empty plan: the panel takes no room. */
  | { readonly status: "none" }
  /** A read someone was waiting on (a retry, or after a refused change) found nothing to show: the panel stays and says so. */
  | { readonly status: "nothing" }
  | { readonly status: "ready"; readonly elements: readonly DisciplinePlanElement[] };

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

/** What an answer is: a list to show, "no list" (the panel takes no room, or says so for someone who waited), or a failure to try again. */
function classifyPlan(
  outcome: Outcome<DisciplinePlanElementsView>,
  waited: boolean,
): PlanState | null {
  const hidden: PlanState = { status: waited ? "nothing" : "none" };
  if (!outcome.ok) return NOT_SHOWN_STATUSES.includes(outcome.status) ? hidden : null;
  const read = outcome.data?.elements;
  if (!Array.isArray(read)) return null;
  return read.length > 0 ? { status: "ready", elements: read } : hidden;
}

export function ComposerDisciplinePlanPicker({
  encounterId,
  discipline,
  editable,
  revision,
  onChanged,
}: ComposerDisciplinePlanPickerProps): JSX.Element | null {
  const client = useApiClient();
  const { load, anchor, reading, isSaving, problem, said, retry, save } = useSerializedListPicker<
    DisciplinePlanElementsView,
    PlanState
  >({
    read: () => loadDisciplinePlanElements(client, encounterId),
    readOn: [client, encounterId, revision],
    classify: classifyPlan,
    onChanged,
  });
  const title = disciplinePlanTitle(discipline);

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
      <PickerRetryPanel
        anchor={anchor}
        title={title}
        icon="clipboard-list"
        words={load.attempt > 1 ? stillCouldNotLoadWords(load.attempt) : COULD_NOT_LOAD_WORDS}
        problem={problem}
        reading={reading}
        onRetry={retry}
      />
    );
  }

  const { elements } = load;
  const reason = !editable ? NOT_A_DRAFT_REASON : isSaving ? SAVING_REASON : null;

  const toggle = (element: DisciplinePlanElement): void => {
    if (!editable) return;
    void save(
      () => setDisciplinePlanElement(client, encounterId, element.elementId, !element.kept),
      { refusalWords, notConfirmedWords: NOT_CONFIRMED_WORDS, savedWords: "Saved." },
    );
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
                aria-disabled={isSaving || undefined}
                aria-describedby={reason ? REASON_ID : undefined}
                onChange={() => toggle(element)}
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
        <output className="wx-sr-only">{isSaving ? "Saving…" : said}</output>
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
