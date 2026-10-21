// M36 WP 5.8 (ADR-0087, PROPOSED) - "Request break-glass access" for a conversation the person cannot otherwise read. Offered only when the person
// holds messaging.break_glass.invoke AND the tenant flag messaging.break_glass is on (no flag provider reads as OFF); the server stays the authority.
// The dialog says plainly what the access is (read-only, one conversation, recorded, reviewed). A refusal (404) never says why: it would disclose a
// Part 2 status or a role category. A stale step-up stashes what was typed (the shared sessionStorage stash, scoped to org + user + action + channel,
// dropped after 15 minutes) and sends the person through the step-up page; the justification is never put in a URL, localStorage or a log.
import {
  BREAK_GLASS_ALREADY_ACTIVE_CODE,
  BREAK_GLASS_DEFAULT_MINUTES,
  BREAK_GLASS_FLAG_KEY,
  BREAK_GLASS_INVOKE_STEP_UP_KEY,
  BREAK_GLASS_JUSTIFICATION_MAX,
  BREAK_GLASS_JUSTIFICATION_MIN,
  BREAK_GLASS_MAX_MINUTES,
  BREAK_GLASS_MIN_MINUTES,
  BREAK_GLASS_NOT_NEEDED_CODE,
  BREAK_GLASS_REASON_CODES,
  type BreakGlassReasonCode,
} from "@chartwarden/types";
import {
  Button,
  Modal,
  SelectField,
  TextAreaField,
  TextField,
  useFeatureFlag,
} from "@chartwarden/ui";
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
import * as W from "./break-glass-wording";
import { useOnlineStatus } from "./offline-banner";
import { type BreakGlassActions, useBreakGlassActions } from "./use-break-glass";

/** The step-up action the request demands (the server's BREAK_GLASS_INVOKE_STEP_UP_KEY). */
export const REQUEST_ACTION = BREAK_GLASS_INVOKE_STEP_UP_KEY;
const REQUEST_ACTIONS: readonly string[] = [REQUEST_ACTION];
const CUSTOM = "custom";

interface RequestDraft {
  readonly reasonCode: BreakGlassReasonCode;
  readonly justification: string;
  /** A preset's minutes as text, or "custom". */
  readonly preset: string;
  readonly custom: string;
}
const EMPTY: RequestDraft = {
  reasonCode: "patient_safety",
  justification: "",
  preset: String(BREAK_GLASS_DEFAULT_MINUTES),
  custom: "",
};

const draftKey = (owner: StepUpDraftOwner, channelId: string): string | null =>
  stepUpDraftKey(owner, REQUEST_ACTION, channelId);

