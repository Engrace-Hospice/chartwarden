# ADR-0094 — Messaging voice notes and dictation: audio is a scanned attachment; dictation is off until a BAA-covered server-side path exists

- **Status:** **Proposed** (2026-10-23). Decision 1 (voice notes as scanned attachments) is built behind the new per-tenant flag `messaging.voice_notes`, default off; no migration, no table. Decision 2 (dictation) is NOT built: option A is rejected and guarded by a test, and option B has no M32 speech backend to build on. The privacy officer, clinical-lead, AI-safety and BAA decisions below are NOT recorded; they are required before any tenant turns the flag on.
- **Date:** 2026-10-23
- **Phase:** Messaging Hub Phase 6, WP 6.3.
- **Related:** [ADR-0086](ADR-0086-messaging-retention-and-legal-hold.md) (retention, hold overlay, attachment-object destruction, redaction), [ADR-0093](ADR-0093-messaging-multilingual-ui-and-templates.md) (ADR style), [ADR-0074](ADR-0074-messaging-lock-screen-privacy.md) (no preview in push), `docs/messaging-hub/04-phases-4-to-6.md` row 6.3, `docs/messaging-hub/10-ui-spec-phases-4-to-6.md` section 6.3, `docs/architecture/CHARTWARDEN_AI_GOVERNANCE_v0.2.md` section 9, `docs/modules/CHARTWARDEN_MODULE_32_AI_PLATFORM_SPEC_v0_2.md`.

## Context

WP 6.3 asks for (a) recording a voice note as an attachment under the same scan, retention and audit rules, and (b) dictation, with the PHI boundary decided in an ADR. Facts read from the repo:

- Chat attachments live in `apps/backend/src/modules/36-messaging/attachments/`. `attachment-policy.ts` sets a 25,000,000 byte ceiling, 10 per message, and `ATTACHMENT_MIME_ALLOWLIST` of pdf, jpeg, png, tiff, docx and text/plain. No audio type is on it. `attachment-scanners.ts` (`createBuiltinScanner`) is a signature check only (declared type vs magic bytes), explicitly "NOT an antivirus engine"; `matchesDeclaredType` has no audio case and its `default` branch tests for a zip header, so an audio type added to the allowlist without a case would be rejected as a mismatch (safe, but it must be handled deliberately).
- Delivery is blocked until `scan_state` is `clean`; a scanner outage leaves a row `pending`, never `clean` and never quarantined (attachment policy constants).
- ADR-0086: message retention classes are care_related 7 y, bereavement 7 y, operational 1 y, from `message.created_at`; destruction is off per tenant; attachment objects are destroyed only when a third flag (`messaging.retention_attachment_destruction`) is on, and a held message's objects are skipped; a redaction masks but retains the object and refuses access.
- Module 32 spec (v0.2): backends are `anthropic-*` (cloud) and `local-*` (Ollama-served LLMs). A grep of the spec for speech, transcription, audio and whisper finds no speech-to-text capability or backend. The `local` LLM backend is itself gated behind a Stage-3 eval (M32-F02). Governance section 9.1: no PHI to any AI vendor without a signed BAA, a security review, documented data-handling terms and tenant authorization; the Anthropic BAA is recorded as "in progress" in that document (current status is unverified here).
- Browser `SpeechRecognition` / `webkitSpeechRecognition` is the Web Speech API. In Chrome the audio is by default streamed to Google's servers; Safari routes to Apple's service. Whether either would sign a BAA with ChartWarden is, to my knowledge, no; this is unverified and must be confirmed with each vendor. Some Chromium builds support on-device recognition, but availability varies by browser, OS and language and cannot be assumed or reliably detected for a clinical control.

Spoken content in hospice care is PHI by default (names, symptoms, medications, family distress). A voice file is also a voiceprint, which makes it more identifying than the same words typed.

## Decision

### 1. Voice notes are attachments, through the existing pipeline

