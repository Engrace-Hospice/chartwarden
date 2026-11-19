// apps/web/src/modules/08-encounters — the TENANT NOTE-CLOSURE POLICY screen (ADR-0113). Spec:
// docs/design/screens/clinical/CHARTWARDEN_UI_NOTE_CLOSURE_POLICY.md — "Use Admin Settings Layout."
//   GET /api/v1/encounters/closure-policy   encounter.closure_policy_admin   { obligationKind, mode, thresholdHours, enforceFrom }
//   PUT /api/v1/encounters/closure-policy   + fresh step-up                  { mode, thresholdHours }
// The mode is off | warn | block and the deadline is 1 to 168 hours after a visit starts. A tenant that has never saved a policy is read as
// warn / 24 (the server's default), so the values shown are the EFFECTIVE ones. Moving to block stamps `enforceFrom` on the server, so a
// note that is already overdue gets a fresh full window and nobody is limited by the switch itself; the confirm step says so. A refusal
// the server gives is shown in words, and success is shown only from its reply.
// STEP-UP: a refusal stashes the edit (in memory) and sends the admin to /step-up; coming back restores it and nothing is sent for them.
// The PUT's Idempotency-Key is the shared client's (one per write intent), so this screen holds none.
// ANNOUNCING: the saved sentence goes into a status line that is part of the "In force now" panel from the first render (a live region is
// only announced for a change inside a region that was already there), and focus moves to that panel's heading when a save lands, because
// the Save button the focus was on is disabled again (nothing left to save) and a dialog's focus restore cannot land on it. A save that
// answers after the admin left the screen does nothing: no navigation, no stashed draft, no state.
import {
  DOCUMENTATION_OBLIGATION_DEFAULT_MODE,
  DOCUMENTATION_OBLIGATION_DEFAULT_THRESHOLD_HOURS,
  DOCUMENTATION_OBLIGATION_MAX_THRESHOLD_HOURS,
  DOCUMENTATION_OBLIGATION_MIN_THRESHOLD_HOURS,
} from "@chartwarden/types";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  InlineAlert,
  LoadingSpinner,
  Panel,
  StatusPill,
  TextField,
  useApiClient,
} from "@chartwarden/ui";
import type { StatusTone } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { formatClosureInstant } from "../../shell/closure-instant";
import {
  clearStepUpDraft,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
  stepUpRedirectFor,
} from "../../shell/step-up-redirect";
import { useStepUpOwner, useStepUpReturn } from "../../shell/use-step-up-return";
import {
  type ClosurePolicyView,
  describeRefusal,
  loadClosurePolicy,
  saveClosurePolicy,
} from "./closure-api";
import {
  type ClosureMode,
  MODE_EFFECT,
  MODE_LABEL,
  MODE_ORDER,
  WARNING_LEAD_HOURS,
  isClosureMode,
  needsBlockConfirmation,
  parseThresholdHours,
} from "./closure-model";
import { useIsMounted } from "./use-is-mounted";

/** The step-up draft action and resource of this screen (one policy per organization). */
export const CLOSURE_POLICY_ACTION = "encounters.closure.policy";
const POLICY_RESOURCE = "policy";
const POLICY_DRAFT_ACTIONS: readonly string[] = [CLOSURE_POLICY_ACTION];
const FORBIDDEN_STATUS = 403;
const MODE_TONE: Readonly<Record<ClosureMode, StatusTone>> = {
  off: "neutral",
  warn: "progress",
  block: "warning",
};

type Load =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly forbidden: boolean }
  | { readonly status: "ready"; readonly policy: ClosurePolicyView };

interface Draft {
  readonly mode: ClosureMode;
  readonly threshold: string;
}

const asDraft = (value: unknown): Draft | null => {
  if (typeof value !== "object" || value === null) return null;
  const { mode, threshold } = value as Record<string, unknown>;
  return typeof mode === "string" && isClosureMode(mode) && typeof threshold === "string"
    ? { mode, threshold }
    : null;
};