function readDraft(owner: StepUpDraftOwner, channelId: string): RequestDraft | null {
  const d = peekStepUpDraft<Record<string, unknown>>(draftKey(owner, channelId));
  if (
    d &&
    typeof d.justification === "string" &&
    typeof d.preset === "string" &&
    typeof d.custom === "string" &&
    (BREAK_GLASS_REASON_CODES as readonly unknown[]).includes(d.reasonCode)
  ) {
    return {
      reasonCode: d.reasonCode as BreakGlassReasonCode,
      justification: d.justification,
      preset: d.preset,
      custom: d.custom,
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

/** Whole minutes for the draft, or null when it is not a valid duration. */
const minutesOf = (draft: RequestDraft): number | null => {
  const raw = draft.preset === CUSTOM ? draft.custom.trim() : draft.preset;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= BREAK_GLASS_MIN_MINUTES && n <= BREAK_GLASS_MAX_MINUTES ? n : null;
};

function RequestDialog({
  channelId,
  initial,
  actions,
  onClose,
  onOpened,
  onNotNeeded,
}: {
  readonly channelId: string;
  readonly initial: RequestDraft | null;
  readonly actions: BreakGlassActions;
  readonly onClose: () => void;
  readonly onOpened: () => void;
  readonly onNotNeeded: () => void;
}): JSX.Element {
  const owner = useStepUpOwner();
  const key = draftKey(owner, channelId);
  const online = useOnlineStatus();
  const navigate = useNavigate();
  const location = useLocation();
  const [draft, setDraft] = useState<RequestDraft>(initial ?? EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const detailId = useId();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const set = (patch: Partial<RequestDraft>): void => setDraft((d) => ({ ...d, ...patch }));
  const trimmed = draft.justification.trim();

  const submit = async (): Promise<void> => {
    if (inFlight.current || !online) return;
    const minutes = minutesOf(draft);
    if (
      trimmed.length < BREAK_GLASS_JUSTIFICATION_MIN ||
      trimmed.length > BREAK_GLASS_JUSTIFICATION_MAX
    ) {
      setError(W.JUSTIFICATION_INVALID);
      return;
    }
    if (minutes === null) {
      setError(W.DURATION_INVALID);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const result = await actions.create({
      channelId,
      reasonCode: draft.reasonCode,
      justification: trimmed,
      durationMinutes: minutes,
    });
    inFlight.current = false;
    const alreadyActive =
      result.kind === "conflict" && result.code === BREAK_GLASS_ALREADY_ACTIVE_CODE;
    const notNeeded = result.kind === "conflict" && result.code === BREAK_GLASS_NOT_NEEDED_CODE;
    // The request is over either way: drop the stashed draft even if the dialog went away mid-request.
    if (result.kind === "ok" || alreadyActive || notNeeded) clearStepUpDraft(key);
    if (!alive.current) return;
    setBusy(false);
    if (result.kind === "ok" || alreadyActive) {
      onOpened(); // a live grant exists: open it
      return;
    }
    if (notNeeded) {
      onNotNeeded(); // the person is a member already: refresh the channel list so the conversation opens
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
            ? W.JUSTIFICATION_INVALID
            : result.kind === "denied"
              ? result.code === 401
                ? W.SIGN_IN
                : W.DENIED
              : W.REQUEST_FAILED,
    );
  };

  const cancel = useCallback((): void => {
    if (inFlight.current) return; // the request is out: closing now would hide its outcome
    clearStepUpDraft(key);
    onClose();
  }, [key, onClose]);

  return (
    <Modal
      open
      ariaLabel={W.REQUEST_TITLE}
      ariaDescribedBy={detailId}
      onClose={cancel}
      dismissOnScrim={trimmed === ""}
      width="36rem"
    >
      <form
        className="wx-break-glass-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2>{W.REQUEST_TITLE}</h2>
        <p id={detailId} className="wx-break-glass-detail">
          {W.REQUEST_DETAIL}
        </p>
        <SelectField
          label={W.REASON_LABEL}
          value={draft.reasonCode}
          onChange={(e) => set({ reasonCode: e.target.value as BreakGlassReasonCode })}
          options={BREAK_GLASS_REASON_CODES.map((code) => ({
            value: code,
            label: W.REASON_LABELS[code],
          }))}
        />
        <TextAreaField
          label={W.JUSTIFICATION_LABEL}
          hint={`${W.JUSTIFICATION_HINT} ${W.justificationCount(trimmed.length, BREAK_GLASS_JUSTIFICATION_MIN, BREAK_GLASS_JUSTIFICATION_MAX)}`}
          rows={4}
          value={draft.justification}
          onChange={(e) => set({ justification: e.target.value })}
        />
        <SelectField
          label={W.DURATION_LABEL}
          value={draft.preset}
          onChange={(e) => set({ preset: e.target.value })}
          options={[
            ...W.DURATION_PRESETS.map((p) => ({ value: String(p.minutes), label: p.label })),
            { value: CUSTOM, label: W.DURATION_CUSTOM },
          ]}
        />
        {draft.preset === CUSTOM ? (
          <TextField
            label={W.DURATION_CUSTOM_LABEL}
            inputMode="numeric"
            value={draft.custom}
            onChange={(e) => set({ custom: e.target.value })}
          />
        ) : null}
        {!online ? (
          <p className="wx-break-glass-error" role="alert">
            {W.OFFLINE_TEXT}
          </p>
        ) : null}
        {error ? (
          <p className="wx-break-glass-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="wx-break-glass-actions">
          <Button type="button" tone="secondary" onClick={cancel}>
            {W.CANCEL_LABEL}
          </Button>
          <Button type="submit" tone="primary" disabled={busy || !online}>
            {W.SUBMIT_LABEL}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * The entry point on a conversation the person cannot read. Null unless they may ask (the key and the live flag). `onOpened` re-reads the
 * caller's grants and channels; the dialog closes only once that has been handed back.
 */
export function BreakGlassRequest({
  channelId,
  onOpened,
  onNotNeeded,
}: {
  readonly channelId: string;
  /** A live grant exists (just opened, or already active): re-read the caller's grants. */
  readonly onOpened: () => void;
  /** The person can already read the conversation (a member): refresh the channel list so it opens. */
  readonly onNotNeeded: () => void;
}): JSX.Element | null {
  const session = useSession();
  const flagOn = useFlag(BREAK_GLASS_FLAG_KEY);
  const actions = useBreakGlassActions();
  const owner = useStepUpOwner();
  const returning = useStepUpReturn(owner, REQUEST_ACTIONS);
  // Back from the step-up page with a stash for THIS channel: reopen the dialog with what was typed (once).
  const [resume] = useState<RequestDraft | null>(() =>
    returning ? readDraft(owner, channelId) : null,
  );
  const [open, setOpen] = useState(() => resume !== null);
  const [initial, setInitial] = useState(resume);
  const allowed = flagOn && (session?.permissions?.includes(W.INVOKE_PERMISSION) ?? false);
  if (!allowed) return null;
  return (
    <>
      <Button type="button" tone="primary" onClick={() => setOpen(true)}>
        {W.REQUEST_BUTTON}
      </Button>
      {open ? (
        <RequestDialog
          channelId={channelId}
          initial={initial}
          actions={actions}
          onClose={() => {
            setInitial(null);
            setOpen(false);
          }}
          onOpened={() => {
            setInitial(null);
            setOpen(false);
            onOpened();
          }}
          onNotNeeded={() => {
            setInitial(null);
            setOpen(false);
            onNotNeeded();
          }}
        />
      ) : null}
    </>
  );
}
