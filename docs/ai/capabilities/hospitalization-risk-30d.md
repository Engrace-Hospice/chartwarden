# Capability - 30-Day Hospitalization Risk Prediction

## Purpose
Predicts the likelihood that a patient is hospitalized within 30 days, surfacing patients whose plan of care may need revisiting before a crisis forces the transfer.

## Risk Classification
High. Clinical decision support. A hospitalization for a hospice patient is frequently the event that ends the benefit period, so a score that is trusted and wrong redirects care planning for the patients who least tolerate it.

## Architecture
Module 32 AI Platform, consumed by Modules 19 On-Call Triage, 14 IDG, and 16 Bereavement. Tabular ML (XGBoost on `local-ml-worker`) — a service, not one of the section 2.3 LLM backend keys, so it registers with `defaultBackendKey: null`. Registered as capability key `hospitalization_risk_30d`.

## Lifecycle
State: PROPOSED. Module 32's Phase-1 inventory seeds it DESIGN_REVIEW; that advance is not ratified here and requires the section 5 approval workflow.

## Controls
Kill switch: activate an `ai_kill_switch_state` row for capability_key `hospitalization_risk_30d` — platform-wide (`organization_id IS NULL`) or for one tenant. The platform row and a tenant row OR together: neither overrides the other, so lifting one does not resume a capability the other still stops. Required before activation: calibration evidence per tenant before any score is shown, display of the score's uncertainty rather than a bare number, an explicit statement that it must not be used as an admission or discharge criterion, human-in-the-loop at every consuming surface, and periodic re-evaluation for drift.
