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
