# Capability - Aggregate Cap Projection

## Purpose
AI-assisted aggregate hospice cap forecasting.

## Risk Classification
Medium. Output can affect financial planning and reimbursement decisions.

## Architecture
Module 26 Cap Management.

## Lifecycle
State: PROPOSED. Disabled by default; Module 26 is currently a placeholder and may remain deterministic.

## Controls
Kill switch: **none yet, and none is needed while this stands.** Killing a capability means activating an `ai_kill_switch_state` row against its `ai_capability` row, and this is the one cataloged capability Module 32's section 2.4 inventory does not register — it has no `capability_key`, so there is nothing to kill and equally nothing to invoke. The moment Module 32 registers it, the kill switch exists automatically by foreign key; until then the absence is the control.

Human-on-the-loop review, calibration evidence, audit events, and deterministic financial calculation fallback are required before activation.
