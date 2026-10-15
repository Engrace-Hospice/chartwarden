// M36 WP 4.1 - the composer's "Urgent clinical" action, beside Poll and the medication question. It renders nothing unless
// the options route says the mode is on AND the conversation is a patient's care-team conversation (a definitive no reads as
// hidden); a transient failure shows a disabled button and a status while it retries. The server stays the authority. The
// draft and the send attempt live here, keyed by channel, so a close/reopen keeps them; the outcome stays on screen in a
// focusable status that clears after a while or when the composer text changes.
import { Button } from "@wardenx/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { ChannelKind } from "./messaging-types";
import { UrgentMessageDialog, type UrgentSent } from "./urgent-message-dialog";
import {
  SENT_REPLAY_TEXT,
  SENT_TEXT,
  UNAVAILABLE_TEXT,
  URGENT_BUTTON_LABEL,
} from "./urgent-wording";
import { useUrgentDraft } from "./use-urgent-draft";
import { useUrgentOptions } from "./use-urgent-options";
import "./urgent.css";

/** How long the "sent" status stays on screen. */
export const SENT_STATUS_MS = 20_000;

interface ButtonProps {
  channelId: string;
  kind: ChannelKind;
  disabled?: boolean;
  /** The thread reloads so the new message shows without waiting for the next poll. */
  onSent?: () => void;
  /** Changes whenever the composer text changes: the previous outcome is no longer news. */
  statusResetKey?: string;
}

/** Keyed by channel so every piece of state (options, draft, ids, status, open dialog) starts clean on a switch. */
export function UrgentMessageButton(props: ButtonProps): JSX.Element {
  return <UrgentControl key={props.channelId} {...props} />;
}

function UrgentControl({
  channelId,
  kind,
  disabled = false,
  onSent,
  statusResetKey,
}: ButtonProps): JSX.Element | null {
  const state = useUrgentOptions(channelId, kind !== "care_team");
  const draft = useUrgentDraft();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      // A send still in flight when the person leaves this conversation must not touch the next one.
      mounted.current = false;
    };
  }, []);
  // The trigger is the one stable control: focus returns to it whenever the dialog closes.
  useEffect(() => {
    if (wasOpen.current && !open) rootRef.current?.querySelector("button")?.focus();
    wasOpen.current = open;
  }, [open]);
  // The outcome is news for a while, and not once the person starts a new message.
  // biome-ignore lint/correctness/useExhaustiveDependencies: statusResetKey is the trigger
  useEffect(() => setStatus(""), [statusResetKey]);
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(""), SENT_STATUS_MS);
    return () => clearTimeout(timer);
  }, [status]);
  if (state.status === "hidden") return null;
  const sentText = (sent: UrgentSent): string => (sent.created ? SENT_TEXT : SENT_REPLAY_TEXT);
  return (
    <div className="wx-urgent" ref={rootRef}>
      <Button
        type="button"
        tone="secondary"
        size="lg"
        disabled={disabled || state.status !== "ready"}
        onClick={() => {
          setStatus("");
          state.reload();
          setOpen(true);
        }}
      >
        {URGENT_BUTTON_LABEL}
      </Button>
      {open && state.status === "ready" ? (
        <UrgentMessageDialog
          channelId={channelId}
          options={state.options}
          draft={draft}
          onClose={() => setOpen(false)}
          onSent={(sent) => {
            if (!mounted.current) return;
            draft.reset();
            setStatus(sentText(sent));
            setOpen(false);
            onSent?.();
          }}
          onIndeterminate={() => {
            if (mounted.current) onSent?.();
          }}
        />
      ) : null}
      <output className="wx-urgent-status" tabIndex={status ? 0 : undefined}>
        {state.status === "unavailable" ? UNAVAILABLE_TEXT : status}
      </output>
    </div>
  );
}
