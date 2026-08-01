# Capability - Level of Care Prediction

## Purpose
Predicts the level of care a patient is likely to need, informing care plan and IDG discussion.

## Risk Classification
High. **Ratified 2026-08-01** — this classification is decided, not provisional, and is the authoritative source for the capability's risk class.

The classification originated here rather than being inherited: Module 32 section 2.4's prediction group and Architecture section 10's capability inventory both name this capability without classifying it, and `ai_capability.risk_tier` is NOT NULL, so the registry could not seed it until a risk class was stated. High is the ratified class because the output feeds care planning and IDG decisions, placing it alongside the other clinical-decision-support predictions, and because level of care determines both what the patient receives and what is billed.

The classification is load-bearing in three places, all of which this ratification settles in the fail-safe direction: it requires a Clinical Reviewer on the approval gate (section 5.7 drops that reviewer only for low-risk capabilities), it sets a 12-month re-approval cadence (section 5.6), and it makes the section 164.528 disclosure-accounting acknowledgment mandatory before a tenant may opt in (section 5.3.1(4)).

Section 4.2's standing reassignment rule is unaffected: any risk class may be reassigned if usage patterns shift. That is a re-classification through governance, not a reopening of this decision.

## Architecture
Module 32 AI Platform; consumed at the care plan and IDG surfaces. Tabular ML (XGBoost on `local-ml-worker`) — a service, not one of the section 2.3 LLM backend keys, so it registers with `defaultBackendKey: null`. Registered as capability key `level_of_care_prediction`.

## Lifecycle
State: PROPOSED. Phase 2 or later; no Phase-1 consumer surface.

## Controls
Kill switch: activate an `ai_kill_switch_state` row for capability_key `level_of_care_prediction` — platform-wide (`organization_id IS NULL`) or for one tenant. The platform row and a tenant row OR together: neither overrides the other, so lifting one does not resume a capability the other still stops. Level of care determines both what the patient receives and what is billed, so human-in-the-loop is mandatory and the prediction must never populate a level-of-care field directly. Calibration evidence, deterministic fallback to clinician determination, and periodic re-evaluation are required before activation.
