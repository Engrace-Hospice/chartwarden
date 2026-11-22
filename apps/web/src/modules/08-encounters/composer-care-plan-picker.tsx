// apps/web/src/modules/08-encounters — the care-plan picker of the visit-note composer (M8 spec §5.2; ADR-0114 VN-D8, VN-D15). The goals and
// interventions the visit may address, each linked to this visit or not. Until now the picker lived only on Encounter Read.
//
// LINK RULES. A link ties an element to THIS visit; a note never changes the care plan. Confirming a drafted section links its goals and
// interventions; deselecting one unlinks them (and the same list shows it). Linking an element again here brings it back into the
// draft. Both directions change what the draft is built from, so the caller re-reads the draft after every change here (`onChanged`),
// and re-reads this list when a draft resolve changed the visit's links (`revision`). The server is the judge of every link: a refusal is
// shown in words and the checkbox stays where the server left it.
//
// LINKS KNOWN. The boxes show which elements are linked, so they are offered only once the visit's links have been read: until then (or
// when that read failed, which says so and offers a retry in place of the boxes) every box would read "not linked", and ticking a linked
// goal would add it twice.
// A box that cannot act says why beside it, because a disabled control cannot be focused to find the reason. While a change is being saved the
// boxes are not `disabled` for the same reason (the one pressed would drop keyboard focus): they say so with `aria-disabled` and do nothing.
// The same holds while links that are already known are read again (a draft resolve changed them, or a save left a re-read owed): only the
// FIRST read, when nothing is known, leaves the boxes natively `disabled`.
// ORDER. A re-read of the links that began before a change committed may answer after it: that answer is dropped and the links are read once
// more when the change has settled, so an older picture never lands over a newer one.
//
// NO EMPTY FRAME: a visit with no care plan, no linkable goals or interventions, or a viewer who may not read them shows nothing.
import { Button, InlineAlert, Panel, useApiClient } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import {
  type CarePlanLink,
  type LinkTarget,
  type PickerEncounter,
  type RelevantElements,
  describeDraftRefusal,
  linkCarePlanElement,
  loadCarePlanLinks,
  loadRelevantElements,
  unlinkCarePlanElement,
} from "./draft-api";
import { useIsMounted } from "./use-is-mounted";

export interface ComposerCarePlanPickerProps {
  readonly encounter: PickerEncounter;
  /** Links can change only while the note is a draft. */
  readonly editable: boolean;
  /** Bumped when a draft resolve changed this visit's links, so the list re-reads them. */
  readonly revision: number;
  /** A link was added or removed here: the draft is built from the links, so the caller re-reads it. */
  readonly onChanged: () => void;
  /**
   * Whether confirming a drafted section links its care-plan elements to this visit (the default). False for a draft built from the discipline's
   * own plan (S4), which links nothing of the care plan (its own plan items are `ComposerDisciplinePlanPicker`'s, S4b): the footnote that says it does is then left out.
   */
  readonly confirmationLinks?: boolean;
}

type ElementsLoad =
  | { readonly status: "loading" }
  | { readonly status: "none" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly elements: RelevantElements };

interface Row {
  readonly target: LinkTarget;
  readonly label: string;
}

type LinksStatus = "loading" | "error" | "ready";

type LinksChange = (current: readonly CarePlanLink[]) => readonly CarePlanLink[];

const goalRows = (elements: RelevantElements): readonly Row[] =>
  elements.goals.map((goal) => ({
    target: { kind: "goal", id: goal.goalId },
    label: goal.text,
  }));

const interventionRows = (elements: RelevantElements): readonly Row[] =>
  elements.interventions.map((intervention) => ({
    target: { kind: "intervention", id: intervention.interventionId },
    label: intervention.frequencyText
      ? `${intervention.scopeText} · ${intervention.frequencyText}`
      : intervention.scopeText,
  }));

const linkOf = (links: readonly CarePlanLink[], target: LinkTarget): CarePlanLink | undefined =>
  links.find((link) => (target.kind === "goal" ? link.goalId : link.interventionId) === target.id);

