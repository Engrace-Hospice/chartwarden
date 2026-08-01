# Capability - Mortality / Decline Prediction

## Purpose
Predictive clinical decision support for mortality or decline risk.

## Risk Classification
High. Output can affect clinical prioritization and care decisions.

## Architecture
Module 32 AI Platform; ADR-004 remains open.

## Lifecycle
State: PROPOSED. Disabled by default and not product-active until the ADR and governance lifecycle approve it.

## Controls
Kill switch: activate an `ai_kill_switch_state` row for capability_key `mortality_decline_prediction` — platform-wide (`organization_id IS NULL`) or for one tenant. The platform row and a tenant row OR together: neither overrides the other, so lifting one does not resume a capability the other still stops. Formal clinical evaluation, bias review, clinician-facing explanation, human-in-the-loop review, audit events, monitoring, and tenant opt-in are required before activation.
