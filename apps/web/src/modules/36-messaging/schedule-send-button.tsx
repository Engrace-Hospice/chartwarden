// M36 WP 2.6 — the composer's "Schedule send" control: a button beside Send that opens the dialog, and a polite status
// line after a message was scheduled. The composer owns clearing its own draft (`onScheduled`).
import { Button } from "@wardenx/ui";
import { useState } from "react";
import type { JSX } from "react";
import { ScheduleSendDialog } from "./schedule-send-dialog";
import { formatScheduledTime } from "./scheduled-send-utils";
import "./scheduled-send.css";

export function ScheduleSendButton({
  channelId,
  text,
  disabled = false,
  disabledReason,
  onScheduled,
}: {
  channelId: string;
  text: string;
  disabled?: boolean;
  /** Why scheduling is unavailable right now (shown as the button's title). */
  disabledReason?: string;
  onScheduled: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const unavailable = disabled || !text.trim() || Boolean(disabledReason);

  return (
    <div className="wx-schedule-send">
      <Button
        type="button"
        tone="secondary"
        size="sm"
        disabled={unavailable}
        title={disabledReason}
        aria-label="Schedule send"
        onClick={() => {
          setConfirmation(null);
          setOpen(true);
        }}
      >
        Schedule
      </Button>
      {/* Mounted only while open so each opening starts from a fresh suggested time and a fresh idempotency key. */}
      {open ? (
        <ScheduleSendDialog
          open
          channelId={channelId}
          text={text}
          onClose={() => setOpen(false)}
          onScheduled={(scheduledFor) => {
            setOpen(false);
            setConfirmation(`Message scheduled for ${formatScheduledTime(scheduledFor)}.`);
            onScheduled();
          }}
        />
      ) : null}
      <output className="wx-schedule-status">{confirmation}</output>
    </div>
  );
}
