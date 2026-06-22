# Capability - DocLens Extractor

## Purpose
Extracts structured candidate data from intake documents for human review.

## Risk Classification
High. Extracted candidates can propose chart entries and may contain PHI.

## Architecture
Architecture section 10.6; Module 22 Documents.

## Lifecycle
State: PROPOSED. Disabled by default and deny-stubbed until M22 and M32 governance wiring land.

## Controls
Kill switch: `ai.doclens_extractor_kill`. Human-in-the-loop approval, source-view confirmation, per-field provenance, audit events, and no-auto-commit behavior are required before activation.
