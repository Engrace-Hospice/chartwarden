// M36 WP 3.10 - the composer's "Ask a nurse about a medication" action, beside Poll. It renders nothing unless the
// options route says the entry is on AND the conversation is a patient's care-team conversation (any 401/403/404 or
// failure reads as hidden); the server stays the authority. The outcome stays on screen in a focusable status.
import { Button } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import {
  MedicationQuestionDialog,
  type MedicationQuestionSent,
} from "./medication-question-dialog";
import {
  ASK_BUTTON_LABEL,
  SENT_REPLAY_TEXT,
  SENT_ROUTED_TEXT,
  SENT_UNROUTED_TEXT,
} from "./medication-question-wording";
import type { ChannelKind } from "./messaging-types";
import { useMedicationQuestionOptions } from "./use-medication-question-options";
import "./medication-question.css";

const sentText = (sent: MedicationQuestionSent): string =>
  !sent.created ? SENT_REPLAY_TEXT : sent.routed ? SENT_ROUTED_TEXT : SENT_UNROUTED_TEXT;

export function MedicationQuestionButton({
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
  const state = useMedicationQuestionOptions(channelId, kind !== "care_team");
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  // The trigger (Button does not forward a ref, so it is found in its wrapper) is the one stable control: focus returns to it whenever the dialog closes.
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
  return (
    <div className="wx-medq" ref={rootRef}>
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
        {ASK_BUTTON_LABEL}
      </Button>
      {open ? (
        <MedicationQuestionDialog
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
      <output className="wx-medq-status" tabIndex={status ? 0 : undefined}>
        {status}
      </output>
    </div>
  );
}
