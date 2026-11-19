// apps/web/src/modules/08-encounters — the TENANT VISIT-NOTE DRAFT SWITCH screen (ADR-0114 VN-D17). Spec:
// docs/design/screens/clinical/CHARTWARDEN_UI_VISIT_NOTE_DRAFT_POLICY.md — "Use Admin Settings Layout."
//   GET /api/v1/encounters/draft-policy   encounter.draft_policy_admin   { enabled, reviewStatus, reviewer }
//   PUT /api/v1/encounters/draft-policy   + fresh step-up                { enabled }
// The switch is per organization and off until someone turns it on. It is refused with 409 CORPUS_REVIEW_PENDING while the platform's
// phrase wording has not had its clinical review: the screen says so beforehand (the review status is shown) and explains the refusal in
// words if it comes anyway (the status may have moved since the page loaded; the server is the only judge). Turning it on changes what every
// clinician of the tenant must do before signing, so it asks for confirmation; turning it off is always allowed and does not.
// STEP-UP: a refusal stashes the edit (in memory) and sends the admin to /step-up; coming back restores it and nothing is sent for them.
// The PUT's Idempotency-Key is the shared client's, so this screen holds none. Success is shown only from the server's reply.
// ANNOUNCING / FOCUS: as the closure policy screen (closure-policy.tsx): the saved sentence goes into a status line that is part of the
// "In force now" panel from the first render, and focus moves to that panel's heading when a save lands. A save that answers after the admin
// left does nothing.
import {
  Button,
  ConfirmDialog,
  EmptyState,
  InlineAlert,
  LoadingSpinner,
  Panel,
  StatusPill,
  useApiClient,
} from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  clearStepUpDraft,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
  stepUpRedirectFor,
} from "../../shell/step-up-redirect";
import { useStepUpOwner, useStepUpReturn } from "../../shell/use-step-up-return";
import {
  CORPUS_REVIEW_PENDING_CODE,
  type DraftPolicyView,
  describeDraftRefusal,
  loadDraftPolicy,
  saveDraftPolicy,
} from "./draft-api";
import { useIsMounted } from "./use-is-mounted";

/** The step-up draft action and resource of this screen (one switch per organization). */
export const DRAFT_POLICY_ACTION = "encounters.draft.policy";
const POLICY_RESOURCE = "policy";
const POLICY_DRAFT_ACTIONS: readonly string[] = [DRAFT_POLICY_ACTION];
const FORBIDDEN_STATUS = 403;

type Load =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly forbidden: boolean }
  | { readonly status: "ready"; readonly policy: DraftPolicyView };

const asDraft = (value: unknown): boolean | null => {
  if (typeof value !== "object" || value === null) return null;
  const { enabled } = value as Record<string, unknown>;
  return typeof enabled === "boolean" ? enabled : null;
};

const settingWords = (enabled: boolean): string => (enabled ? "on" : "off");

