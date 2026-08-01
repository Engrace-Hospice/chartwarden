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
Kill switch: activate an `ai_kill_switch_state` row for capability_key `doclens_extract` — platform-wide (`organization_id IS NULL`) or for one tenant. The platform row and a tenant row OR together: neither overrides the other, so lifting one does not resume a capability the other still stops. Human-in-the-loop approval, source-view confirmation, per-field provenance, audit events, and no-auto-commit behavior are required before activation.
