// WP 2.10: the composer's "Poll" action. In a patient-linked conversation it stays in the tab order (aria-disabled, not
// disabled) so a keyboard or screen reader user reaches the explanation instead of skipping a dead control.
import { Button } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import type { ChannelKind } from "./messaging-types";
import { PollCreateDialog } from "./poll-create-dialog";
import { POLL_BLOCKED_EXPLANATION, pollAllowedIn } from "./poll-utils";
import "./polls.css";

export function PollCreateButton({
  channelId,
  kind,
  disabled = false,
  onCreated,
}: {
  channelId: string;
  kind: ChannelKind;
  disabled?: boolean;
  onCreated: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const allowed = pollAllowedIn(kind);
  return (
    <div className="wx-poll-create">
      <Button
        type="button"
        tone="secondary"
        size="lg"
        disabled={disabled}
        aria-disabled={allowed ? undefined : true}
        aria-describedby={allowed ? undefined : "wx-poll-blocked"}
        title={allowed ? undefined : POLL_BLOCKED_EXPLANATION}
        onClick={() => {
          if (!allowed) return;
          setConfirmation("");
          setOpen(true);
        }}
      >
        Poll
      </Button>
      {allowed ? null : (
        <span id="wx-poll-blocked" className="sr-only">
          {POLL_BLOCKED_EXPLANATION}
        </span>
      )}
      {open ? (
        <PollCreateDialog
          channelId={channelId}
          onClose={() => setOpen(false)}
          onCreated={() => {
            setOpen(false);
            setConfirmation("Poll posted.");
            onCreated();
          }}
        />
      ) : null}
      <output className="wx-poll-create-status">{confirmation}</output>
    </div>
  );
}
