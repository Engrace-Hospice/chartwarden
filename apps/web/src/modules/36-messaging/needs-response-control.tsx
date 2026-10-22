// M36 G2 - the composer's "Needs a response" checkbox and its one-recipient picker (off by default, never remembered).
// Offered only when the ack feature flag is on, the person holds messaging.send + messaging.urgent.send, and the options
// route (shared with Urgent clinical) lists at least one qualified colleague. The server stays the authority. The picker is an
// inline radiogroup, not a dialog: it has no <form> of its own, so nothing here can submit the composer's form.
import { ACK_REQUESTS_FLAG_KEY, URGENT_SEND_PERMISSION } from "@chartwarden/types";
import { useFeatureFlag } from "@chartwarden/ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { useSession } from "../../shell/session";
import type { ChannelKind } from "./messaging-types";
import {
  NEEDS_RESPONSE_CHOOSE_TEXT,
  NEEDS_RESPONSE_LABEL,
  NEEDS_RESPONSE_NONE_TEXT,
  NEEDS_RESPONSE_NOTICE,
  NEEDS_RESPONSE_PICKER_LEGEND,
  type NeedsResponseSend,
  REQUEST_FAILED_TEXT,
  REQUEST_INDETERMINATE_TEXT,
  type RequestOutcome,
  askLine,
  requestedText,
} from "./needs-response";
import { recipientChoices } from "./urgent-message-dialog";
import { NEEDS_CONNECTION_TEXT } from "./urgent-wording";
import { useOfflineGate } from "./use-offline-gate";
import { useUrgentOptions } from "./use-urgent-options";
import "./needs-response.css";

/** Said (politely) when the connection drops while the box is checked. */
export const NEEDS_RESPONSE_OFFLINE_CLEARED_TEXT =
  "Needs a response was cleared because you are offline. Reconnect to ask for a response.";
const SEND_PERMISSION = "messaging.send";
/** The picker's legend: the composer's Send button is described by it while nobody is chosen. */
export const NEEDS_RESPONSE_PICKER_ID = "messaging-needs-response-picker";
/** How long the outcome stays on screen. */
export const NEEDS_RESPONSE_STATUS_MS = 20_000;

function useFlag(key: string): boolean {
  try {
    return useFeatureFlag(key);
  } catch {
    return false; // no provider mounted: fail closed
  }
}

export interface NeedsResponse {
  readonly offered: boolean;
  readonly choices: ReadonlyArray<{ readonly userId: string; readonly label: string }>;
  readonly checked: boolean;
  readonly recipientId: string;
  readonly missing: boolean;
  readonly status: { readonly text: string; readonly failed: boolean } | null;
  readonly setChecked: (checked: boolean) => void;
  readonly choose: (userId: string) => void;
  /** Handed to the message sender. */
  readonly forSend: NeedsResponseSend;
}

/** State lives in the thread (keyed by channel) because the sender reads it; the control below only renders it. */
export function useNeedsResponse(channelId: string, kind: ChannelKind): NeedsResponse {
  const permissions = useSession()?.permissions;
  const allowed =
    (permissions?.includes(SEND_PERMISSION) ?? false) &&
    (permissions?.includes(URGENT_SEND_PERMISSION) ?? false);
  const flagOn = useFlag(ACK_REQUESTS_FLAG_KEY);
  const eligible = kind === "care_team" && flagOn && allowed;
  // Deliberate (spec G2): the recipient list is the Urgent clinical options route, so the control also needs that mode on.
  const options = useUrgentOptions(channelId, !eligible);
  const choices = options.status === "ready" ? recipientChoices(options.options).choices : [];
  const [checked, setCheckedState] = useState(false);
  const [recipientId, setRecipientId] = useState("");
  const [missing, setMissing] = useState(false);
  const [status, setStatus] = useState<NeedsResponse["status"]>(null);
  const latest = useRef({ choices, recipientId });
  latest.current = { choices, recipientId };

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), NEEDS_RESPONSE_STATUS_MS);
    return () => clearTimeout(timer);
  }, [status]);
  // A colleague who disappeared from the list (or a list that emptied) can no longer be asked.
  useEffect(() => {
    if (recipientId && !choices.some((c) => c.userId === recipientId)) setRecipientId("");
    if (checked && options.status === "ready" && choices.length === 0) setCheckedState(false);
  }, [choices, recipientId, checked, options.status]);

  const setChecked = useCallback((next: boolean) => {
    setCheckedState(next);
    setStatus(null);
    setMissing(false);
    if (!next) setRecipientId("");
  }, []);
  const choose = useCallback((userId: string) => {
    setRecipientId(userId);
    setMissing(false);
  }, []);
  const onRequested = useCallback((outcome: RequestOutcome) => {
    const name = latest.current.choices.find((c) => c.userId === latest.current.recipientId)?.label;
    setStatus(
      outcome === "ok"
        ? { text: requestedText(name ?? "Your colleague"), failed: false }
        : {
            text: outcome === "refused" ? REQUEST_FAILED_TEXT : REQUEST_INDETERMINATE_TEXT,
            failed: true,
          },
    );
    // Never remembered: the next message starts unchecked.
    setCheckedState(false);
    setRecipientId("");
  }, []);
  const onMissingRecipient = useCallback(() => setMissing(true), []);
  return {
    offered: eligible && options.status === "ready",
    choices,
    checked,
    recipientId,
    missing,
    status,
    setChecked,
    choose,
    forSend: { checked, recipientId, onMissingRecipient, onRequested },
  };
}

