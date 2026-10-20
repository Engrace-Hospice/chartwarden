// M36 WP 5.6 (ADR-0086, PROPOSED) - the two dialogs of the legal-hold tab. "Place" collects a scope, a name and a reason (>= 10 characters); "Release"
// is two steps: a preview ("N messages will become eligible on the next scan") and then a SECOND explicit confirmation that sends the count the
// officer saw. A stale count (409 RELEASE_PREVIEW_STALE) shows the new count and asks again. A stale step-up stashes what was typed and sends the
// officer through the step-up page. Names and reasons are free text and are only ever rendered as text.
import {
  type ApplyMessageLegalHoldRequest,
  MESSAGE_LEGAL_HOLD_REASON_MIN_LENGTH,
  type MessageLegalHoldDto,
} from "@wardenx/types";
import { Button, Modal, TextAreaField, TextField } from "@wardenx/ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  clearStepUpDraft,
  stashStepUpDraft,
  stepUpRedirectFor,
} from "../../shell/step-up-redirect";
import type { CreateDraft, ReleaseDraft } from "./legal-hold-drafts";
import * as W from "./retention-wording";
import type { ActionResult, LegalHoldActions } from "./use-retention";
import { UUID_RE } from "./uuid";

const splitIds = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

function useStepUpNavigation(): (error: unknown) => boolean {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(
    (error) => {
      const to = stepUpRedirectFor(error, `${location.pathname}${location.search}`);
      if (!to) return false;
      navigate(to);
      return true;
    },
    [navigate, location.pathname, location.search],
  );
}

/** A refusal reads as what it is (session over vs not permitted), not as a generic failure. */
const deniedText = (result: Extract<ActionResult, { kind: "denied" }>): string =>
  result.code === 401 ? W.SIGN_IN : W.DENIED;

const EMPTY_DRAFT: CreateDraft = {
  name: "",
  reason: "",
  orgWide: false,
  channels: "",
  users: "",
  patients: "",
};

/** True while mounted: an answer that lands after the dialog is gone must not navigate, announce or clear a draft. */
function useAlive(): { readonly current: boolean } {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}

