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
Kill switch: `ai.copilot_clinical_kill`. Explicit labeling, clinician verification, report-output path, monitoring, audit events, PHI minimization, and tenant opt-in are required before activation.
