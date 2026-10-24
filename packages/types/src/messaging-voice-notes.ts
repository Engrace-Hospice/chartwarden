// M36 WP 6.3 (ADR-0094 decision 1) - voice notes are ordinary scanned attachments. This file holds the shared constants; the
// server enforces the byte cap and the type allowlist, the browser recorder enforces the duration cap as a convenience only.
// Dictation (ADR-0094 decision 2) is NOT built: nothing here records, sends or transcribes speech to a third party.

/** Per-tenant flag (FeatureFlagReaderPort: tenant row wins, absent = off). Off => authorize refuses audio and the recorder is not offered. */
export const VOICE_NOTES_FLAG_KEY = "messaging.voice_notes" as const;

/** Opus in WebM (Chromium, Firefox) and AAC in MP4 (Safari): what MediaRecorder emits. No other audio is accepted. */
export const VOICE_NOTE_MIME_TYPES = ["audio/webm", "audio/mp4"] as const;
export type VoiceNoteMimeType = (typeof VOICE_NOTE_MIME_TYPES)[number];

/** 8 MB: Opus at the default browser bitrate is about 1 MB a minute, so this covers the 5 minute cap with margin (not measured on devices). */
export const MAX_VOICE_NOTE_BYTES = 8_000_000;
/** The recorder stops itself here. The server does not parse container duration, so the byte cap is the control. */
export const MAX_VOICE_NOTE_SECONDS = 300;

export const isVoiceNoteMimeType = (value: string): value is VoiceNoteMimeType =>
  (VOICE_NOTE_MIME_TYPES as readonly string[]).includes(value);
