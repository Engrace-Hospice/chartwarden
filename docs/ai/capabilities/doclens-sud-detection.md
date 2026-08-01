# Capability - DocLens SUD Indicator Detection

## Purpose
Detects substance-use-disorder indicators in intake documents so that 42 CFR Part 2 handling is applied to the record before it reaches the chart.

## Risk Classification
High. A missed indicator means Part 2 material is filed without its redaction discipline; a false indicator applies a disclosure restriction to a record that does not need one. Both failures are compliance failures, not workflow ones.

## Architecture
Architecture section 10.6; Module 22 Documents. Registered by Module 32 as capability key `doclens_sud_detect`, backend `anthropic-claude-opus-4-7`.

## Lifecycle
State: PROPOSED. Module 32's Phase-1 inventory seeds it DESIGN_REVIEW; that advance is not ratified here and requires the section 5 approval workflow. Disabled by default and deny-stubbed regardless while `ai.full` is off.

## Controls
Kill switch: `ai.doclens_sud_detect_kill`. A detector governing Part 2 handling must not act alone: human confirmation before the classification changes record handling, deterministic fallback to manual Part 2 marking, and full audit of every invocation are required before activation.
