# Capability - Falls Risk Prediction

## Purpose
Predictive clinical decision support for falls risk.

## Risk Classification
High. Output can affect clinical safety workflows.

## Architecture
Module 32 AI Platform; future capability.

## Lifecycle
State: PROPOSED. Disabled by default and not product-active until specifically approved.

## Controls
Kill switch: activate an `ai_kill_switch_state` row for capability_key `falls_risk_prediction` — platform-wide (`organization_id IS NULL`) or for one tenant. The platform row and a tenant row OR together: neither overrides the other, so lifting one does not resume a capability the other still stops. Formal clinical evaluation, bias review, clinician-facing explanation, human-in-the-loop review, audit events, monitoring, and tenant opt-in are required before activation.