export function NeedsResponseControl({
  state,
  disabled = false,
}: {
  state: NeedsResponse;
  disabled?: boolean;
}): JSX.Element | null {
  const id = useId();
  const boxRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLFieldSetElement>(null);
  const { checked, recipientId, missing, status, choices } = state;
  const gate = useOfflineGate();
  const { online, announce } = gate;
  const { setChecked } = state; // referentially stable (useCallback with no deps)
  // Never queued: a request still checked when the connection drops is cleared rather than left to fail at send time,
  // and the person is told, so a message that now goes out as a plain one is not a surprise.
  useEffect(() => {
    if (online || !checked) return;
    setChecked(false);
    announce(NEEDS_RESPONSE_OFFLINE_CLEARED_TEXT);
  }, [online, checked, setChecked, announce]);
  // The sender refused (checked, nobody chosen): move to the picker so the error is heard.
  useEffect(() => {
    if (missing) pickerRef.current?.focus();
  }, [missing]);
  const chosen = choices.find((c) => c.userId === recipientId);
  const statusNode = (
    <output
      className={
        status?.failed
          ? "wx-needs-response-status wx-needs-response-error"
          : "wx-needs-response-status"
      }
      aria-live={status?.failed ? "assertive" : "polite"}
    >
      {status?.text ?? ""}
    </output>
  );
  if (!state.offered) return statusNode;

  function onPickerKeyDown(event: KeyboardEvent<HTMLFieldSetElement>): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    state.setChecked(false);
    boxRef.current?.focus();
  }

  return (
    <div className="wx-needs-response">
      <label className="wx-needs-response-row">
        <input
          ref={boxRef}
          type="checkbox"
          checked={checked}
          disabled={disabled || choices.length === 0}
          aria-disabled={online ? undefined : true}
          aria-describedby={`${id}-notice`}
          onClick={() => {
            if (!online) gate.onBlocked();
          }}
          onChange={(event) => {
            if (online) state.setChecked(event.target.checked);
          }}
        />
        <span>{NEEDS_RESPONSE_LABEL}</span>
      </label>
      <output id={`${id}-notice`} className="wx-needs-response-notice" aria-live="off">
        {!online
          ? NEEDS_CONNECTION_TEXT
          : choices.length === 0
            ? NEEDS_RESPONSE_NONE_TEXT
            : NEEDS_RESPONSE_NOTICE}
      </output>
      {checked ? (
        <fieldset
          ref={pickerRef}
          tabIndex={-1}
          className="wx-needs-response-picker"
          disabled={disabled}
          aria-describedby={missing ? `${id}-error` : undefined}
          onKeyDown={onPickerKeyDown}
        >
          <legend id={NEEDS_RESPONSE_PICKER_ID}>{NEEDS_RESPONSE_PICKER_LEGEND} (required)</legend>
          {choices.map((person) => (
            <label key={person.userId} className="wx-needs-response-row">
              <input
                type="radio"
                name={`${id}-recipient`}
                value={person.userId}
                checked={recipientId === person.userId}
                onChange={() => state.choose(person.userId)}
              />
              <span>{person.label}</span>
            </label>
          ))}
          {missing ? (
            <p id={`${id}-error`} className="wx-needs-response-error" role="alert">
              {NEEDS_RESPONSE_CHOOSE_TEXT}
            </p>
          ) : null}
          <p aria-live="polite" className="wx-needs-response-notice">
            {chosen ? askLine(chosen.label) : ""}
          </p>
        </fieldset>
      ) : null}
      {statusNode}
      {gate.region}
    </div>
  );
}

/** True when the box is checked and nobody is chosen: the composer's Send stays disabled (described by the picker). */
export const needsRecipient = (state: NeedsResponse): boolean =>
  state.offered && state.checked && state.recipientId === "";
