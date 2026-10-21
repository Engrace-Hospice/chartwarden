// M36 WP 5.7 (ADR-0089, PROPOSED) - "Request an export" dialog. Offered only with messaging.export.request AND the tenant flag messaging.export (no flag
// provider reads as OFF); the server stays the authority. The dialog says up front what an export leaves out. A stale step-up stashes what was typed (the
// shared sessionStorage stash, dropped after 15 minutes) and sends the person through the step-up page; the justification never goes in a URL or a log.
import {
  EXPORT_MAX_RANGE_DAYS,
  MESSAGING_EXPORT_FLAG_KEY,
  MESSAGING_EXPORT_JUSTIFICATION_MAX,
  MESSAGING_EXPORT_JUSTIFICATION_MIN,
  MESSAGING_EXPORT_REQUEST_STEP_UP_KEY,
  type MessagingExportScopeKind,
} from "@chartwarden/types";
import { Button, Modal, TextAreaField, TextField, useFeatureFlag } from "@chartwarden/ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  type StepUpDraftOwner,
  clearStepUpDraft,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
  stepUpRedirectFor,
} from "../../shell/step-up-redirect";
import { useStepUpOwner, useStepUpReturn } from "../../shell/use-step-up-return";
import { conflictText } from "./export-wording";
import * as W from "./export-wording";
import { useOnlineStatus } from "./offline-banner";
import { type ExportActions, useExportActions } from "./use-export";
import "./export.css";

export const REQUEST_ACTION = MESSAGING_EXPORT_REQUEST_STEP_UP_KEY;
const REQUEST_ACTIONS: readonly string[] = [REQUEST_ACTION];
const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Draft {
  readonly scopeKind: MessagingExportScopeKind;
  readonly id: string;
  readonly dateFrom: string;
  readonly dateTo: string;
  readonly justification: string;
}
const EMPTY: Draft = { scopeKind: "channel", id: "", dateFrom: "", dateTo: "", justification: "" };

const draftKey = (owner: StepUpDraftOwner): string | null =>
  stepUpDraftKey(owner, REQUEST_ACTION, "export");

function readDraft(owner: StepUpDraftOwner): Draft | null {
  const d = peekStepUpDraft<Record<string, unknown>>(draftKey(owner));
  if (
    d &&
    (d.scopeKind === "channel" || d.scopeKind === "patient") &&
    typeof d.id === "string" &&
    typeof d.dateFrom === "string" &&
    typeof d.dateTo === "string" &&
    typeof d.justification === "string"
  ) {
    return {
      scopeKind: d.scopeKind,
      id: d.id,
      dateFrom: d.dateFrom,
      dateTo: d.dateTo,
      justification: d.justification,
    };
  }
  return null;
}

function useFlag(key: string): boolean {
  try {
    return useFeatureFlag(key);
  } catch {
    return false; // no provider mounted: fail closed
  }
}

/** The first thing wrong with the draft, as a sentence, or null when it can be sent. Exported for the unit of validation. */
export function validateDraft(draft: Draft): string | null {
  if (!UUID.test(draft.id.trim())) return W.ID_INVALID;
  const from = draft.dateFrom.trim();
  const to = draft.dateTo.trim();
  if ((from === "") !== (to === "")) return W.DATES_BOTH;
  if (from !== "") {
    const a = DATE.test(from) ? Date.parse(from) : Number.NaN;
    const b = DATE.test(to) ? Date.parse(to) : Number.NaN;
    if (Number.isNaN(a) || Number.isNaN(b)) return W.DATES_BOTH;
    if (b < a) return W.DATES_ORDER;
    if ((b - a) / DAY_MS > EXPORT_MAX_RANGE_DAYS) return W.datesTooLong(EXPORT_MAX_RANGE_DAYS);
  }
  const n = draft.justification.trim().length;
  if (n < MESSAGING_EXPORT_JUSTIFICATION_MIN || n > MESSAGING_EXPORT_JUSTIFICATION_MAX)
    return W.JUSTIFICATION_INVALID;
  return null;
}

