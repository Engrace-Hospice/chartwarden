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
Kill switch: `ai.aggregate_cap_projection_kill`. Human-on-the-loop review, calibration evidence, audit events, and deterministic financial calculation fallback are required before activation.
