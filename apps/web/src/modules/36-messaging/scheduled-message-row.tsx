// M36 WP 2.6 — one row of the Scheduled list: what, where, when (in the viewer's zone), why it was not sent, and the
// two things the sender can do about it: cancel, or move it to a new time (which also retries a blocked one).
import { Button, useApiClient } from "@wardenx/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { apiErrorCode } from "./attachment-utils";
import { apiErrorMessage } from "./messaging-utils";
import type { ScheduledMessageItem } from "./scheduled-send-types";
import {
  blockedReasonText,
  formatScheduledTime,
  fromLocalInputValue,
  rescheduleSeedValue,
  scheduleBounds,
  scheduleErrorText,
  toLocalInputValue,
  validateScheduleTime,
  viewerTimeZone,
} from "./scheduled-send-utils";

const PREVIEW_LENGTH = 160;

function preview(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH)}…` : flat;
}

export function ScheduledMessageRow({
  item,
  channelLabel,
  onCancelled,
  onRescheduled,
}: {
  item: ScheduledMessageItem;
  channelLabel: string;
  onCancelled: (id: string) => void;
  onRescheduled: (item: ScheduledMessageItem) => void;
}): JSX.Element {
  const client = useApiClient();
  const [editing, setEditing] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  const timeInputRef = useRef<HTMLInputElement>(null);

  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = item.status === "blocked" && item.blockedReason !== null;
  const picked = fromLocalInputValue(value);
  const bounds = scheduleBounds(new Date());
  const timeProblem = editing ? validateScheduleTime(picked, new Date()) : null;
  const when = formatScheduledTime(item.scheduledFor);

  /** The row's controls change underneath a focused button: put focus back on a stable control in this row. */
  function focusActions(): void {
    window.requestAnimationFrame(() =>
      rowRef.current?.querySelector<HTMLElement>(".wx-scheduled-actions button")?.focus(),
    );
  }

  async function cancel(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { error: failure } = await client.DELETE("/api/v1/messaging/scheduled-messages/{id}", {
        params: { path: { id: item.id } },
      });
      if (failure) {
        setError(apiErrorMessage(failure, "It could not be cancelled. Please try again."));
        return;
      }
      onCancelled(item.id);
    } catch {
      setError("It could not be cancelled. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  // Swapping the action block unmounts the button that had focus: land on the first control of the new block.
  useEffect(() => {
    if (editing) timeInputRef.current?.focus();
  }, [editing]);
  useEffect(() => {
    if (confirmingCancel)
      rowRef.current?.querySelector<HTMLElement>("[data-confirm-first]")?.focus();
  }, [confirmingCancel]);

  async function saveTime(): Promise<void> {
    // Re-checked against the clock now: the field may have sat open past its own minimum.
    const stale = validateScheduleTime(picked, new Date());
    if (!picked || stale) {
      setError(stale);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { data, error: failure } = await client.PATCH(
        "/api/v1/messaging/scheduled-messages/{id}",
        {
          params: { path: { id: item.id } },
          body: { scheduledFor: picked.toISOString() },
        },
      );
      if (failure || !data) {
        setError(
          scheduleErrorText(apiErrorCode(failure)) ??
            apiErrorMessage(failure, "The time could not be changed. Please try again."),
        );
        return;
      }
      setEditing(false);
      onRescheduled(data);
      focusActions();
    } catch {
      setError("The time could not be changed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li ref={rowRef} className="wx-scheduled-row" data-status={item.status}>
      <div className="wx-scheduled-meta">
        <strong>{channelLabel}</strong>
        <span>
          {formatScheduledTime(item.scheduledFor)} · {viewerTimeZone()}
        </span>
      </div>
      <p className="wx-scheduled-body">{preview(item.body)}</p>
      {blocked ? (
        <output className="wx-scheduled-blocked">{blockedReasonText(item.blockedReason)}</output>
      ) : null}
      {editing ? (
        <div className="wx-scheduled-edit">
          <label>
            <span>New time</span>
            <input
              ref={timeInputRef}
              type="datetime-local"
              value={value}
              aria-invalid={timeProblem ? true : undefined}
              aria-describedby={timeProblem ? `${item.id}-time-problem` : undefined}
              min={toLocalInputValue(bounds.min)}
              max={toLocalInputValue(bounds.max)}
              disabled={busy}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          <Button
            size="sm"
            disabled={Boolean(timeProblem) || busy}
            loading={busy}
            onClick={() => void saveTime()}
          >
            Save time
          </Button>
          <Button
            size="sm"
            tone="secondary"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              focusActions();
            }}
          >
            Keep current time
          </Button>
          {timeProblem ? (
            <span id={`${item.id}-time-problem`} role="alert" className="wx-messaging-error">
              {timeProblem}
            </span>
          ) : null}
        </div>
      ) : confirmingCancel ? (
        <div className="wx-scheduled-actions">
          <span>Cancel this scheduled message?</span>
          <Button
            data-confirm-first
            size="sm"
            disabled={busy}
            loading={busy}
            onClick={() => void cancel()}
          >
            Yes, cancel it
          </Button>
          <Button
            size="sm"
            tone="secondary"
            disabled={busy}
            onClick={() => {
              setConfirmingCancel(false);
              focusActions();
            }}
          >
            Keep it
          </Button>
        </div>
      ) : (
        <div className="wx-scheduled-actions">
          <Button
            size="sm"
            tone="secondary"
            disabled={busy}
            aria-label={`${blocked ? "Reschedule to retry" : "Reschedule"} message in ${channelLabel} for ${when}`}
            onClick={() => {
              setValue(rescheduleSeedValue(item.scheduledFor, new Date()));
              setEditing(true);
            }}
          >
            {blocked ? "Reschedule to retry" : "Reschedule"}
          </Button>
          <Button
            size="sm"
            tone="secondary"
            disabled={busy}
            aria-label={`Cancel scheduled message in ${channelLabel} for ${when}`}
            onClick={() => setConfirmingCancel(true)}
          >
            Cancel
          </Button>
        </div>
      )}
      {error && error !== timeProblem ? (
        <div role="alert" className="wx-messaging-error">
          {error}
        </div>
      ) : null}
    </li>
  );
}
