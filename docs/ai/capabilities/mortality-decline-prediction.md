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
Kill switch: `ai.mortality_decline_prediction_kill`. Formal clinical evaluation, bias review, clinician-facing explanation, human-in-the-loop review, audit events, monitoring, and tenant opt-in are required before activation.
