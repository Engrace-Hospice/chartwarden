// M36 WP 4.10 (ADR-0077) - the message-row "Remind me" trigger. It renders nothing unless the tenant has reminders on (the list read
// succeeded). A set reminder shows its local time and a Cancel button. The reminder notification names no message text; the dialog
// says so. The server stays the authority: an urgent message answers a typed refusal that is shown as words.
import { Button, Modal } from "@chartwarden/ui";
import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import {
  REMINDER_CANCELLED_TEXT,
  REMINDER_CANCEL_LABEL,
  REMINDER_EXPLANATION,
  REMINDER_SET_TEXT,
  REMINDER_TITLE,
  REMINDER_TRIGGER_LABEL,
  reminderErrorText,
  reminderPresets,
} from "./snooze-reminder-wording";
import { useReminderActions, useRemindersIndex } from "./use-reminders";
import "./message-annotations.css"; // .wx-pin-toggle
import "./snooze-reminder.css";

export interface MessageReminderButtonProps {
  readonly messageId: string;
  readonly authorName?: string | null;
}

const when = (iso: string): string =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));

export function MessageReminderButton({
  messageId,
  authorName,
}: MessageReminderButtonProps): JSX.Element | null {
  const { enabled, reminders } = useRemindersIndex();
  const actions = useReminderActions();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const inFlight = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  // One idempotency key per (dialog open, chosen time): a retry of the same choice replays, another choice is a new request.
  const keys = useRef(new Map<string, string>());
  // The trigger is the one stable control on the row: focus returns to it whenever the dialog closes.
  useEffect(() => {
    if (wasOpen.current && !open) triggerRef.current?.focus();
    wasOpen.current = open;
  }, [open]);
  // Presets are computed when the dialog opens, in the viewer's own clock.
  const presets = useMemo(() => (open ? reminderPresets(new Date()) : []), [open]);
  if (!enabled) return null;
  const mine = reminders.find((reminder) => reminder.message_id === messageId);
  const who = authorName || "a colleague";

  async function choose(presetId: string, at: Date): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const key = keys.current.get(presetId) ?? crypto.randomUUID();
    keys.current.set(presetId, key);
    const result = await actions.set(messageId, at, key);
    // Every HTTP response is cached under its key (errors too): only a thrown fetch (status undefined) may retry with it.
    if (result.ok || result.status !== undefined) keys.current.delete(presetId);
    inFlight.current = false;
    setBusy(false);
    if (result.ok) {
      setOpen(false);
      setStatus(REMINDER_SET_TEXT);
    } else setError(reminderErrorText(result.status, result.code));
  }

  async function cancel(): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const result = await actions.cancel(messageId);
    inFlight.current = false;
    setBusy(false);
    setStatus(result.ok ? REMINDER_CANCELLED_TEXT : reminderErrorText(result.status, result.code));
    triggerRef.current?.focus();
  }

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="wx-pin-toggle"
        aria-haspopup="dialog"
        aria-label={`${REMINDER_TRIGGER_LABEL}, message from ${who}`}
        onClick={() => {
          setError(null);
          setStatus("");
          keys.current = new Map();
          setOpen(true);
        }}
      >
        {REMINDER_TRIGGER_LABEL}
      </button>
      {mine ? (
        <span className="wx-reminder-chip">
          Reminder {when(mine.remind_at)}
          <button
            type="button"
            className="wx-pin-toggle"
            disabled={busy}
            aria-label={`${REMINDER_CANCEL_LABEL}, message from ${who}`}
            onClick={() => void cancel()}
          >
            {REMINDER_CANCEL_LABEL}
          </button>
        </span>
      ) : null}
      <output className="sr-only" aria-live="polite">
        {status}
      </output>
      {open ? (
        <Modal
          open
          onClose={busy ? undefined : () => setOpen(false)}
          ariaLabel={REMINDER_TITLE}
          width="26rem"
        >
          <div className="wx-snooze-dialog">
            <h2>{REMINDER_TITLE}</h2>
            <p>{REMINDER_EXPLANATION}</p>
            <fieldset className="wx-snooze-presets">
              <legend className="sr-only">Remind me</legend>
              {presets.map((preset) => (
                <Button
                  key={preset.id}
                  type="button"
                  tone="secondary"
                  disabled={busy}
                  onClick={() => void choose(preset.id, preset.at)}
                >
                  {preset.label}
                </Button>
              ))}
            </fieldset>
            {error ? (
              <p className="wx-snooze-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="wx-snooze-actions">
              <Button type="button" tone="secondary" disabled={busy} onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
