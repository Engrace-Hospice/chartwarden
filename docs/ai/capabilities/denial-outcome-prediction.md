# Capability - Denial Outcome / Appeal Probability Prediction

## Purpose
Predicts the probability that a denied claim is overturned on appeal, so revenue-cycle staff can prioritize the appeals worth pursuing.

## Risk Classification
Medium. Financial decision support with no clinical surface. The failure mode is an appeal not filed — recoverable revenue lost, and a systematic bias would be invisible without monitoring.

## Architecture
Module 25 Remittance and Denials; Module 32 AI Platform. Tabular ML (XGBoost on `local-ml-worker`) — a service, not one of the section 2.3 LLM backend keys, so it registers with `defaultBackendKey: null`. Registered as capability key `denial_outcome_prediction`.

## Lifecycle
State: PROPOSED. Phase 2 or later; no Phase-1 consumer surface.

## Controls
Kill switch: activate an `ai_kill_switch_state` row for capability_key `denial_outcome_prediction` — platform-wide (`organization_id IS NULL`) or for one tenant. The platform row and a tenant row OR together: neither overrides the other, so lifting one does not resume a capability the other still stops. The prediction ranks work, it does not close it: no appeal may be abandoned by the system on the strength of a score, and the decision to drop an appeal stays with a named user. Monitoring for payer-correlated bias and periodic re-evaluation are required.