function RequestDialog({
  initial,
  actions,
  onClose,
  onRequested,
}: {
  readonly initial: Draft | null;
  readonly actions: ExportActions;
  readonly onClose: () => void;
  readonly onRequested: () => void;
}): JSX.Element {
  const owner = useStepUpOwner();
  const key = draftKey(owner);
  const online = useOnlineStatus();
  const navigate = useNavigate();
  const location = useLocation();
  const [draft, setDraft] = useState<Draft>(initial ?? EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const noticeId = useId();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const set = (patch: Partial<Draft>): void => setDraft((d) => ({ ...d, ...patch }));
  const trimmed = draft.justification.trim();

  const submit = async (): Promise<void> => {
    if (inFlight.current || !online) return;
    const problem = validateDraft(draft);
    if (problem) {
      setError(problem);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const id = draft.id.trim();
    const from = draft.dateFrom.trim();
    const result = await actions.create({
      scopeKind: draft.scopeKind,
      ...(draft.scopeKind === "channel" ? { channelId: id } : { patientId: id }),
      ...(from === "" ? {} : { dateFrom: from, dateTo: draft.dateTo.trim() }),
      justification: trimmed,
    });
    inFlight.current = false;
    if (result.kind === "ok") clearStepUpDraft(key);
    if (!alive.current) return;
    setBusy(false);
    if (result.kind === "ok") {
      onRequested();
      return;
    }
    if (result.kind === "step_up") {
      stashStepUpDraft(key, draft);
      const to = stepUpRedirectFor(result.error, `${location.pathname}${location.search}`);
      if (to) navigate(to);
      else setError(W.STEP_UP_TEXT);
      return;
    }
    setError(
      result.kind === "limit"
        ? W.LIMIT_TEXT
        : result.kind === "not_available"
          ? W.NOT_AVAILABLE
          : result.kind === "invalid"
            ? W.INVALID_TEXT
            : result.kind === "conflict"
              ? conflictText(result.code)
              : result.kind === "denied"
                ? result.code === 401
                  ? W.SIGN_IN
                  : W.DENIED
                : W.REQUEST_FAILED,
    );
  };

  const close = useCallback((): void => {
    if (inFlight.current) return; // the request is out: closing now would hide its outcome
    clearStepUpDraft(key);
    onClose();
  }, [key, onClose]);

  return (
    <Modal
      open
      ariaLabel={W.REQUEST_TITLE}
      ariaDescribedBy={noticeId}
      onClose={close}
      dismissOnScrim={trimmed === ""}
      width="40rem"
    >
      <form
        className="wx-export-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2>{W.REQUEST_TITLE}</h2>
        <div id={noticeId} className="wx-export-notice">
          <h3>{W.NOT_EXPORTED_HEADING}</h3>
          <ul>
            {W.NOT_EXPORTED_ITEMS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <fieldset className="wx-export-choice">
          <legend>{W.SCOPE_LEGEND}</legend>
          <label>
            <input
              type="radio"
              name="export-scope"
              checked={draft.scopeKind === "channel"}
              onChange={() => set({ scopeKind: "channel", id: "" })}
            />
            {W.SCOPE_CHANNEL}
          </label>
          <label>
            <input
              type="radio"
              name="export-scope"
              checked={draft.scopeKind === "patient"}
              onChange={() => set({ scopeKind: "patient", id: "" })}
            />
            {W.SCOPE_PATIENT}
          </label>
        </fieldset>
        <TextField
          label={draft.scopeKind === "channel" ? W.CHANNEL_ID_LABEL : W.PATIENT_ID_LABEL}
          hint={W.ID_HINT}
          value={draft.id}
          onChange={(e) => set({ id: e.target.value })}
        />
        <div className="wx-export-dates">
          <TextField
            label={W.DATE_FROM_LABEL}
            type="date"
            value={draft.dateFrom}
            onChange={(e) => set({ dateFrom: e.target.value })}
          />
          <TextField
            label={W.DATE_TO_LABEL}
            type="date"
            value={draft.dateTo}
            onChange={(e) => set({ dateTo: e.target.value })}
          />
        </div>
        <TextAreaField
          label={W.JUSTIFICATION_LABEL}
          hint={`${W.JUSTIFICATION_HINT} ${W.justificationCount(trimmed.length, MESSAGING_EXPORT_JUSTIFICATION_MIN, MESSAGING_EXPORT_JUSTIFICATION_MAX)}`}
          rows={4}
          value={draft.justification}
          onChange={(e) => set({ justification: e.target.value })}
        />
        {!online ? (
          <p className="wx-export-error" role="alert">
            {W.OFFLINE_TEXT}
          </p>
        ) : null}
        {error ? (
          <p className="wx-export-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="wx-export-actions">
          <Button type="button" tone="secondary" size="lg" onClick={close}>
            {W.CANCEL_DIALOG_LABEL}
          </Button>
          <Button type="submit" tone="primary" size="lg" disabled={busy || !online}>
            {W.SUBMIT_LABEL}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** The entry point. Null unless the person may ask (the key and the live flag). `onRequested` re-reads the list once the request is in. */
export function ExportRequest({
  onRequested,
}: {
  readonly onRequested: () => void;
}): JSX.Element | null {
  const session = useSession();
  const flagOn = useFlag(MESSAGING_EXPORT_FLAG_KEY);
  const actions = useExportActions();
  const owner = useStepUpOwner();
  const returning = useStepUpReturn(owner, REQUEST_ACTIONS);
  // Back from the step-up page with a stash: reopen the dialog with what was typed (once).
  const [resume] = useState<Draft | null>(() => (returning ? readDraft(owner) : null));
  const [open, setOpen] = useState(() => resume !== null);
  const [initial, setInitial] = useState(resume);
  const allowed = flagOn && (session?.permissions?.includes(W.REQUEST_PERMISSION) ?? false);
  if (!allowed) return null;
  const done = (): void => {
    setInitial(null);
    setOpen(false);
  };
  return (
    <>
      <Button type="button" tone="primary" onClick={() => setOpen(true)}>
        {W.REQUEST_BUTTON}
      </Button>
      {open ? (
        <RequestDialog
          initial={initial}
          actions={actions}
          onClose={done}
          onRequested={() => {
            done();
            onRequested();
          }}
        />
      ) : null}
    </>
  );
}