1. A voice note is an ordinary message attachment: authorize, presigned PUT, complete, scan, bind to a message, delivery only when `clean`. No parallel storage path, no new table. Audit, hold overlay, redaction and retention behave as ADR-0086 already specifies for attachments, because it is the same row.
2. **Format:** `audio/webm` (Opus), as produced by `MediaRecorder` in Chromium and Firefox, and `audio/mp4` (AAC) for Safari. Both are added to `ATTACHMENT_MIME_ALLOWLIST`; no other audio (wav, mp3, ogg, amr) is accepted. Rationale: those are what the browsers emit; a transcoding service would be new attack surface and a new PHI processor. `matchesDeclaredType` gets explicit cases (EBML header `1A 45 DF A3` for webm; an `ftyp` box at offset 4 for mp4). The built-in scanner stays a signature check. If the production scanner is a real antivirus, audio goes through it unchanged. (Open item: which scanner production uses.)
3. **Limits:** 5 minutes and 8 MB per note (Opus at the default browser bitrate is roughly 1 MB/min, so 8 MB covers 5 minutes with margin; this arithmetic is not measured on real devices). The recorder stops itself at the limit and shows it. Server enforcement is the byte cap; the client duration cap is a convenience, not a control (the server does not parse container duration). A voice note counts against `MAX_ATTACHMENTS_PER_MESSAGE` (10). The global 25,000,000 byte ceiling is unchanged; the audio cap is an additional per-type check.
4. **Storage class:** the same message-attachment bucket and key scheme (opaque key with no patient identifier, presigned GET 120 s, access re-authorized on every open). No separate bucket. Nothing here changes that bucket.
5. **Push and lock screen:** a voice note produces the same generic push as any attachment-bearing message (ADR-0074): no duration, no transcript, no "voice message from X".

### 2. Dictation: disallowed in the browser; server-side only, later, behind a BAA

| Option | PHI boundary | Verdict |
|---|---|---|
| A. Browser `SpeechRecognition` | Audio goes to Google or Apple. No BAA we hold. Not auditable by us. A HIPAA disclosure per Governance section 9 | **Rejected.** Not offered, not even behind a flag. |
| B. M32 server-side transcription in a BAA-covered environment | Audio goes only to ChartWarden's backend and a processor we have a BAA with (or a local model we run). Auditable through the `ai.*` events | **Recommended future path**, but **not available today**: M32 has no speech capability or backend, and its local backend is eval-gated |
| C. Typing and voice notes only | None | **The default until B is signed off and built** |

Decision: C now, B as the only future path, A rejected outright.

1. The UI never calls `SpeechRecognition`. The implementation WP adds a fitness or lint check forbidding `SpeechRecognition` and `webkitSpeechRecognition` in `apps/web` and `apps/admin`, so option A cannot be reintroduced silently. OS-level keyboard dictation (iOS, Android, macOS) is outside our control and the UI cannot block it; that is stated honestly, not hidden.
2. Server-side dictation (B) is a new M32 capability (working name `messaging_dictation`) registered through the normal capability lifecycle (stage gates, calibration, kill switch). It is off per tenant by a flag (`messaging.dictation`, absent = off) that is turned on only after the tenant's BAA is confirmed to cover the transcription processor (the Governance tenant-authorization row). This ADR selects no vendor or model.
3. Backend choice (cloud vs local) is the privacy officer's. A cloud backend needs a signed BAA, zero data retention, no training on audio and a sub-processor list. A local backend needs a Stage-3 eval on spoken clinical vocabulary; a mis-transcribed drug name or dose is a patient-safety risk.
4. Audio sent for transcription is not kept by the dictation path: transcribed, then discarded. Only an `ai.*` audit row is written (capability, backend, duration in seconds, byte count, outcome; never the text, never the audio).

### 3. Transcripts are drafts the user must send; never auto-sent, never stored before send

1. The transcript is returned to the browser and placed in the composer as ordinary editable text. Nothing is sent by voice alone; the existing send action is the only way a message is created.
2. Before send, the transcript is not persisted on the server: no draft table, no cache, no log line with the text, no copy in the audit row. A closed tab loses it.
3. The composer marks transcript-derived text "Dictated, check before sending" until the user edits or sends. On send it is a normal message body under normal retention and redaction. No "came from dictation" column is added.
4. A transcript is never silently attached to a voice note. Automatic transcripts of already-sent notes (for readers) are a different feature, not decided here (see Not done).

