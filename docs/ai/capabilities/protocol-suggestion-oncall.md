# Capability - On-Call Triage Protocol Suggestion

## Purpose
Suggests a triage protocol to the on-call clinician handling an after-hours call, from the caller's report and the patient's recent chart.

## Risk Classification
High. The suggestion reaches a clinician making an urgent disposition decision — often at night, often about a symptom that could be terminal decline or could be an emergency — and a wrong protocol steers that decision.

## Architecture
Module 19 On-Call Triage; Module 32 AI Platform. M19-T01 declares the `ProtocolSuggestionProvider` seam in `@wardenx/types`; Module 32 implements it as a deny-stub and does not re-declare it. Registered as capability key `protocol_suggestion_oncall`, backend `anthropic-claude-opus-4-7`.

## Lifecycle
State: PROPOSED. Module 32's Phase-1 inventory seeds it DESIGN_REVIEW; that advance is not ratified here and requires the section 5 approval workflow. The M19 seam stays a deny-stub until it is.

## Controls
Kill switch: activate an `ai_kill_switch_state` row for capability_key `protocol_suggestion_oncall` — platform-wide (`organization_id IS NULL`) or for one tenant. The platform row and a tenant row OR together: neither overrides the other, so lifting one does not resume a capability the other still stops. Human-in-the-loop is mandatory — the suggestion is advisory and the clinician's selected protocol is what is recorded. The deterministic M19 protocol list remains the fallback and must stay fully usable with the capability off.