export function CreateHoldDialog({
  actions,
  initial,
  draftKey,
  onClose,
  onPlaced,
}: {
  readonly actions: LegalHoldActions;
  /** The draft stashed before a step-up, only when the user is genuinely back from it. */
  readonly initial: CreateDraft | null;
  readonly draftKey: string | null;
  readonly onClose: () => void;
  readonly onPlaced: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState<CreateDraft>(initial ?? EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const alive = useAlive();
  const goStepUp = useStepUpNavigation();
  const detailId = useId();
  const set = (patch: Partial<CreateDraft>): void => setDraft((d) => ({ ...d, ...patch }));

  const submit = async (): Promise<void> => {
    if (inFlight.current) return;
    const lists = {
      channel_ids: splitIds(draft.channels),
      user_ids: splitIds(draft.users),
      patient_ids: splitIds(draft.patients),
    };
    const checks: [string, string[]][] = [
      [W.CHANNEL_IDS_LABEL, lists.channel_ids],
      [W.USER_IDS_LABEL, lists.user_ids],
      [W.PATIENT_IDS_LABEL, lists.patient_ids],
    ];
    const badList = checks.find(([, ids]) => ids.some((id) => !UUID_RE.test(id)));
    const hasScope = draft.orgWide || Object.values(lists).some((l) => l.length > 0);
    const problem =
      draft.name.trim().length === 0
        ? W.NAME_REQUIRED
        : draft.reason.trim().length < MESSAGE_LEGAL_HOLD_REASON_MIN_LENGTH
          ? W.REASON_SHORT
          : !hasScope
            ? W.SCOPE_REQUIRED
            : badList && !draft.orgWide
              ? W.idsInvalid(badList[0])
              : null;
    if (problem) {
      setError(problem);
      return;
    }
    const body: ApplyMessageLegalHoldRequest = draft.orgWide
      ? { name: draft.name.trim(), reason: draft.reason.trim(), org_wide: true }
      : { name: draft.name.trim(), reason: draft.reason.trim(), ...lists };
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const result: ActionResult = await actions.apply(body);
    inFlight.current = false;
    if (!alive.current) return;
    setBusy(false);
    if (result.kind === "ok") {
      clearStepUpDraft(draftKey);
      onPlaced();
      return;
    }
    if (result.kind === "step_up") {
      stashStepUpDraft(draftKey, draft);
      if (!goStepUp(result.error)) setError(W.STEP_UP_TEXT);
      return;
    }
    setError(
      result.kind === "denied"
        ? deniedText(result)
        : result.kind === "invalid"
          ? W.CREATE_INVALID
          : W.CREATE_FAILED,
    );
  };

  const cancel = (): void => {
    if (inFlight.current) return; // the request is out: closing now would hide its outcome
    clearStepUpDraft(draftKey);
    onClose();
  };

  return (
    <Modal
      open
      ariaLabel={W.CREATE_TITLE}
      ariaDescribedBy={detailId}
      onClose={cancel}
      dismissOnScrim={draft.name.trim() === "" && draft.reason.trim() === ""}
      width="36rem"
    >
      <form
        className="wx-retention-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2>{W.CREATE_TITLE}</h2>
        <p id={detailId} className="wx-retention-detail">
          {W.CREATE_DETAIL}
        </p>
        <TextField
          label={W.NAME_LABEL}
          value={draft.name}
          maxLength={200}
          onChange={(e) => set({ name: e.target.value })}
        />
        <TextAreaField
          label={W.REASON_LABEL}
          hint={`${W.REASON_HINT} ${W.REASON_PRIVACY_HINT}`}
          rows={3}
          value={draft.reason}
          onChange={(e) => set({ reason: e.target.value })}
        />
        <label className="wx-retention-check">
          <input
            type="checkbox"
            checked={draft.orgWide}
            onChange={(e) => set({ orgWide: e.target.checked })}
          />
          {W.ORG_WIDE_LABEL}
        </label>
        {draft.orgWide ? null : (
          <>
            <TextAreaField
              label={W.CHANNEL_IDS_LABEL}
              hint={W.IDS_HINT}
              rows={2}
              value={draft.channels}
              onChange={(e) => set({ channels: e.target.value })}
            />
            <TextAreaField
              label={W.USER_IDS_LABEL}
              hint={W.IDS_HINT}
              rows={2}
              value={draft.users}
              onChange={(e) => set({ users: e.target.value })}
            />
            <TextAreaField
              label={W.PATIENT_IDS_LABEL}
              hint={W.IDS_HINT}
              rows={2}
              value={draft.patients}
              onChange={(e) => set({ patients: e.target.value })}
            />
          </>
        )}
        {error ? (
          <p className="wx-retention-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="wx-retention-dialog-actions">
          <Button type="button" tone="secondary" aria-disabled={busy} onClick={cancel}>
            {W.CANCEL_LABEL}
          </Button>
          <Button type="submit" tone="primary" aria-disabled={busy}>
            {W.CREATE_ACTION}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

type Step = "reason" | "confirm";
type PreviewResult =
  | { readonly kind: "ok"; readonly count: number }
  | { readonly kind: "failed" }
  | { readonly kind: "superseded" };

export function ReleaseHoldDialog({
  hold,
  actions,
  initialReason,
  draftKey,
  onClose,
  onReleased,
}: {
  readonly hold: MessageLegalHoldDto;
  readonly actions: LegalHoldActions;
  /** The reason stashed before a step-up, only when the user is genuinely back from it. */
  readonly initialReason: string;
  readonly draftKey: string | null;
  readonly onClose: () => void;
  readonly onReleased: () => void;
}): JSX.Element {
  const [reason, setReason] = useState(initialReason);
  const [step, setStep] = useState<Step>("reason");
  const [count, setCount] = useState<number | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const previewSeq = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstStep = useRef(true);
  const alive = useAlive();
  const goStepUp = useStepUpNavigation();
  const detailId = useId();

  // Only the newest preview applies; a dialog that is gone, or a call overtaken by a newer one, is "superseded".
  const loadPreview = useCallback(async (): Promise<PreviewResult> => {
    previewSeq.current += 1;
    const mine = previewSeq.current;
    setPreviewFailed(false);
    const preview = await actions.preview(hold.id);
    if (mine !== previewSeq.current) return { kind: "superseded" };
    setPreviewFailed(preview === null);
    if (!preview) return { kind: "failed" };
    setCount(preview.eligible_on_release);
    return { kind: "ok", count: preview.eligible_on_release };
  }, [actions, hold.id]);
  useEffect(() => {
    void loadPreview();
    return () => {
      previewSeq.current += 1;
    };
  }, [loadPreview]);

  // The content is keyed on the step, so a step change replaces the focused control: land on the new heading.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `step` is the trigger, not a value the effect reads
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const cancel = (): void => {
    if (inFlight.current) return;
    clearStepUpDraft(draftKey);
    onClose();
  };

  const confirm = async (): Promise<void> => {
    if (count === null || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setStale(false);
    const result = await actions.release(hold.id, {
      reason: reason.trim(),
      confirmed_eligible_count: count,
    });
    if (!alive.current) {
      inFlight.current = false;
      return;
    }
    if (result.kind === "stale") {
      // Stay busy until the new count lands, so a second click cannot send the old one.
      const fresh = await loadPreview();
      inFlight.current = false;
      if (!alive.current || fresh.kind === "superseded") return;
      setBusy(false);
      if (fresh.kind === "ok") {
        setStale(true);
      } else {
        setCount(null); // never confirm a count that is known stale
        setStep("reason"); // the preview retry lives on the first step
      }
      return;
    }
    inFlight.current = false;
    setBusy(false);
    if (result.kind === "ok") {
      clearStepUpDraft(draftKey);
      onReleased();
    } else if (result.kind === "step_up") {
      stashStepUpDraft(draftKey, { holdId: hold.id, reason } satisfies ReleaseDraft);
      if (!goStepUp(result.error)) setError(W.STEP_UP_TEXT);
    } else {
      setError(result.kind === "denied" ? deniedText(result) : W.RELEASE_FAILED);
    }
  };

  const reasonShort = reason.trim().length < MESSAGE_LEGAL_HOLD_REASON_MIN_LENGTH;
  const title = step === "reason" ? W.RELEASE_TITLE : W.CONFIRM_TITLE;
  return (
    <Modal
      open
      role={step === "confirm" ? "alertdialog" : "dialog"}
      ariaLabel={title}
      ariaDescribedBy={detailId}
      onClose={cancel}
      dismissOnScrim={reason.trim() === ""}
      width="36rem"
    >
      <div className="wx-retention-dialog" key={step}>
        <h2 ref={headingRef} tabIndex={-1}>
          {title}
        </h2>
        {step === "reason" ? (
          <>
            <p id={detailId} className="wx-retention-detail" aria-live="polite">
              {count === null
                ? previewFailed
                  ? W.PREVIEW_FAILED
                  : W.PREVIEW_LOADING
                : W.previewText(count)}
            </p>
            {count === null && previewFailed ? (
              <Button type="button" tone="secondary" size="sm" onClick={() => void loadPreview()}>
                {W.PREVIEW_RETRY_LABEL}
              </Button>
            ) : null}
            <TextAreaField
              label={W.RELEASE_REASON_LABEL}
              hint={W.REASON_HINT}
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <div className="wx-retention-dialog-actions">
              <Button type="button" tone="secondary" onClick={cancel}>
                {W.CANCEL_LABEL}
              </Button>
              <Button
                type="button"
                tone="primary"
                aria-disabled={count === null || reasonShort}
                onClick={() => {
                  if (count !== null && !reasonShort) setStep("confirm");
                }}
              >
                {W.CONTINUE_LABEL}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p id={detailId} className="wx-retention-detail">
              {W.confirmText(hold.name, count ?? 0)}
            </p>
            {stale && count !== null ? (
              <p className="wx-retention-error" role="alert">
                {W.staleText(count)}
              </p>
            ) : null}
            {error ? (
              <p className="wx-retention-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="wx-retention-dialog-actions">
              <Button
                type="button"
                tone="secondary"
                aria-disabled={busy}
                onClick={() => !inFlight.current && setStep("reason")}
              >
                {W.BACK_LABEL}
              </Button>
              <Button
                type="button"
                tone="danger"
                aria-disabled={busy}
                onClick={() => void confirm()}
              >
                {W.confirmActionLabel(hold.name)}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
