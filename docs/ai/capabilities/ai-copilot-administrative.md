# Capability - AI Copilot Administrative

## Purpose
Administrative assistance for billing, workflow, and operational questions.

## Risk Classification
Medium. Output is non-clinical but can affect operational decisions.

## Architecture
Module 32 AI Platform.

## Lifecycle
State: PROPOSED. Disabled by default until M32 implements the full governance lifecycle.

## Controls
Kill switch: `ai.copilot_administrative_kill`. Human-on-the-loop review, report-output path, audit events, PHI minimization, and tenant opt-in are required before activation.
