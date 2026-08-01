# Capability - Level of Care Prediction

## Purpose
Predicts the level of care a patient is likely to need, informing care plan and IDG discussion.

## Risk Classification
High — **assigned here, not inherited.** No prior source states a risk class for this capability: it is named by Module 32 section 2.4's prediction group and by Architecture section 10's capability inventory, but neither classifies it, and `ai_capability.risk_tier` is NOT NULL so the registry cannot seed it unstated. High is assigned because the output feeds care planning and IDG decisions, matching the other clinical-decision-support predictions, and because over-classifying costs governance effort while under-classifying removes controls. **Ratify or revise this before the capability advances past PROPOSED.**

## Architecture
Module 32 AI Platform; consumed at the care plan and IDG surfaces. Tabular ML (XGBoost on `local-ml-worker`) — a service, not one of the section 2.3 LLM backend keys, so it registers with `defaultBackendKey: null`. Registered as capability key `level_of_care_prediction`.

## Lifecycle
State: PROPOSED. Phase 2 or later; no Phase-1 consumer surface.

## Controls
Kill switch: `ai.level_of_care_prediction_kill`. Level of care determines both what the patient receives and what is billed, so human-in-the-loop is mandatory and the prediction must never populate a level-of-care field directly. Calibration evidence, deterministic fallback to clinician determination, and periodic re-evaluation are required before activation.
