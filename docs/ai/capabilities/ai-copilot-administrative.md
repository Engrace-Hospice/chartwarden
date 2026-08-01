# Capability - AI Copilot Administrative

## Purpose
Administrative assistance for billing, workflow, and operational questions.

## Risk Classification
Medium. Output is non-clinical but can affect operational decisions.

## Architecture
Module 32 AI Platform.

## Lifecycle
State: PROPOSED. Disabled by default until M32 implements the full governance lifecycle.

## Controls
Kill switch: activate an `ai_kill_switch_state` row for capability_key `copilot_admin` — platform-wide (`organization_id IS NULL`) or for one tenant. The platform row and a tenant row OR together: neither overrides the other, so lifting one does not resume a capability the other still stops. Human-on-the-loop review, report-output path, audit events, PHI minimization, and tenant opt-in are required before activation.
