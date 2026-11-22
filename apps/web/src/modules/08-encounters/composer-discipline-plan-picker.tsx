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
// `aria-disabled` and do nothing (the one pressed would otherwise drop keyboard focus).
//
// NO EMPTY FRAME: a visit with no plan list (not drafted from the discipline's plan, or a viewer who may not read it) or an empty plan shows nothing.
import { Button, InlineAlert, Panel, useApiClient } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import {
  type DisciplinePlanElement,
  describeDraftRefusal,
  loadDisciplinePlanElements,
  setDisciplinePlanElement,
} from "./draft-api";
import { useIsMounted } from "./use-is-mounted";

export interface ComposerDisciplinePlanPickerProps {
  readonly encounterId: string;
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
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly elements: readonly DisciplinePlanElement[] };

/** The statuses that mean "this visit has no plan list for you": the panel then takes no room. */
const NOT_SHOWN_STATUSES: readonly number[] = [403, 404, 422];

const NOT_A_DRAFT_REASON = "Items can change only while the note is a draft.";
const SAVING_REASON = "Saving the change to this visit's plan items…";
const REASON_ID = "discipline-plan-picker-reason";

export function ComposerDisciplinePlanPicker({
  encounterId,
  editable,
  revision,
  onChanged,
}: ComposerDisciplinePlanPickerProps): JSX.Element | null {
  const client = useApiClient();
  const mounted = useIsMounted();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [readKey, setReadKey] = useState(0);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Moves when a change begins and again when it settles, so a read that began in between is told apart from the one held.
  const changeEpoch = useRef(0);
  const saving = useRef(false);
  const readOwed = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` and `readKey` are the re-read triggers, not read in the body.
  useEffect(() => {
    let active = true;
    const begunAt = changeEpoch.current;
    // The list known stays known while it is read again; after a failure (or the first time) nothing is known.
    setLoad((current) => (current.status === "ready" ? current : { status: "loading" }));
    void loadDisciplinePlanElements(client, encounterId).then((outcome) => {
      if (!active) return;
      if (saving.current || changeEpoch.current !== begunAt) {
        // Read before a change committed, answered after it: older than the list held. Read again once the change has settled.
        if (saving.current) readOwed.current = true;
        else setReadKey((key) => key + 1);
        return;
      }
      if (outcome.ok) {
        const read = outcome.data?.elements;
        setLoad(Array.isArray(read) ? { status: "ready", elements: read } : { status: "error" });
        return;
      }
      setLoad({ status: NOT_SHOWN_STATUSES.includes(outcome.status) ? "none" : "error" });
    });
    return () => {
      active = false;
    };
  }, [client, encounterId, revision, readKey]);

  if (load.status === "loading" || load.status === "none") return null;
  if (load.status === "error") {
    return (
      <Panel title="Plan of care for this visit" icon="clipboard-list">
        <InlineAlert tone="warning">
          The plan items could not be loaded. Your documentation is not affected.
        </InlineAlert>
        <div>
          <Button tone="secondary" size="sm" onClick={() => setReadKey((key) => key + 1)}>
            Try again
          </Button>
        </div>
      </Panel>
    );
  }

  const { elements } = load;
  if (elements.length === 0) return null;
  const reason = !editable ? NOT_A_DRAFT_REASON : pendingId !== null ? SAVING_REASON : null;

  const toggle = async (element: DisciplinePlanElement): Promise<void> => {
    if (!editable || pendingId !== null) return;
    setPendingId(element.elementId);
    setProblem(null);
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
      setProblem(describeDraftRefusal(outcome).message);
      return;
    }
    if (Array.isArray(outcome.data?.elements)) {
      setLoad({ status: "ready", elements: outcome.data.elements });
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
    <Panel
      title="Plan of care for this visit"
      icon="clipboard-list"
      description="Untick what this visit does not keep. The plan itself is never changed."
      stack
    >
      {reason ? (
        <p id={REASON_ID} className="wx-row-sub">
          {reason}
        </p>
      ) : null}
      {group("Goals", "goal")}
      {group("Interventions", "intervention")}
      <p className="wx-row-sub">
        Confirming a drafted section keeps its items here. Deselecting it leaves them out.
      </p>
      {problem ? <InlineAlert tone="error">{problem}</InlineAlert> : null}
    </Panel>
  );
}
