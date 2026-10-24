// M36 WP 6.3 (ADR-0094 decision 1) - pure helpers for the voice-note recorder. No browser APIs are called here.
import { MAX_VOICE_NOTE_SECONDS } from "@chartwarden/types";

/** What MediaRecorder can emit that the server accepts: Opus in WebM (Chromium, Firefox), AAC in MP4 (Safari). Preference order. */
const RECORDER_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"] as const;

export function pickRecorderMimeType(support: {
  isTypeSupported(type: string): boolean;
}): string | null {
  return RECORDER_MIME_CANDIDATES.find((type) => support.isTypeSupported(type)) ?? null;
}

/** 42 -> "0:42", 300 -> "5:00". */
export function formatClock(totalSeconds: number): string {
  const whole = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export const MAX_VOICE_NOTE_CLOCK = formatClock(MAX_VOICE_NOTE_SECONDS);

/** A file name that carries no patient or staff detail: the time only. */
export function voiceNoteFileName(now: Date, mimeType: string): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return `voice-note-${stamp}.${mimeType === "audio/mp4" ? "m4a" : "webm"}`;
}

export type MicrophoneFailure = "denied" | "unavailable";

/** getUserMedia rejects with a DOMException; permission problems and "no device" read differently to the user. */
export function classifyMicrophoneError(error: unknown): MicrophoneFailure {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unavailable";
}

export const VOICE_NOTICE = {
  denied:
    "Microphone access is blocked. Allow the microphone for this site in your browser settings, then try again.",
  unavailable:
    "No microphone could be used. Check that one is connected and not in use by another app.",
  unsupported: "This browser cannot record voice notes.",
  interrupted: "Recording was interrupted, so nothing was kept. Record it again.",
  hidden: "Recording stopped because the page was hidden, so nothing was kept. Record it again.",
  empty: "Nothing was recorded.",
  tooLarge: "That recording is too large to send (8 MB at most). Record a shorter note.",
  limit: `Stopped at the ${MAX_VOICE_NOTE_CLOCK} limit. Listen to it, then attach it or discard it.`,
} as const;
