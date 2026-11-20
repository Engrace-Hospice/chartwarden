// apps/web/src/modules/09-assessments/wounds — the registry's right-hand drawer for one selected wound: its facts, its
// observation history (newest first, each with the area and the change since the last measured visit), and the four
// things a clinician does to a wound — record an observation, correct one, close the wound. The forms open in the
// drawer's own body, so the history stays one click away and nothing opens over the list.
//
// A correction is not an edit: it appends an observation that supersedes the one corrected, and the server refuses it
// (409) when the observation changed after it was read. The drawer cannot be closed while a write is in flight.
import {
  Button,
  Drawer,
  InlineAlert,
  LoadingSpinner,
  StatusPill,
  useApiClient,
  useLoad,
} from "@chartwarden/ui";
import { type JSX, useState } from "react";
import { STATUS_TONE, TREND_TONE, shortDate, shortDateTime } from "./wound-format";
import {
  ACQUIRED_LABELS,
  ETIOLOGY_LABELS,
  STATUS_LABELS,
  TREND_LABELS,
  siteHeading,
} from "./wound-labels";
import { WoundObservationFacts } from "./wound-observation-facts";
import { WoundObservationForm } from "./wound-observation-form";
import { WoundResolveForm } from "./wound-resolve-form";
import {
  WOUND_ERROR_COPY,
  type WoundDetail,
  type WoundListItem,
  type WoundObservation,
  type WoundView,
  fetchWound,
} from "./wounds-api";

type Mode =
  | { readonly kind: "history" }
  | { readonly kind: "observe" }
  | { readonly kind: "correct"; readonly observation: WoundObservation }
  | { readonly kind: "resolve" };

const HISTORY: Mode = { kind: "history" };

export interface WoundDrawerProps {
  readonly patientId: string;
  /** The registry's row for this wound: shown while the detail loads. */
  readonly summary: WoundListItem;
  readonly onClose: () => void;
  /** Fires after any successful write, so the list behind the drawer can refresh. */
  readonly onChanged: () => void;
  /** Fires true while a write is in flight and false once it settles, so the page can hold still until then. */
  readonly onBusyChange?: (busy: boolean) => void;
}

function WoundFacts({ wound }: { readonly wound: WoundView }): JSX.Element {
  return (
    <dl className="wx-kv">
      <div>
        <dt>Cause</dt>
        <dd>{ETIOLOGY_LABELS[wound.etiology]}</dd>
      </div>
      <div>
        <dt>Where it started</dt>
        <dd>{ACQUIRED_LABELS[wound.acquired]}</dd>
      </div>
      <div>
        <dt>Onset</dt>
        <dd>{wound.onsetOn ? shortDate(wound.onsetOn) : "Not recorded"}</dd>
      </div>
      {wound.status === "open" ? null : (
        <div>
          <dt>Closed</dt>
          <dd>{shortDate(wound.closedOn)}</dd>
        </div>
      )}
    </dl>
  );
}

export function WoundDrawer({
  patientId,
  summary,
  onClose,
  onChanged,
  onBusyChange,
}: WoundDrawerProps): JSX.Element {
  const client = useApiClient();
  const detail = useLoad<WoundDetail>(
    `${patientId}:${summary.id}`,
    () => fetchWound(client, patientId, summary.id),
    WOUND_ERROR_COPY,
  );
  const [mode, setMode] = useState<Mode>(HISTORY);
  const [busy, setBusy] = useState(false);

  const wound: WoundView = detail.data?.wound ?? summary;
  const observations = detail.data?.observations ?? [];
  const heading = siteHeading(wound.siteCode, wound.laterality);

  function changeBusy(next: boolean): void {
    setBusy(next);
    onBusyChange?.(next);
  }
  function finished(): void {
    setMode(HISTORY);
    void detail.reload(true);
    onChanged();
  }
  const backToHistory = (): void => setMode(HISTORY);

  return (
    <Drawer
      title={heading}
      label={`Wound: ${heading}`}
      subtitle={
        <>
          {ETIOLOGY_LABELS[wound.etiology]}{" "}
          <StatusPill label={STATUS_LABELS[wound.status]} tone={STATUS_TONE[wound.status]} />
        </>
      }
      icon="alert"
      closeDisabled={busy}
      resetKey={mode.kind}
      onClose={() => (busy ? undefined : onClose())}
    >
      {mode.kind === "observe" ? (
        <>
          <h3>Record observation</h3>
          <WoundObservationForm
            patientId={patientId}
            wound={wound}
            onSaved={finished}
            onCancel={backToHistory}
            onBusyChange={changeBusy}
          />
        </>
      ) : mode.kind === "correct" ? (
        <>
          <h3>Correct observation of {shortDateTime(mode.observation.observedAt)}</h3>
          <WoundObservationForm
            patientId={patientId}
            wound={wound}
            correcting={mode.observation}
            onSaved={finished}
            onCancel={backToHistory}
            onBusyChange={changeBusy}
          />
        </>
      ) : mode.kind === "resolve" ? (
        <>
          <h3>Close this wound</h3>
          <WoundResolveForm
            patientId={patientId}
            wound={wound}
            onResolved={finished}
            onCancel={backToHistory}
            onBusyChange={changeBusy}
          />
        </>
      ) : (
        <>
          <WoundFacts wound={wound} />
          {wound.status === "open" ? (
            <div className="wx-action-row">
              <Button onClick={() => setMode({ kind: "observe" })}>Record observation</Button>
              <Button tone="secondary" onClick={() => setMode({ kind: "resolve" })}>
                Mark healed or resolved
              </Button>
            </div>
          ) : null}
          <h3>Observations</h3>
          {detail.loading && detail.data === null ? (
            <LoadingSpinner label="Loading observations" />
          ) : detail.failure ? (
            <>
              <InlineAlert tone="error">{detail.failure.message}</InlineAlert>
              <div className="wx-action-row">
                <Button tone="secondary" size="sm" onClick={() => void detail.reload()}>
                  Try again
                </Button>
              </div>
            </>
          ) : observations.length === 0 ? (
            <span className="wx-text-muted">
              No observation has been recorded yet.
              {wound.status === "open" ? " Record the first one to start the history." : ""}
            </span>
          ) : (
            <ol className="wx-form-stack" aria-label="Observations, newest first">
              {observations.map((observation) => (
                <li key={observation.id} className="wx-form-stack">
                  <div className="wx-drawer-card-head">
                    <h4 className="wx-section-title">{shortDateTime(observation.observedAt)}</h4>
                    {observation.trend ? (
                      <StatusPill
                        label={TREND_LABELS[observation.trend]}
                        tone={TREND_TONE[observation.trend]}
                      />
                    ) : null}
                  </div>
                  <WoundObservationFacts observation={observation} />
                  <div className="wx-action-row">
                    <Button
                      tone="tertiary"
                      size="sm"
                      aria-label={`Correct the observation of ${shortDateTime(observation.observedAt)}`}
                      onClick={() => setMode({ kind: "correct", observation })}
                    >
                      Correct
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {detail.stale ? (
            <InlineAlert tone="warning">
              These observations could not be refreshed and may be out of date.
            </InlineAlert>
          ) : null}
        </>
      )}
    </Drawer>
  );
}