### 4. Retention, redaction, who can play

1. **Audio:** same retention class and clock as the carrying message (ADR-0086), since it is the same attachment row. A legal hold on the message holds the audio. With the attachment-destruction flag off (the default), audio is never destroyed. Whether audio deserves a shorter class than 7 years (it is more identifying than text) is NOT decided; it would need an ADR-0086 amendment and a migration.
2. **Transcript:** if sent, it is the message body (cipher, same rules). No separate transcript store exists.
3. **Redaction:** ADR-0086 redaction masks the body and retains the object but refuses access to it. For voice that means a redacted note must not be playable by any role. This is a requirement for a live test in the implementation WP, not a fact I have verified for audio.
4. **Who can play:** exactly who can open the message and its attachments today, through the same per-open authorization and 120 s presigned GET. No admin "listen in" role. Every open is an attachment-access audit event as for any attachment. Whether the ADR-0089 export includes attachments (and so audio) is to be verified when built.
5. No server-side processing of stored audio in this WP: no waveform, diarization, voiceprint or transcription of sent notes. The browser plays the file in a native `<audio controls>` element.

### 5. Accessibility and platform constraints

1. An untranscribed voice note is not accessible to deaf or hard-of-hearing recipients or in noisy settings (WCAG 1.2.1, audio-only alternative). Therefore a message that carries a voice note must also carry a non-empty text body, typed by the sender (or dictated and edited once 2B exists). This is a deliberate UX default and needs clinical-lead agreement.
2. Recording controls are keyboard operable; recording state is also text ("Recording, 0:42 of 5:00"), timer not announced each second; microphone-denied and too-long states are text (per `10-ui-spec` 6.3).
3. The player is the native `<audio controls>`; no custom player.
4. **Mobile web:** `MediaRecorder` and `getUserMedia` need a secure context and a user gesture; iOS Safari supports `audio/mp4` (the reason it is in the allowlist). Backgrounding the tab during recording may stop capture on iOS, so an interrupted recording must be treated as discarded, never as success. This is from general platform knowledge and is **unverified on the devices ChartWarden supports**; a device test is required.
5. **Native app:** out of scope and waits. A native client has its own microphone permission, background recording and OS speech frameworks with their own vendor terms. A native decision must extend or supersede this ADR.
6. Microphone permission is requested only when the user starts a recording. Any `Permissions-Policy` must allow `microphone=(self)` only; the current header configuration was not checked.

## Implementation status (WP 6.3, built 2026-10-23)

Decision 1 only. Built:

