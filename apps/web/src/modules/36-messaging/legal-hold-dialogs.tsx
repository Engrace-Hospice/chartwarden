// M36 WP 5.6 (ADR-0086, PROPOSED) - the two dialogs of the legal-hold tab. "Place" collects a scope, a name and a reason (>= 10 characters); "Release"
// is two steps: a preview ("N messages will become eligible on the next scan") and then a SECOND explicit confirmation that sends the count the
// officer saw. A stale count (409 RELEASE_PREVIEW_STALE) shows the new count and asks again. A stale step-up stashes what was typed and sends the
// officer through the step-up page. Names and reasons are free text and are only ever rendered as text.
import {
  MESSAGE_LEGAL_HOLD_REASON_MIN_LENGTH,
  type ApplyMessageLegalHoldRequest,
  type MessageLegalHoldDto,
} from "@wardenx/types";
import { Button, Modal, TextAreaField, TextField } from "@wardenx/ui";
import { useEffect, useId, useState } from "react";
import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  clearStepUpDraft,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpRedirectFor,
} from "../../shell/step-up-redirect";
import * as W from "./retention-wording";
import type { ActionResult, LegalHoldActions } from "./use-retention";

export const CREATE_DRAFT_KEY = "messaging-legal-hold-create";
export const RELEASE_DRAFT_KEY = "messaging-legal-hold-release";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CreateDraft {
  readonly name: string;
  readonly reason: string;
  readonly orgWide: boolean;
  readonly channels: string;
  readonly users: string;
  readonly patients: string;
}
export interface ReleaseDraft {
  readonly holdId: string;
  readonly reason: string;
}

const splitIds = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

function useStepUpNavigation(): (error: unknown) => boolean {
  const navigate = useNavigate();
  const location = useLocation();
  return (error) => {
    const to = stepUpRedirectFor(error, `${location.pathname}${location.search}`);
    if (!to) return false;
    navigate(to);
    return true;
  };
}

const EMPTY_DRAFT: CreateDraft = {
  name: "",
  reason: "",
  orgWide: false,
  channels: "",
  users: "",
  patients: "",
};

export function CreateHoldDialog({
  actions,
  onClose,
  onPlaced,
}: {
  readonly actions: LegalHoldActions;
  readonly onClose: () => void;
  readonly onPlaced: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState<CreateDraft>(
    () => peekStepUpDraft<CreateDraft>(CREATE_DRAFT_KEY) ?? EMPTY_DRAFT,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const goStepUp = useStepUpNavigation();
  const detailId = useId();
  const set = (patch: Partial<CreateDraft>): void => setDraft((d) => ({ ...d, ...patch }));

  const submit = async (): Promise<void> => {
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
    const badList = checks.find(([, ids]) => ids.some((id) => !UUID.test(id)));
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
    setBusy(true);
    setError(null);
    const result: ActionResult = await actions.apply(body);
    setBusy(false);
    if (result.kind === "ok") {
      clearStepUpDraft(CREATE_DRAFT_KEY);
      onPlaced();
      return;
    }
    if (result.kind === "step_up") {
      stashStepUpDraft(CREATE_DRAFT_KEY, draft);
      if (!goStepUp(result.error)) setError(W.STEP_UP_TEXT);
      return;
    }
    setError(result.kind === "invalid" ? W.CREATE_INVALID : W.CREATE_FAILED);
  };

  const cancel = (): void => {
    clearStepUpDraft(CREATE_DRAFT_KEY);
    onClose();
  };

  return (
    <Modal
      open
      ariaLabel={W.CREATE_TITLE}
      ariaDescribedBy={detailId}
      onClose={cancel}
      width="36rem"
    >
      <form
        className="wx-retention-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void submit();
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
          hint={W.REASON_HINT}
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
          <Button type="button" tone="secondary" onClick={cancel}>
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

export function ReleaseHoldDialog({
  hold,
  actions,
  onClose,
  onReleased,
}: {
  readonly hold: MessageLegalHoldDto;
  readonly actions: LegalHoldActions;
  readonly onClose: () => void;
  readonly onReleased: () => void;
}): JSX.Element {
  const [reason, setReason] = useState(() => {
    const d = peekStepUpDraft<ReleaseDraft>(RELEASE_DRAFT_KEY);
    return d?.holdId === hold.id ? d.reason : "";
  });
  const [step, setStep] = useState<Step>("reason");
  const [count, setCount] = useState<number | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const goStepUp = useStepUpNavigation();
  const detailId = useId();

  const loadPreview = async (): Promise<number | null> => {
    const preview = await actions.preview(hold.id);
    setPreviewFailed(preview === null);
    if (preview) setCount(preview.eligible_on_release);
    return preview?.eligible_on_release ?? null;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the preview is read once per opened dialog
  useEffect(() => {
    void loadPreview();
  }, [hold.id]);

  const cancel = (): void => {
    clearStepUpDraft(RELEASE_DRAFT_KEY);
    onClose();
  };

  const confirm = async (): Promise<void> => {
    if (count === null) return;
    setBusy(true);
    setError(null);
    setStale(false);
    const result = await actions.release(hold.id, {
      reason: reason.trim(),
      confirmed_eligible_count: count,
    });
    setBusy(false);
    if (result.kind === "ok") {
      clearStepUpDraft(RELEASE_DRAFT_KEY);
      onReleased();
    } else if (result.kind === "step_up") {
      stashStepUpDraft(RELEASE_DRAFT_KEY, { holdId: hold.id, reason } satisfies ReleaseDraft);
      if (!goStepUp(result.error)) setError(W.STEP_UP_TEXT);
    } else if (result.kind === "stale") {
      const fresh = await loadPreview();
      if (fresh === null) setError(W.PREVIEW_FAILED);
      else setStale(true);
    } else {
      setError(W.RELEASE_FAILED);
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
      width="36rem"
    >
      <div className="wx-retention-dialog">
        <h2>{title}</h2>
        {step === "reason" ? (
          <>
            <p id={detailId} className="wx-retention-detail">
              {count === null
                ? previewFailed
                  ? W.PREVIEW_FAILED
                  : W.PREVIEW_LOADING
                : W.previewText(count)}
            </p>
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
              {stale && count !== null ? W.staleText(count) : W.confirmText(hold.name, count ?? 0)}
            </p>
            {error ? (
              <p className="wx-retention-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="wx-retention-dialog-actions">
              <Button type="button" tone="secondary" onClick={() => setStep("reason")}>
                {W.BACK_LABEL}
              </Button>
              <Button
                type="button"
                tone="danger"
                aria-disabled={busy}
                onClick={() => !busy && void confirm()}
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