const NOT_SHOWN_STATUSES: readonly number[] = [403, 404];

/** A 200 whose lists are not lists is a broken answer (the picker would throw rendering it): the care plan is then "could not be loaded". */
const hasLinkableLists = (
  elements: RelevantElements | null | undefined,
): elements is RelevantElements =>
  Array.isArray(elements?.goals) && Array.isArray(elements?.interventions);

const NOT_A_DRAFT_REASON = "Links can change only while the note is a draft.";
const LOADING_REASON = "Loading this visit's care-plan links…";
const SAVING_REASON = "Saving the change to this visit's care-plan links…";
const REFRESHING_REASON = "Updating this visit's care-plan links…";
const LINKS_ERROR_REASON =
  "The care-plan links could not be loaded for this visit, so they cannot be changed right now.";
const REASON_ID = "care-plan-picker-reason";

export function ComposerCarePlanPicker({
  encounter,
  editable,
  revision,
  onChanged,
  confirmationLinks = true,
}: ComposerCarePlanPickerProps): JSX.Element | null {
  const client = useApiClient();
  const mounted = useIsMounted();
  const [load, setLoad] = useState<ElementsLoad>({ status: "loading" });
  const [links, setLinks] = useState<readonly CarePlanLink[]>([]);
  const [linksStatus, setLinksStatus] = useState<LinksStatus>("loading");
  // A read of the links is out. With the links already known (`linksStatus` "ready") the boxes wait but stay focusable; with none known they
  // are `disabled` (the status is "loading").
  const [linksReading, setLinksReading] = useState(false);
  const [linksReadKey, setLinksReadKey] = useState(0);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Moves when a change begins and again when it settles (so a read that began in between is told apart), whether a change is being saved,
  // and whether a re-read was dropped meanwhile (and so is owed once it settles).
  const changeEpoch = useRef(0);
  const saving = useRef(false);
  const readOwed = useRef(false);
  const { id: encounterId, patientId, admissionId, encounterType, discipline } = encounter;

  useEffect(() => {
    let active = true;
    setLoad({ status: "loading" });
    void loadRelevantElements(client, {
      id: encounterId,
      patientId,
      admissionId,
      encounterType,
      discipline,
    }).then((outcome) => {
      if (!active) return;
      if (outcome.ok) {
        setLoad(
          hasLinkableLists(outcome.data)
            ? { status: "ready", elements: outcome.data }
            : { status: "error" },
        );
        return;
      }
      setLoad({ status: NOT_SHOWN_STATUSES.includes(outcome.status) ? "none" : "error" });
    });
    return () => {
      active = false;
    };
  }, [client, encounterId, patientId, admissionId, encounterType, discipline]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` and `linksReadKey` are the re-read triggers, not read in the body.
  useEffect(() => {
    let active = true;
    const begunAt = changeEpoch.current;
    // Links known stay known while they are read again; after a failure (or the first time) nothing is known and the read says "loading".
    setLinksStatus((current) => (current === "ready" ? current : "loading"));
    setLinksReading(true);
    void loadCarePlanLinks(client, encounterId).then((outcome) => {
      if (!active) return;
      if (saving.current || changeEpoch.current !== begunAt) {
        // Read before a change committed, answered after it: this picture is older than the one held. Read again once it has settled.
        if (saving.current) readOwed.current = true;
        else setLinksReadKey((key) => key + 1);
        return;
      }
      const read = outcome.ok ? outcome.data?.links : undefined;
      if (Array.isArray(read)) setLinks(read);
      setLinksStatus(Array.isArray(read) ? "ready" : "error");
      setLinksReading(false);
    });
    return () => {
      active = false;
    };
  }, [client, encounterId, revision, linksReadKey]);

  if (load.status === "loading" || load.status === "none") return null;
  if (load.status === "error") {
    return (
      <Panel title="Care plan for this visit" icon="clipboard-list">
        <InlineAlert tone="warning">
          The care plan could not be loaded. Your documentation is not affected.
        </InlineAlert>
      </Panel>
    );
  }

  const goals = goalRows(load.elements);
  const interventions = interventionRows(load.elements);
  if (goals.length + interventions.length === 0 && !load.elements.redacted) return null;

  const reason = !editable
    ? NOT_A_DRAFT_REASON
    : linksStatus === "loading"
      ? LOADING_REASON
      : pendingKey !== null
        ? SAVING_REASON
        : linksReading
          ? REFRESHING_REASON
          : null;
  const linksLocked = !editable || linksStatus !== "ready";

  /** Link or unlink `row`: the change to apply to the held links, or the refusal in words. */
  const send = async (row: Row): Promise<LinksChange | string> => {
    const existing = linkOf(links, row.target);
    if (existing) {
      const outcome = await unlinkCarePlanElement(client, encounterId, existing.id);
      return outcome.ok
        ? (current) => current.filter((link) => link.id !== existing.id)
        : describeDraftRefusal(outcome).message;
    }
    const outcome = await linkCarePlanElement(client, encounterId, row.target);
    return outcome.ok
      ? (current) => [...current, outcome.data]
      : describeDraftRefusal(outcome).message;
  };

  const toggle = async (row: Row): Promise<void> => {
    if (pendingKey !== null || linksLocked || linksReading) return;
    setPendingKey(row.target.id);
    setProblem(null);
    changeEpoch.current += 1;
    saving.current = true;
    const result = await send(row);
    saving.current = false;
    changeEpoch.current += 1;
    if (!mounted.current) return;
    setPendingKey(null);
    if (readOwed.current) {
      readOwed.current = false;
      setLinksReadKey((key) => key + 1);
    }
    if (typeof result === "string") {
      setProblem(result);
      return;
    }
    setLinks(result);
    onChanged();
  };

  const group = (legend: string, rows: readonly Row[]): JSX.Element | null =>
    rows.length === 0 ? null : (
      <fieldset className="wx-form-stack wx-fieldset-reset">
        <legend>{legend}</legend>
        {rows.map((row) => {
          const inputId = `care-plan-${row.target.kind}-${row.target.id}`;
          return (
            <div key={inputId} className="wx-action-check">
              <input
                id={inputId}
                type="checkbox"
                checked={linkOf(links, row.target) !== undefined}
                disabled={linksLocked}
                aria-disabled={pendingKey !== null || linksReading || undefined}
                aria-describedby={reason ? REASON_ID : undefined}
                onChange={() => void toggle(row)}
              />
              <label htmlFor={inputId}>{row.label}</label>
            </div>
          );
        })}
      </fieldset>
    );

  return (
    <Panel
      title="Care plan for this visit"
      icon="clipboard-list"
      description="A link ties an item to this visit only. The care plan itself is never changed."
      stack
    >
      {linksStatus === "error" ? (
        // Not the boxes: with the links unknown every box would read "not linked" (or show a stale tick), and none could be trusted.
        <>
          <InlineAlert tone="warning" live={false}>
            {LINKS_ERROR_REASON}
          </InlineAlert>
          <div>
            <Button tone="secondary" size="sm" onClick={() => setLinksReadKey((key) => key + 1)}>
              Try again
            </Button>
          </div>
        </>
      ) : (
        <>
          {reason ? (
            <p id={REASON_ID} className="wx-row-sub">
              {reason}
            </p>
          ) : null}
          {group("Goals worked toward", goals)}
          {group("Interventions performed", interventions)}
        </>
      )}
      {load.elements.redacted ? (
        <p className="wx-row-sub">Some items are hidden by privacy or consent settings.</p>
      ) : null}
      {confirmationLinks ? (
        <p className="wx-row-sub">
          Confirming a drafted section links its goals and interventions here. Deselecting it
          unlinks them.
        </p>
      ) : null}
      {problem ? <InlineAlert tone="error">{problem}</InlineAlert> : null}
    </Panel>
  );
}
