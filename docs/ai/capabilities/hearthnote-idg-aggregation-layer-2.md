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
Kill switch: `ai.hearthnote_idg_aggregation_layer2_kill`. Human-in-the-loop approval, source provenance, audit events, and deterministic fallback are required before activation.