export function ClosurePolicy(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const owner = useStepUpOwner();
  const mounted = useIsMounted();
  const headingRef = useRef<HTMLSpanElement>(null);
  // Back from /step-up: the edit is restored once. An abandoned draft is discarded, never restored.
  const returning = useStepUpReturn(owner, POLICY_DRAFT_ACTIONS);
  const draftKey = stepUpDraftKey(owner, CLOSURE_POLICY_ACTION, POLICY_RESOURCE);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [mode, setMode] = useState<ClosureMode>(DOCUMENTATION_OBLIGATION_DEFAULT_MODE);
  const [threshold, setThreshold] = useState(
    String(DOCUMENTATION_OBLIGATION_DEFAULT_THRESHOLD_HOURS),
  );
  const [thresholdError, setThresholdError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saved, setSaved] = useState<ClosurePolicyView | null>(null);
  const inFlight = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a retry trigger; `returning` and `draftKey` are fixed for this mount, and the stashed draft is restored ONCE (then cleared), so a Refresh or Try again shows what the server holds, not the old edit.
  useEffect(() => {
    let active = true;
    setLoad({ status: "loading" });
    void loadClosurePolicy(client).then((outcome) => {
      if (!active) return;
      if (!outcome.ok) {
        setLoad({ status: "error", forbidden: outcome.status === FORBIDDEN_STATUS });
        return;
      }
      const draft = returning ? asDraft(peekStepUpDraft<unknown>(draftKey)) : null;
      if (draft) clearStepUpDraft(draftKey); // restored once: a retry must not overwrite the form with it again
      setMode(draft?.mode ?? outcome.data.mode);
      setThreshold(draft?.threshold ?? String(outcome.data.thresholdHours));
      setLoad({ status: "ready", policy: outcome.data });
    });
    return () => {
      active = false;
    };
  }, [client, reloadKey]);

  const policy = load.status === "ready" ? load.policy : null;
  const dirty =
    policy !== null && (mode !== policy.mode || threshold.trim() !== String(policy.thresholdHours));

  const commit = async (thresholdHours: number): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setRefusal(null);
    const outcome = await saveClosurePolicy(client, { mode, thresholdHours });
    inFlight.current = false;
    if (outcome.ok) clearStepUpDraft(draftKey);
    if (!mounted.current) return; // the admin left: no navigation, no stashed draft, no state
    setBusy(false);
    setConfirming(false);
    if (outcome.ok) {
      setLoad({ status: "ready", policy: outcome.data });
      setMode(outcome.data.mode);
      setThreshold(String(outcome.data.thresholdHours));
      setSaved(outcome.data);
      return;
    }
    if (outcome.status === 401) {
      navigate("/login");
      return;
    }
    const stepUp = stepUpRedirectFor(outcome.error, `${location.pathname}${location.search}`);
    if (stepUp) {
      stashStepUpDraft(draftKey, { mode, threshold });
      navigate(stepUp);
      return;
    }
    const failure = describeRefusal(outcome);
    setRefusal(failure.fieldErrors.thresholdHours ?? failure.fieldErrors.mode ?? failure.message);
  };

  // A reload shows what the server holds now, so the "Policy saved" notice for an earlier save goes with it.
  const reload = (): void => {
    setSaved(null);
    setReloadKey((key) => key + 1);
  };

  const requestSave = (): void => {
    const thresholdHours = parseThresholdHours(threshold);
    setSaved(null);
    setRefusal(null);
    if (thresholdHours === null) {
      setThresholdError(
        `Enter a whole number of hours from ${DOCUMENTATION_OBLIGATION_MIN_THRESHOLD_HOURS} to ${DOCUMENTATION_OBLIGATION_MAX_THRESHOLD_HOURS}.`,
      );
      return;
    }
    setThresholdError(null);
    if (policy && needsBlockConfirmation(policy, { mode, thresholdHours })) {
      setConfirming(true);
      return;
    }
    void commit(thresholdHours);
  };

  // A save has landed: the Save button is disabled again, so focus goes to the panel that now shows what is in force. This is an effect
  // (not a call in `commit`) so it runs after the confirm dialog's own focus restore has finished.
  useEffect(() => {
    if (saved) headingRef.current?.focus();
  }, [saved]);

  const pendingHours = parseThresholdHours(threshold);
  const shortening = policy?.mode === "block";
  return (
    <div className="wx-list-drawer">
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Note closure policy</h1>
            <p>
              How long clinicians have to close a visit note after starting it, and what happens
              when they do not.
            </p>
          </div>
          <Button tone="secondary" loading={load.status === "loading"} onClick={reload}>
            Refresh
          </Button>
        </header>

        {load.status === "loading" ? (
          <div className="wx-list-state">
            <LoadingSpinner />
          </div>
        ) : null}
        {load.status === "error" ? (
          <div className="wx-list-state" role="alert">
            <EmptyState
              title={load.forbidden ? "Not available" : "Closure policy unavailable"}
              description={
                load.forbidden
                  ? "You do not have access to the note closure policy."
                  : "The policy could not be loaded. Nothing has been changed: try again."
              }
            />
            {load.forbidden ? null : (
              <Button tone="secondary" onClick={reload}>
                Try again
              </Button>
            )}
          </div>
        ) : null}

        {policy ? (
          <>
            <Panel
              title={
                <span ref={headingRef} tabIndex={-1}>
                  In force now
                </span>
              }
              icon="clipboard-check"
              description="What your organization is running today. A tenant that has never saved a policy gets warn only with a 24 hour deadline."
            >
              <output style={saved ? { display: "block", marginBottom: "0.75rem" } : undefined}>
                {saved ? <SavedNotice policy={saved} /> : null}
              </output>
              <dl className="wx-kv">
                <dt>Mode</dt>
                <dd>
                  <StatusPill label={MODE_LABEL[policy.mode]} tone={MODE_TONE[policy.mode]} />
                </dd>
                <dt>Deadline</dt>
                <dd>{`${policy.thresholdHours} hours after a visit starts`}</dd>
                {policy.enforceFrom ? (
                  <>
                    <dt>Blocking counts from</dt>
                    <dd className="wx-nums">{formatClosureInstant(policy.enforceFrom)}</dd>
                  </>
                ) : null}
              </dl>
            </Panel>
            <Panel title="Change the policy" icon="settings">
              <form
                className="wx-form-stack"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  requestSave();
                }}
              >
                <fieldset className="wx-form-stack wx-fieldset-reset">
                  <legend>Mode</legend>
                  {MODE_ORDER.map((option) => (
                    <div key={option} className="wx-action-check">
                      <input
                        id={`closure-mode-${option}`}
                        type="radio"
                        name="closure-mode"
                        value={option}
                        checked={mode === option}
                        aria-describedby={`closure-mode-${option}-effect`}
                        onChange={() => setMode(option)}
                      />
                      <div>
                        <label htmlFor={`closure-mode-${option}`} className="wx-row-title">
                          {MODE_LABEL[option]}
                        </label>
                        <div id={`closure-mode-${option}-effect`} className="wx-row-sub">
                          {MODE_EFFECT[option]}
                        </div>
                      </div>
                    </div>
                  ))}
                </fieldset>
                <TextField
                  label="Deadline (hours)"
                  required
                  inputMode="numeric"
                  autoComplete="off"
                  value={threshold}
                  error={thresholdError ?? undefined}
                  hint={`Hours after a visit starts. ${DOCUMENTATION_OBLIGATION_MIN_THRESHOLD_HOURS} to ${DOCUMENTATION_OBLIGATION_MAX_THRESHOLD_HOURS}. Clinicians are first warned ${WARNING_LEAD_HOURS} hours before it.`}
                  onChange={(event) => {
                    setThreshold(event.target.value);
                    setThresholdError(null); // fixing the field retires the refusal that was about it
                  }}
                />
                {refusal ? <InlineAlert tone="error">{refusal}</InlineAlert> : null}
                <div className="wx-drawer-actions">
                  <Button type="submit" disabled={!dirty} loading={busy && !confirming}>
                    Save policy
                  </Button>
                  {dirty ? null : <span className="wx-row-sub">No changes to save.</span>}
                </div>
              </form>
            </Panel>
          </>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirming}
        title={shortening ? "Shorten the deadline?" : "Turn on blocking?"}
        confirmLabel={shortening ? "Shorten the deadline" : "Turn on blocking"}
        pending={busy}
        confirmDisabled={pendingHours === null}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          if (pendingHours !== null) void commit(pendingHours);
        }}
        description={<BlockingConsequences shortening={shortening} />}
      />
    </div>
  );
}