export function DraftPolicy(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const owner = useStepUpOwner();
  const mounted = useIsMounted();
  const headingRef = useRef<HTMLSpanElement>(null);
  // Back from /step-up: the edit is restored once. An abandoned draft is discarded, never restored.
  const returning = useStepUpReturn(owner, POLICY_DRAFT_ACTIONS);
  const draftKey = stepUpDraftKey(owner, DRAFT_POLICY_ACTION, POLICY_RESOURCE);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [enabled, setEnabled] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saved, setSaved] = useState<DraftPolicyView | null>(null);
  const inFlight = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a retry trigger; `returning` and `draftKey` are fixed for this mount, and the stashed edit is restored ONCE (then cleared), so a Refresh or Try again shows what the server holds, not the old edit.
  useEffect(() => {
    let active = true;
    setLoad({ status: "loading" });
    void loadDraftPolicy(client).then((outcome) => {
      if (!active) return;
      if (!outcome.ok) {
        setLoad({ status: "error", forbidden: outcome.status === FORBIDDEN_STATUS });
        return;
      }
      const restored = returning ? asDraft(peekStepUpDraft<unknown>(draftKey)) : null;
      if (restored !== null) clearStepUpDraft(draftKey); // restored once: a retry must not overwrite the form with it again
      setEnabled(restored ?? outcome.data.enabled);
      setLoad({ status: "ready", policy: outcome.data });
    });
    return () => {
      active = false;
    };
  }, [client, reloadKey]);

  const policy = load.status === "ready" ? load.policy : null;
  const dirty = policy !== null && enabled !== policy.enabled;

  const commit = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setRefusal(null);
    const outcome = await saveDraftPolicy(client, enabled);
    inFlight.current = false;
    if (outcome.ok) clearStepUpDraft(draftKey);
    if (!mounted.current) return; // the admin left: no navigation, no stashed draft, no state
    setBusy(false);
    setConfirming(false);
    if (outcome.ok) {
      setLoad({ status: "ready", policy: outcome.data });
      setEnabled(outcome.data.enabled);
      setSaved(outcome.data);
      return;
    }
    if (outcome.status === 401) {
      navigate("/login");
      return;
    }
    const stepUp = stepUpRedirectFor(outcome.error, `${location.pathname}${location.search}`);
    if (stepUp) {
      stashStepUpDraft(draftKey, { enabled });
      navigate(stepUp);
      return;
    }
    const failure = describeDraftRefusal(outcome);
    setRefusal(
      failure.code === CORPUS_REVIEW_PENDING_CODE && policy
        ? `${failure.message} Reviewer: ${policy.reviewer}. Refresh to see the review status.`
        : failure.message,
    );
  };

  // A reload shows what the server holds now, so the "saved" notice for an earlier save goes with it.
  const reload = (): void => {
    setSaved(null);
    setRefusal(null);
    setReloadKey((key) => key + 1);
  };

  const requestSave = (): void => {
    setSaved(null);
    setRefusal(null);
    if (enabled) {
      setConfirming(true); // turning it on changes what every clinician must do before signing
      return;
    }
    void commit();
  };

  // A save has landed: the Save button is disabled again, so focus goes to the panel that now shows what is in force. This is an effect
  // (not a call in `commit`) so it runs after the confirm dialog's own focus restore has finished.
  useEffect(() => {
    if (saved) headingRef.current?.focus();
  }, [saved]);

  return (
    <div className="wx-list-drawer">
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Visit-note draft</h1>
            <p>
              Whether clinicians get a visit note pre-drafted from the patient's record, and must
              confirm each drafted section before they can sign.
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
              title={load.forbidden ? "Not available" : "Visit-note draft setting unavailable"}
              description={
                load.forbidden
                  ? "You do not have access to the visit-note draft setting."
                  : "The setting could not be loaded. Nothing has been changed: try again."
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
              description="What your organization is running today. A tenant that has never saved this setting has it off."
            >
              <output style={saved ? { display: "block", marginBottom: "0.75rem" } : undefined}>
                {saved ? (
                  <InlineAlert tone="success" live={false}>
                    {`Setting saved: the visit-note draft is ${settingWords(saved.enabled)}.`}
                  </InlineAlert>
                ) : null}
              </output>
              <dl className="wx-kv">
                <dt>Visit-note draft</dt>
                <dd>
                  <StatusPill
                    label={policy.enabled ? "On" : "Off"}
                    tone={policy.enabled ? "success" : "neutral"}
                  />
                </dd>
                <dt>Phrase review</dt>
                <dd>
                  <StatusPill
                    label={policy.reviewStatus === "approved" ? "Approved" : "Pending"}
                    tone={policy.reviewStatus === "approved" ? "success" : "warning"}
                  />
                </dd>
                <dt>Reviewer</dt>
                <dd>{policy.reviewer}</dd>
              </dl>
              {policy.reviewStatus === "pending" ? (
                <InlineAlert tone="warning" live={false}>
                  {`The platform's phrase wording is still in clinical review by ${policy.reviewer}. The server will not let the draft be turned on until the review is approved.`}
                </InlineAlert>
              ) : null}
            </Panel>
            <Panel title="Change the setting" icon="settings">
              <form
                className="wx-form-stack"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  requestSave();
                }}
              >
                <fieldset className="wx-form-stack wx-fieldset-reset">
                  <legend>Visit-note draft</legend>
                  <SettingOption
                    value={true}
                    checked={enabled}
                    label="On"
                    effect="Clinicians get a pre-drafted note and must confirm or deselect every drafted section before signing. A note finalized earlier cannot be signed until its drafted sections are resolved."
                    onChoose={setEnabled}
                  />
                  <SettingOption
                    value={false}
                    checked={!enabled}
                    label="Off"
                    effect="Visit notes work as they did before drafts: nothing is pre-drafted and signing does not check drafted sections. Turning it off is always allowed."
                    onChoose={setEnabled}
                  />
                </fieldset>
                {refusal ? <InlineAlert tone="error">{refusal}</InlineAlert> : null}
                <div className="wx-drawer-actions">
                  <Button type="submit" disabled={!dirty} loading={busy && !confirming}>
                    Save setting
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
        title="Turn on the visit-note draft?"
        confirmLabel="Turn on drafts"
        pending={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void commit()}
        description={<TurnOnConsequences />}
      />
    </div>
  );
}

function SettingOption({
  value,
  checked,
  label,
  effect,
  onChoose,
}: {
  value: boolean;
  checked: boolean;
  label: string;
  effect: string;
  onChoose: (value: boolean) => void;
}): JSX.Element {
  const id = `draft-policy-${value ? "on" : "off"}`;
  return (
    <div className="wx-action-check">
      <input
        id={id}
        type="radio"
        name="draft-policy"
        checked={checked}
        aria-describedby={`${id}-effect`}
        onChange={() => onChoose(value)}
      />
      <div>
        <label htmlFor={id} className="wx-row-title">
          {label}
        </label>
        <div id={`${id}-effect`} className="wx-row-sub">
          {effect}
        </div>
      </div>
    </div>
  );
}

function TurnOnConsequences(): JSX.Element {
  return (
    <>
      <p>
        From the moment you save, every clinician of your organization sees a pre-drafted visit note
        built from the patient's record, and cannot sign until each drafted section is confirmed or
        deselected.
      </p>
      <p>
        A note that was finalized before this was turned on cannot be signed until its drafted
        sections are resolved.
      </p>
      <p>If your sign-in is not recent, you will be asked to confirm your identity first.</p>
    </>
  );
}