- **Flag:** `messaging.voice_notes` (`VOICE_NOTES_FLAG_KEY`, `packages/types/src/messaging-voice-notes.ts`), read through the platform feature-flag reader (tenant row wins; absent = off; a read that throws = off), cached a few seconds per org. It gates (a) the server: `authorize` answers the same 415 as for any disallowed type for `audio/webm` and `audio/mp4` while it is off, and (b) the web: the recorder button and the inline player are offered only while it is on. It does not gate access to a note that already exists: with the flag off a stored note is an ordinary file row (the "Open in a new tab" path), still scan-gated, redaction-masked and held exactly as before.
- **Server:** both audio types are on `ATTACHMENT_MIME_ALLOWLIST`; `validateAuthorizeInput` takes the flag and applies an 8,000,000 byte cap to them (422), leaving the 25,000,000 byte ceiling for everything else; `matchesDeclaredType` has explicit cases (EBML `1A 45 DF A3` for webm, `ftyp` at offset 4 for mp4), so audio never falls into the zip default. The built-in scanner is still only a signature check; which scanner production runs is still an open question (Operations, below). The duration cap is not enforced server-side (the server does not parse container duration).
- **No new table, no migration, no new route.** Authorize, complete, scan, bind-on-send, the 120 s presigned GET with a re-authorization and an `attachment_access_event` on every open, the hold overlay, retention and redaction are the existing attachment code paths. Live tests prove, for audio: flag off or unreadable gives 415 and no row; over 8 MB gives 422 and other audio types 415; a clean note is delivered to the recipient and opens once with one access event; a webm-declared file with other bytes is quarantined and cannot be sent; a note stays openable after the flag is turned off; an approved redaction makes it unplayable for everyone (404, a `message_redacted` denial logged); a held note's audio object is not destroyed.
- **Push:** unchanged. A voice note is an attachment-bearing message and takes the generic ADR-0074 push (no duration, no transcript, no "voice message from X").
- **Web:** a microphone button in the composer opens a flat panel: Record, Pause/Resume, Stop, Listen (native `<audio controls>`), Discard, Attach. The microphone is requested only when Record is pressed. The timer is text ("Recording, 0:42 of 5:00", `role="timer"`, not announced each second; state changes are announced). The recorder stops itself at 5:00 and says so; a recording over 8 MB, an empty one, a denied or missing microphone, a recorder error, a microphone that ends mid-recording and a page that is hidden mid-recording all end in a text message and nothing kept. The file is `audio/webm` (Opus) or, where only that is supported, `audio/mp4`, named by time only, and goes through the normal upload chip. Playback: a "Play" button fetches the presigned URL on demand and hands it to a native `<audio controls>`; if the link expires the player is dropped and Play is offered again.
- **Typed body required (5.1):** with a voice note attached, Send stays disabled and the composer says why until the message has typed text. This is enforced in the web composers and in the sender hook; the server does not enforce it (an API client can still send a note with no body). Moving it server-side, and the question of whether field nurses accept it, are open (Clinical lead, below).
- **Dictation (decision 2) is not built.** There is no speech code, no `SpeechRecognition` or `webkitSpeechRecognition` reference, and no flag for it. A test (`apps/web/src/modules/36-messaging/no-browser-speech.test.ts`) fails if either name appears in `apps/web/src` or `apps/admin/src`, so option A cannot return silently. Decision 3 (transcripts as unsent drafts) therefore has nothing to apply to yet.

Not verified: real-device behaviour on iOS Safari and Android Chrome (recording, backgrounding, `audio/mp4` playback), the `Permissions-Policy` header and the CSP `media-src` for presigned URLs in a deployed environment. The recorder and player are exercised only against a faked `MediaRecorder` in jsdom.

## Not done (follow-ups, in order)

1. Human sign-off on the open questions below. No tenant should turn `messaging.voice_notes` on before the privacy officer's voiceprint/retention answer, the clinical lead's typed-body answer and the Operations scanner answer are recorded.
2. Section 2B (server-side dictation) only after the privacy officer chooses a backend and the M32 capability, BAA and eval exist. Nothing for it is built.
3. Server-side enforcement of the typed-body rule, if the clinical lead confirms it.
4. A device test on iOS Safari and Android Chrome, and a check of `Permissions-Policy` (`microphone=(self)`) and CSP `media-src`.
5. Transcripts of already-sent notes for readers: would be server-side processing of stored audio; needs its own ADR and the same BAA.

## Open questions requiring human sign-off

1. **Privacy officer:** is a voice recording acceptable as PHI in chat at all, given it is a voiceprint? Should audio have a retention class shorter than 7 years?
2. **Privacy officer and counsel (BAA):** which processor, if any, may transcribe speech? Is a BAA obtainable with zero retention and no training on audio? Is the Anthropic BAA (recorded "in progress" in Governance 9.2) now signed, and does it cover audio, or is a separate speech vendor needed?
3. **AI Safety Owner:** is a local speech model acceptable, and what Stage-3 accuracy bar applies to spoken drug names and doses?
4. **Clinical lead:** is "a voice note requires a typed body" acceptable to field nurses? Is 5 minutes right?
5. **Operations:** which scanner runs in production (the built-in one never inspects audio for malware)? May the attachment-destruction flag be turned on, since without it audio is never destroyed?
6. **Security:** confirm `Permissions-Policy` and CSP `media-src` for presigned URLs; confirm real-device behaviour on iOS Safari and Android Chrome.
7. **Vendor facts to verify, not assumed:** that Chrome and Safari speech recognition cannot be covered by a BAA, and that no supported browser offers a dependable on-device mode.
