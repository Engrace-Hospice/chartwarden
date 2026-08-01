# Capability - HearthNote IDG Aggregation Layer 2

## Purpose
LLM-assisted polish of IDG packet narrative after deterministic aggregation.

## Risk Classification
High. Output can affect clinical interdisciplinary review material.

## Architecture
Architecture section 10.5.5; Module 14 IDG.

## Lifecycle
State: PROPOSED. Disabled by default and deny-stubbed until M32 and the Module 14 full-IDG activation work land.

## Controls
Kill switch: activate an `ai_kill_switch_state` row for capability_key `idg_layer2_polish` — platform-wide (`organization_id IS NULL`) or for one tenant. The platform row and a tenant row OR together: neither overrides the other, so lifting one does not resume a capability the other still stops. Human-in-the-loop approval, source provenance, audit events, and deterministic fallback are required before activation.
