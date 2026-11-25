// apps/web/src/modules/09-assessments/wounds — the visit note's WOUNDS panel (mounted by the note composer).
//
// Wounds are a longitudinal record owned by M9: the patient has wounds, each visit adds dated observations, and the
// note STATES the observations recorded at its encounter. So this panel does not hold wound data of its own. It lists
// the patient's open wounds, shows for each whether an observation tagged to THIS encounter exists (and what it
// says), and records or corrects that observation through the same form the Wounds screen uses, with
// `sourceEncounterId` set to the encounter. A wound found at this visit can be registered here and observed at once.
//
// A wound closed at this visit stays in the panel while its observation here is the latest, so the note keeps stating it.
// `disabled` (the note is signed, locked, or the composer is saving) leaves the panel readable and removes every write; an open form
// stays on screen with its fields disabled, so what was typed survives a save elsewhere in the note.
import {
  type ApiClient,
  Button,
  EmptyState,
  InlineAlert,
  LoadingSpinner,
  type OpsFailure,
  StatusPill,
  useApiClient,
  useLoad,
  useReloadFocus,
} from "@chartwarden/ui";
import { type JSX, useEffect, useId, useState } from "react";
import { type PanelStatusListener, useReportPanelStatus } from "../../../shell/panel-status";
import {
  type NoWoundConcernsControl,
  useNoWoundConcernsStatement,
} from "./no-wound-concerns-statement";
import { measurementWithArea, shortDate } from "./wound-format";
import { ETIOLOGY_LABELS, STAGE_LABELS, STATUS_LABELS, siteHeading } from "./wound-labels";
import { WoundObservationFacts } from "./wound-observation-facts";
import { WoundObservationForm } from "./wound-observation-form";
import { WoundRegisterForm } from "./wound-register-form";
import {
  WOUND_ERROR_COPY,
  type WoundListItem,
  type WoundObservation,
  type WoundView,
  fetchWound,
  fetchWounds,
} from "./wounds-api";

export interface VisitWoundsPanelProps {
  /** The visit the note is for: observations recorded here are tagged to it. */
  readonly encounterId: string;
  readonly patientId: string;
  /** The note cannot be changed (signed or locked): the panel reads, and offers no write. */
  readonly disabled?: boolean;
  /** Fires after any successful write, so the composer can refresh its note preview. */
  readonly onChanged?: () => void;
  /** Told whether a form holds unsaved input and whether a write is in flight (see `useReportPanelStatus`). */
  readonly onStatusChange?: PanelStatusListener;
  /**
   * The clinician's "No skin or wound concerns at this visit" statement, held in the section's free text by the composer. Absent: the
   * panel offers no such statement. See `no-wound-concerns-statement.tsx`.
   */
  readonly noConcerns?: NoWoundConcernsControl;
}

/** One wound with the observation of it made at this visit, when there is one. */
interface VisitWound {
  readonly wound: WoundListItem;
  readonly atThisVisit: WoundObservation | null;
  /** This wound's own record could not be read, so whether it was observed at this visit is not known. */
  readonly unreadable: boolean;
}

type Editing =
  | { readonly kind: "none" }
  | { readonly kind: "register" }
  | { readonly kind: "observe"; readonly wound: WoundView }
  | { readonly kind: "correct"; readonly wound: WoundView; readonly observation: WoundObservation };

const NOT_EDITING: Editing = { kind: "none" };

/** The refusals that say the observation being corrected moved on: re-read the rows, so the correction can be sent against the current one. */
const MOVED_ON_CODES: ReadonlySet<string> = new Set([
  "STALE_VERSION",
  "CORRECTION_TARGET_NOT_ACTIVE",
]);

interface Read<T> {
  readonly data?: T;
  readonly error?: unknown;
  readonly response?: { readonly status: number };
}

