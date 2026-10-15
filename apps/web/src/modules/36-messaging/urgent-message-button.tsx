// M36 WP 4.1 - the composer's "Urgent clinical" action, beside Poll and the medication question. It renders nothing unless
// the options route says the mode is on AND the conversation is a patient's care-team conversation (any 401/403/404 or
// failure reads as hidden); the server stays the authority. The outcome stays on screen in a focusable status.
import { Button } from "@wardenx/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { ChannelKind } from "./messaging-types";
import { UrgentMessageDialog, type UrgentSent } from "./urgent-message-dialog";
import { SENT_REPLAY_TEXT, SENT_TEXT, URGENT_BUTTON_LABEL } from "./urgent-wording";
import { useUrgentOptions } from "./use-urgent-options";
import "./urgent.css";

export function UrgentMessageButton({
  channelId,
  kind,
  disabled = false,
  onSent,
}: {
  channelId: string;
  kind: ChannelKind;
  disabled?: boolean;
  /** The thread reloads so the new message shows without waiting for the next poll. */
  onSent?: () => void;
}): JSX.Element | null {
  const state = useUrgentOptions(channelId, kind !== "care_team");
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  // The trigger is the one stable control: focus returns to it whenever the dialog closes.
  useEffect(() => {
    if (wasOpen.current && !open) rootRef.current?.querySelector("button")?.focus();
    wasOpen.current = open;
  }, [open]);
  // A different conversation starts with a clean status and no open dialog.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets only when the channel changes
  useEffect(() => {
    wasOpen.current = false; // a channel switch is not a close: focus stays where the person put it
    setOpen(false);
    setStatus("");
  }, [channelId]);
  if (state.status !== "ready") return null;
  const sentText = (sent: UrgentSent): string => (sent.created ? SENT_TEXT : SENT_REPLAY_TEXT);
  return (
    <div className="wx-urgent" ref={rootRef}>
      <Button
        type="button"
        tone="secondary"
        size="lg"
        disabled={disabled}
        onClick={() => {
          setStatus("");
          setOpen(true);
        }}
      >
        {URGENT_BUTTON_LABEL}
      </Button>
      {open ? (
        <UrgentMessageDialog
          key={channelId}
          channelId={channelId}
          options={state.options}
          onClose={() => setOpen(false)}
          onSent={(sent) => {
            setStatus(sentText(sent));
            setOpen(false);
            onSent?.();
          }}
        />
      ) : null}
      <output className="wx-urgent-status" tabIndex={status ? 0 : undefined}>
        {status}
      </output>
    </div>
  );
}
