# Capability - DocLens Classifier

## Purpose
Classifies uploaded documents into operational document types for review workflow routing.

## Risk Classification
Medium. Incorrect classification can delay workflow but must not directly mutate the chart.

## Architecture
Architecture section 10.6; Module 22 Documents.

## Lifecycle
State: PROPOSED. Disabled by default and deny-stubbed until M22 and M32 governance wiring land.

## Controls
Kill switch: `ai.doclens_classifier_kill`. Human review, confidence display, report-output path, audit events, and deterministic/manual fallback are required before activation.