/** A read that failed. `useLoad` takes an `error` as the failure, so one is always present, even for a bodiless reply. */
const failed = (result: { error?: unknown; response?: { status: number } }): Read<never> => ({
  error: result.error ?? "no response body",
  ...(result.response ? { response: result.response } : {}),
});

/**
 * The patient's wounds and, for each, this visit's observation. The list carries each wound's latest observation, which
 * answers it for a wound last observed here; any other open wound is read in full, because this visit's observation may
 * not be its newest (a failed read of one wound marks that wound `unreadable`, not the whole panel). A closed wound shows only
 * when its latest observation is this visit's.
 */
async function loadVisitWounds(
  client: ApiClient,
  patientId: string,
  encounterId: string,
): Promise<Read<VisitWound[]>> {
  const list = await fetchWounds(client, patientId, "all");
  if (list.error !== undefined || !list.data) return failed(list);
  const here = (o: WoundObservation | null): o is WoundObservation =>
    o !== null && o.sourceEncounterId === encounterId;
  const shown = list.data.wounds.filter((w) => w.status === "open" || here(w.latestObservation));
  // One wound's failed read marks that wound only: the others stay recordable.
  const rows = await Promise.all(
    shown.map(async (wound): Promise<VisitWound> => {
      if (here(wound.latestObservation)) {
        return { wound, atThisVisit: wound.latestObservation, unreadable: false };
      }
      if (wound.latestObservation === null || wound.status !== "open") {
        return { wound, atThisVisit: null, unreadable: false };
      }
      try {
        const detail = await fetchWound(client, patientId, wound.id);
        if (detail.error !== undefined || !detail.data) {
          return { wound, atThisVisit: null, unreadable: true };
        }
        return {
          wound,
          atThisVisit: detail.data.observations.find((o) => here(o)) ?? null,
          unreadable: false,
        };
      } catch {
        return { wound, atThisVisit: null, unreadable: true };
      }
    }),
  );
  return { data: rows };
}

function lastObservedText(wound: WoundListItem): string {
  const latest = wound.latestObservation;
  if (latest === null) return "No observation has been recorded for this wound yet.";
  const size = measurementWithArea(latest);
  return `Last observed ${shortDate(latest.observedAt)}${size ? `: ${size}` : ""}.`;
}

