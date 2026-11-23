# Capability - DocLens Vision Verification

## Purpose
Verifies high-risk extracted fields against document images.

## Risk Classification
High. Verification output can influence chart-entry acceptance and may process PHI-bearing images.

## Architecture
Architecture section 10.6; Module 22 Documents.

## Lifecycle
State: PROPOSED. Disabled by default and deny-stubbed until M22 and M32 governance wiring land.

## Controls
Kill switch: activate an `ai_kill_switch_state` row for capability_key `doclens_vision_verify` — platform-wide (`organization_id IS NULL`) or for one tenant. The platform row and a tenant row OR together: neither overrides the other, so lifting one does not resume a capability the other still stops. Human-in-the-loop approval, source-view confirmation, model/provider approval, BAA/ZDR gate, audit events, and deterministic/manual fallback are required before activation.

## Comparison rules
The model re-reads a crop of the page without seeing the extracted value; the pipeline then compares the reading with the value (`visionReadingAgrees`, `apps/backend/src/modules/22-documents/extraction/intake-job.ts`). A disagreement is shown to the reviewer as "Not found on page" with the closest reading. Anything doubtful is a disagreement: it sends the reviewer to the page and never accepts a finding the page does not state.

- **Lists.** The field path is sent without its index (`diagnoses[].description`): the index counts entries across the whole document, so with it the model returned the n-th entry of the crop instead of every entry, and entries sharing one paragraph were checked against the wrong neighbour.
- **Entries and identity values** (medications, allergies, names, dates of birth): letters and digits only, case-insensitive; one may contain the other only when they are of comparable length (at least 60%). "Penicillin" never agrees with "Penicillin - anaphylaxis".
- **Diagnosis descriptions** are prose: the crop is the whole paragraph, so the reading is a sentence. The value agrees when one sentence of a reading holds all of its words in order as a whole phrase: the words either side are a phrase break (comma, colon, semicolon, bracket), a plain severity or stage modifier (severe, chronic, end-stage...) or a connector (with, on, due to, is, diagnosed...). "Diabetes" never agrees with "Diabetes insipidus", nor "Cancer" with "Breast cancer". Any negating, ruled-out, uncertain or family word anywhere in that sentence (no, not, never, denies, ruled out, possible, suspected, versus, r/o, ?, family, mother...) means the page does not state it as the patient's, so it does not agree. A value that is not on the crop never agrees.
- **Diagnosis roles** (principal / secondary / history / unspecified) are a normalised label with no verbatim form on the page, so they are not re-read and show "no re-read required". A role row that already carries a stored disagreement from an earlier run keeps asking the reviewer for a reason.