function BlockingConsequences({ shortening }: { shortening: boolean }): JSX.Element {
  return (
    <>
      <p>
        {shortening
          ? "Blocking is already on. A shorter deadline applies to notes that are already open: any note older than the new deadline is overdue at once, so its clinician may be limited as soon as you save."
          : "Notes that are already past the deadline get a fresh full window, counted from the moment you save, so nobody is limited by the switch itself."}
      </p>
      <p>
        After that, a clinician whose note is past its deadline can only close notes and use the
        patient-safety routes (medication administration, orders, on-call and triage, field safety
        and emergency messaging) until the note is closed or a supervisor grants a temporary
        override.
      </p>
      <p>If your sign-in is not recent, you will be asked to confirm your identity first.</p>
    </>
  );
}

function SavedNotice({ policy }: { policy: ClosurePolicyView }): JSX.Element {
  return (
    <InlineAlert tone="success" live={false}>
      {`Policy saved: ${MODE_LABEL[policy.mode].toLowerCase()}, ${policy.thresholdHours}-hour deadline.${
        policy.mode === "block" && policy.enforceFrom
          ? ` Notes already overdue get a fresh window: blocking counts from ${formatClosureInstant(policy.enforceFrom)}.`
          : ""
      }`}
    </InlineAlert>
  );
}