export function VisitWoundsPanel({
  encounterId,
  patientId,
  disabled = false,
  onChanged,
  onStatusChange,
  noConcerns,
}: VisitWoundsPanelProps): JSX.Element {
  const client = useApiClient();
  const headingId = useId();
  const formTitleId = useId();
  const visit = useLoad<VisitWound[]>(
    `${patientId}:${encounterId}`,
    () => loadVisitWounds(client, patientId, encounterId),
    WOUND_ERROR_COPY,
  );
  const [editing, setEditing] = useState<Editing>(NOT_EDITING);
  // Something was typed into the open form: leaving now would lose it (the form owns its draft, so the panel only learns that it changed).
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  // An observation saved from this panel is on the wound whatever the quiet re-read said (it may have failed: the panel then warns that
  // the rows may be out of date), so the note states it and the section counts as documented.
  const [savedHere, setSavedHere] = useState(false);

  const rows = visit.data ?? [];
  // The note states a wound only through an observation tagged to THIS encounter; a wound last observed at an earlier visit, one with no
  // observation yet and one whose record could not be read (`atThisVisit` is null for each) state nothing at this visit.
  const recorded = savedHere || rows.some((row) => row.atThisVisit !== null);
  useReportPanelStatus(onStatusChange, {
    dirty: touched && editing.kind !== "none",
    saving: busy,
    recorded,
  });

  const idle = !disabled && !busy;
  const statement = useNoWoundConcernsStatement({
    control: noConcerns,
    loaded: visit.data !== null,
    woundOnFile: rows.length > 0 || savedHere,
    disabled,
    idle,
  });
  // A reload (Try again, Refresh wounds) replaces the button that had focus: hand it to the panel instead of <body>.
  const focusRef = useReloadFocus<HTMLElement>(visit.loading);

  // Whenever the rows are read again, a correction in progress is pointed at the current observation of its wound (its version is what
  // the correction is sent against), without touching what was typed into the form.
  useEffect(() => {
    if (editing.kind !== "correct") return;
    const current = rows.find((row) => row.wound.id === editing.wound.id)?.atThisVisit;
    if (
      current &&
      (current.id !== editing.observation.id || current.version !== editing.observation.version)
    ) {
      setEditing({ ...editing, observation: current });
    }
  }, [rows, editing]);
  // After a successful write whose quiet re-read failed, the rows may still say "not recorded": offer no second record until it is re-read.
  const recordable = idle && !visit.stale;

  /** Read the rows again quietly; the stale warning (and the button) go when it lands, so focus is handed to the panel then. */
  async function refreshWounds(): Promise<void> {
    await visit.reload(true);
    if (document.activeElement === document.body || document.activeElement === null) {
      focusRef.current?.focus({ preventScroll: true });
    }
  }
  /** A correction refused because the observation moved on: say so (the form does) and read the rows again, keeping what was typed. */
  function refusedWrite(failure: OpsFailure): void {
    if (failure.code !== null && MOVED_ON_CODES.has(failure.code)) void visit.reload(true);
  }
  function startEditing(next: Editing): void {
    setTouched(false);
    setEditing(next);
  }
  function changed(): void {
    void visit.reload(true);
    onChanged?.();
  }
  function saved(): void {
    setSavedHere(true);
    startEditing(NOT_EDITING);
    changed();
  }
  /** A wound found at this visit goes straight to its first observation. */
  function registered(wound: WoundView): void {
    startEditing({ kind: "observe", wound });
    changed();
  }

  const editorWound =
    editing.kind === "observe" || editing.kind === "correct" ? editing.wound : null;
  // One place in the tree, whether or not the wound has reached the list yet: a form that moved would remount and lose what was typed.
  const editor =
    editing.kind === "observe" || editing.kind === "correct" ? (
      <fieldset
        className="wx-form-stack wx-fieldset-reset"
        disabled={disabled}
        aria-labelledby={formTitleId}
        onChange={() => setTouched(true)}
      >
        <h4 id={formTitleId} className="wx-section-title">
          {editing.kind === "observe"
            ? "Record today's observation"
            : "Correct this visit's observation"}
          {": "}
          {siteHeading(editing.wound.siteCode, editing.wound.laterality)}
        </h4>
        <WoundObservationForm
          patientId={patientId}
          wound={editing.wound}
          sourceEncounterId={encounterId}
          {...(editing.kind === "correct" ? { correcting: editing.observation } : {})}
          onSaved={saved}
          onCancel={() => startEditing(NOT_EDITING)}
          onBusyChange={setBusy}
          onRefused={refusedWrite}
        />
      </fieldset>
    ) : null;

  const registerForm =
    editing.kind === "register" ? (
      <fieldset
        className="wx-form-stack wx-fieldset-reset"
        disabled={disabled}
        aria-labelledby={formTitleId}
        onChange={() => setTouched(true)}
      >
        <h4 id={formTitleId} className="wx-section-title">
          Add a new wound
        </h4>
        <WoundRegisterForm
          patientId={patientId}
          onRegistered={registered}
          onCancel={() => startEditing(NOT_EDITING)}
          onBusyChange={setBusy}
        />
      </fieldset>
    ) : null;
  const addWound = (
    <Button
      tone="secondary"
      size="sm"
      // An open observation form holds input that registering would unmount.
      disabled={!idle || editing.kind !== "none"}
      onClick={() => startEditing({ kind: "register" })}
    >
      Add a new wound
    </Button>
  );

  return (
    <section ref={focusRef} tabIndex={-1} className="wx-form-stack" aria-labelledby={headingId}>
      <div className="wx-drawer-card-head">
        <h3 id={headingId} className="wx-section-title">
          Wounds
        </h3>
        {rows.length > 0 && !disabled && editing.kind !== "register" ? addWound : null}
      </div>

      {visit.failure ? (
        <>
          <InlineAlert tone="error">{visit.failure.message}</InlineAlert>
          <div className="wx-action-row">
            <Button tone="secondary" size="sm" onClick={() => void visit.reload()}>
              Try again
            </Button>
          </div>
        </>
      ) : visit.loading && visit.data === null ? (
        <LoadingSpinner label="Loading wounds" />
      ) : rows.length === 0 && editing.kind !== "register" && editorWound === null ? (
        <EmptyState
          title="No wounds recorded for this patient"
          description={
            disabled
              ? "Nothing was recorded about a wound at this visit."
              : "If a wound is found at this visit, add it here and record its first observation."
          }
          action={
            disabled ? undefined : (
              <div className="wx-action-row is-center">
                {addWound}
                {statement.controls}
              </div>
            )
          }
        />
      ) : rows.length > 0 ? (
        <ul className="wx-form-stack" aria-label="Wounds of this patient">
          {rows.map(({ wound, atThisVisit, unreadable }) => {
            const heading = siteHeading(wound.siteCode, wound.laterality);
            return (
              <li key={wound.id} className="wx-form-stack">
                <div className="wx-drawer-card-head">
                  <span className="wx-row-title">{heading}</span>
                  {unreadable ? (
                    <StatusPill label="Could not be read" tone="error" />
                  ) : (
                    <StatusPill
                      label={atThisVisit ? "Recorded at this visit" : "Not recorded at this visit"}
                      tone={atThisVisit ? "success" : "warning"}
                    />
                  )}
                </div>
                <span className="wx-row-sub">
                  {ETIOLOGY_LABELS[wound.etiology]}
                  {wound.latestObservation?.stage
                    ? ` · ${STAGE_LABELS[wound.latestObservation.stage]}`
                    : ""}
                  {wound.status === "open" ? "" : ` · ${STATUS_LABELS[wound.status]}`}
                </span>
                {unreadable ? (
                  <>
                    <InlineAlert tone="error">
                      This wound's record for this visit could not be read, so it cannot be recorded
                      here yet.
                    </InlineAlert>
                    <div className="wx-action-row">
                      <Button
                        tone="secondary"
                        size="sm"
                        aria-label={`Try again: ${heading}`}
                        onClick={() => void visit.reload()}
                      >
                        Try again
                      </Button>
                    </div>
                  </>
                ) : atThisVisit ? (
                  <WoundObservationFacts observation={atThisVisit} />
                ) : (
                  <span className="wx-text-muted">{lastObservedText(wound)}</span>
                )}
                {!disabled && editing.kind === "none" && !unreadable ? (
                  <div className="wx-action-row">
                    {atThisVisit ? (
                      <Button
                        tone="secondary"
                        size="sm"
                        disabled={!idle}
                        aria-label={`Correct this visit's observation: ${heading}`}
                        onClick={() =>
                          startEditing({ kind: "correct", wound, observation: atThisVisit })
                        }
                      >
                        Correct
                      </Button>
                    ) : wound.status === "open" ? (
                      <Button
                        size="sm"
                        disabled={!recordable}
                        aria-label={`Record today's observation: ${heading}`}
                        onClick={() => startEditing({ kind: "observe", wound })}
                      >
                        Record today's observation
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {statement.notices}
      {visit.stale ? (
        <>
          <InlineAlert tone="warning">
            The wounds could not be refreshed after the last change and may be out of date. Refresh
            before recording another observation.
          </InlineAlert>
          <div className="wx-action-row">
            <Button tone="secondary" size="sm" onClick={() => void refreshWounds()}>
              Refresh wounds
            </Button>
          </div>
        </>
      ) : null}
      {editor}
      {registerForm}
    </section>
  );
}
