# Capability - DocLens Classifier

## Purpose
Classifies uploaded documents into operational document types for review workflow routing.

## Risk Classification
Medium. Incorrect classification can delay workflow but must not directly mutate the chart.

## Architecture
Architecture section 10.6; Module 22 Documents.

## Lifecycle
State: PROPOSED. Disabled by default and deny-stubbed until M22 and M32 governance wiring land.

## Controls
Kill switch: activate an `ai_kill_switch_state` row for capability_key `doclens_classify` — platform-wide (`organization_id IS NULL`) or for one tenant. The platform row and a tenant row OR together: neither overrides the other, so lifting one does not resume a capability the other still stops. Human review, confidence display, report-output path, audit events, and deterministic/manual fallback are required before activation.

## Prompt versions
The prompt is hash-pinned (`packages/ai-platform/prompts/doclens/classify.vN.md`); a change is a new version, never an edit in place. `classify.v2.md` replaces v1's one-line `consult` and `transfer_record` definitions with ones that name the allied-health notes (wound/ostomy, nutrition, therapy) as `consult` and the administrative or functional paperwork that travels between organizations (fax cover sheets, referral forms, face sheets, transfer forms, nursing functional assessments) as `transfer_record`. Scored against the synthetic complex-packet answer key on a local model, page by page: v1 19/21, v2 21/21.
