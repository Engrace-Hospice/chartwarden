# Capability - DocLens Vision Verification

## Purpose
Verifies high-risk extracted fields against document images.

## Risk Classification
High. Verification output can influence chart-entry acceptance and may process PHI-bearing images.

## Architecture
Architecture section 10.6; Module 22 Documents.

## Lifecycle
State: PROPOSED. Disabled by default and deny-stubbed until M22 and M32 governance wiring land.

## Controls
Kill switch: `ai.doclens_vision_verification_kill`. Human-in-the-loop approval, source-view confirmation, model/provider approval, BAA/ZDR gate, audit events, and deterministic/manual fallback are required before activation.
