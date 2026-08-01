# Capability - AI Copilot Clinical

## Purpose
Clinical question-answering and summarization assistance for authorized clinicians.

## Risk Classification
High. Clinicians may rely on outputs in care workflows.

## Architecture
Module 32 AI Platform.

## Lifecycle
State: PROPOSED. Disabled by default until M32 implements the full governance lifecycle.

## Controls
Kill switch: activate an `ai_kill_switch_state` row for capability_key `copilot_clinical` — platform-wide (`organization_id IS NULL`) or for one tenant. The platform row and a tenant row OR together: neither overrides the other, so lifting one does not resume a capability the other still stops. Explicit labeling, clinician verification, report-output path, monitoring, audit events, PHI minimization, and tenant opt-in are required before activation.
