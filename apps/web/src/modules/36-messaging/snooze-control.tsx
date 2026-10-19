// M36 WP 4.10 (ADR-0077) - the conversation header's snooze control. It pauses the push / text / email copies of the NON-URGENT notices of
// this conversation (1 to 24 hours); it never hides anything here. Where the server says the conversation cannot be snoozed (the viewer
// is the sender or assignee of an open acknowledgment request) no button is offered: a short note and a full sentence say why. Nothing
// renders while loading, when the tenant has the feature off, or when the first read failed. Results and refusals are announced in a
// persistent polite live region; a refusal closes the dialog, keeps the error on screen and puts focus on a real element.
import { Button, Glyph, Modal } from "@wardenx/ui";
import { type JSX, useEffect, useRef, useState } from "react";
import {
  SNOOZE_ENDED_TEXT,
  SNOOZE_END_LABEL,
  SNOOZE_EXPLANATION,
  SNOOZE_PRESETS,
  SNOOZE_STARTED_TEXT,
  SNOOZE_TITLE,
  SNOOZE_TRIGGER_LABEL,
  SNOOZE_UNSNOOZABLE_SHORT,
  SNOOZE_UNSNOOZABLE_TEXT,
  snoozeErrorText,
} from "./snooze-reminder-wording";
import { useChannelSnooze } from "./use-channel-snooze";
import "./snooze-reminder.css";

const localTime = (iso: string): string =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));

export function SnoozeControl({ channelId }: { readonly channelId: string }): JSX.Element | null {
  const { view, reload, snooze, clear } = useChannelSnooze(channelId);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const inFlight = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLSpanElement>(null);
  // One idempotency key per (dialog open, chosen length): a retry of the same choice replays, another choice is a new request.
  const keys = useRef(new Map<number, string>());
  // The trigger changes element when the snooze starts or ends (or turns into the note), so focus is handed back after the render.
  const refocus = useRef(false);
  useEffect(() => {
    if (refocus.current && !open) {
      refocus.current = false;
      (triggerRef.current ?? noteRef.current)?.focus();
    }
  });

  // When a refusal re-read flips the conversation to "cannot snooze", the trigger is replaced by the note: focus lands on the note, not body.
  const snoozable = view.status === "ready" ? view.snooze.snoozable : null;
  const prevSnoozable = useRef<boolean | null>(null);
  useEffect(() => {
    const was = prevSnoozable.current;
    prevSnoozable.current = snoozable;
    const active = document.activeElement;
    if (was === true && snoozable === false && (!active || active === document.body)) {
      noteRef.current?.focus();
    }
  }, [snoozable]);

  // Loading, off and a failed first read render nothing: the control is a convenience, so it fails closed and silent (the server decides).
  if (view.status !== "ready") return null;

  const live = (
    <output className="sr-only" aria-live="polite">
      {announce}
    </output>
  );
  const { snooze: state } = view;
  const unsnoozable = !state.snoozable;

  // Compared with the clock at render: a snooze that has run out reads as not snoozed (no timer, no polling).
  const until = state.snoozed_until;
  const active = until !== null && new Date(until).getTime() > Date.now();

  async function run(
    action: () => Promise<{ ok: boolean; status?: number; code?: string }>,
    done: string,
  ) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const result = await action();
    inFlight.current = false;
    setBusy(false);
    refocus.current = true;
    setOpen(false);
    if (result.ok) {
      setAnnounce(done);
      return;
    }
    const text = snoozeErrorText(result.status, result.code);
    setError(text);
    setAnnounce(text);
    // A typed refusal says the conversation changed (an urgent item arrived): read the truth again, keeping this view on screen meanwhile.
    if (result.code) reload();
  }

  const keyFor = (minutes: number): string => {
    const existing = keys.current.get(minutes);
    if (existing) return existing;
    const created = crypto.randomUUID();
    keys.current.set(minutes, created);
    return created;
  };

  return (
    <span className="wx-snooze">
      {/* One stable tree: main control, error text, live region, dialog - the live region keeps its position across the branches. */}
      {unsnoozable ? (
        <span ref={noteRef} tabIndex={-1} className="wx-snooze-note">
          <Glyph name="lock" size={14} /> {SNOOZE_UNSNOOZABLE_SHORT}
          <span className="sr-only">. {SNOOZE_UNSNOOZABLE_TEXT}</span>
        </span>
      ) : active ? (
        <>
          <span className="wx-snooze-note">
            <Glyph name="bell" size={14} /> Snoozed until {localTime(until)}
          </span>
          <button
            type="button"
            ref={triggerRef}
            className="wx-messaging-context-toggle"
            disabled={busy}
            onClick={() => void run(clear, SNOOZE_ENDED_TEXT)}
          >
            {SNOOZE_END_LABEL}
          </button>
        </>
      ) : (
        <button
          type="button"
          ref={triggerRef}
          className="wx-messaging-context-toggle"
          aria-haspopup="dialog"
          onClick={() => {
            setError(null);
            setAnnounce("");
            keys.current = new Map();
            setOpen(true);
          }}
        >
          <Glyph name="bell" size={16} />
          <span className="wx-messaging-context-label">{SNOOZE_TRIGGER_LABEL}</span>
        </button>
      )}
      {error ? <span className="wx-snooze-error">{error}</span> : null}
      {live}
      {open ? (
        <Modal
          open
          onClose={busy ? undefined : () => setOpen(false)}
          ariaLabel={SNOOZE_TITLE}
          width="26rem"
        >
          <div className="wx-snooze-dialog">
            <h2>{SNOOZE_TITLE}</h2>
            <p>{SNOOZE_EXPLANATION}</p>
            <fieldset className="wx-snooze-presets">
              <legend className="sr-only">Snooze for</legend>
              {SNOOZE_PRESETS.map((preset) => (
                <Button
                  key={preset.minutes}
                  type="button"
                  tone="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => snooze(preset.minutes, keyFor(preset.minutes)),
                      SNOOZE_STARTED_TEXT,
                    )
                  }
                >
                  {preset.label}
                </Button>
              ))}
            </fieldset>
            <div className="wx-snooze-actions">
              <Button type="button" tone="secondary" disabled={busy} onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </span>
  );
}
