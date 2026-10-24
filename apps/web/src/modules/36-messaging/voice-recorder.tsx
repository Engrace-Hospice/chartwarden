// M36 WP 6.3 (ADR-0094 decision 1) - the composer's voice-note control: Record / Pause / Stop / Listen / Discard / Attach. A voice note is an
// ordinary attachment (same scan, retention and audit); there is NO dictation here and no speech recognition of any kind. Offered only when
// the tenant flag `messaging.voice_notes` is on and the browser can record. The timer is text, not announced every second.
import { MAX_VOICE_NOTE_SECONDS, VOICE_NOTES_FLAG_KEY } from "@chartwarden/types";
import { Glyph, useFeatureFlag } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { AttachmentUploads } from "./use-attachment-upload";
import { type RecorderPhase, canRecordVoice, useVoiceRecorder } from "./use-voice-recorder";
import { MAX_VOICE_NOTE_CLOCK, formatClock } from "./voice-note-utils";
import "./camera-capture.css";
import "./voice-note.css";

function useVoiceNotesFlag(): boolean {
  try {
    return useFeatureFlag(VOICE_NOTES_FLAG_KEY);
  } catch {
    return false; // no provider mounted: fail closed
  }
}

const STATUS_TEXT: Readonly<Record<RecorderPhase, string>> = {
  idle: "",
  starting: "Waiting for microphone permission",
  recording: "Recording started",
  paused: "Recording paused",
  review: "Recording stopped. Listen to it, then attach it or discard it.",
};

interface PanelProps {
  uploads: Pick<AttachmentUploads, "addFiles">;
  disabled: boolean;
  onClose: () => void;
}

function VoiceRecorderPanel({ uploads, disabled, onClose }: PanelProps): JSX.Element {
  const recorder = useVoiceRecorder();
  const { phase, elapsedSeconds, notice, review } = recorder;
  const panelRef = useRef<HTMLElement>(null);

  // Focus follows the state change, so it never falls to <body> when a control unmounts: the panel on open, on recording and on review.
  // Pause and Resume share one button, so they keep focus themselves.
  const focusPhase = phase === "paused" || phase === "starting" ? null : phase;
  useEffect(() => {
    if (focusPhase !== null) panelRef.current?.focus();
  }, [focusPhase]);

  function cancel(): void {
    recorder.discard();
    onClose();
  }

  function attach(): void {
    const file = recorder.take();
    if (file) uploads.addFiles([file]);
    onClose();
  }

  const timerText = `${phase === "paused" ? "Paused" : "Recording"}, ${formatClock(elapsedSeconds)} of ${MAX_VOICE_NOTE_CLOCK}`;
  return (
    <section ref={panelRef} tabIndex={-1} className="wx-voice-panel" aria-label="Voice note">
      <div aria-live="assertive" aria-atomic="true" className="wx-voice-notice">
        {notice}
      </div>
      <output className="sr-only">{STATUS_TEXT[phase]}</output>
      {phase === "idle" || phase === "starting" ? (
        <>
          <p className="wx-voice-help">
            Record up to {MAX_VOICE_NOTE_CLOCK}. The microphone is used only while you record. Add a
            typed message too, so everyone can read what it is about.
          </p>
          <div className="wx-camera-actions">
            <button
              type="button"
              className="wx-camera-action is-primary"
              disabled={disabled || phase === "starting"}
              onClick={() => void recorder.start()}
            >
              Record
            </button>
            <button type="button" className="wx-camera-action" onClick={cancel}>
              Cancel
            </button>
          </div>
        </>
      ) : null}
      {phase === "recording" || phase === "paused" ? (
        <>
          <span role="timer" className="wx-voice-timer" data-limit-seconds={MAX_VOICE_NOTE_SECONDS}>
            {timerText}
          </span>
          <div className="wx-camera-actions">
            {phase === "recording" ? (
              <button type="button" className="wx-camera-action" onClick={recorder.pause}>
                Pause
              </button>
            ) : (
              <button type="button" className="wx-camera-action" onClick={recorder.resume}>
                Resume
              </button>
            )}
            <button type="button" className="wx-camera-action is-primary" onClick={recorder.stop}>
              Stop
            </button>
            <button type="button" className="wx-camera-action" onClick={cancel}>
              Discard
            </button>
          </div>
        </>
      ) : null}
      {phase === "review" && review ? (
        <>
          {/* biome-ignore lint/a11y/useMediaCaption: the recording is the user's own voice note; the typed message is its text alternative */}
          <audio controls src={review.url} aria-label="Listen to your recording" />
          <div className="wx-camera-actions">
            <button type="button" className="wx-camera-action" onClick={cancel}>
              Discard
            </button>
            <button
              type="button"
              className="wx-camera-action is-primary"
              disabled={disabled}
              onClick={attach}
            >
              Attach voice note
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

interface VoiceRecorderButtonProps {
  uploads: Pick<AttachmentUploads, "addFiles">;
  disabled: boolean;
}

export function VoiceRecorderButton({
  uploads,
  disabled,
}: VoiceRecorderButtonProps): JSX.Element | null {
  const flagOn = useVoiceNotesFlag();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [supported] = useState(canRecordVoice);
  if (!flagOn || !supported) return null;

  function close(): void {
    setOpen(false);
    buttonRef.current?.focus();
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="wx-attach-button"
        aria-label="Record voice note"
        aria-expanded={open}
        disabled={disabled}
        // Opening only: closing goes through Cancel / Discard, so a click can never throw a recording away.
        onClick={() => setOpen(true)}
      >
        <Glyph name="mic" size={18} />
      </button>
      {open ? <VoiceRecorderPanel uploads={uploads} disabled={disabled} onClose={close} /> : null}
    </>
  );
}
