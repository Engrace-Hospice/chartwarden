# Capability - Bereavement Risk Narrative Augmentation

## Purpose
Augments the bereavement risk assessment with a narrative summary of the survivor's circumstances, alongside the deterministic risk score.

## Risk Classification
Medium. The narrative informs bereavement service intensity for a survivor rather than clinical care for a patient. Harm from a poor narrative is real but indirect: a family under-served during bereavement, not a treatment decision made wrongly.

## Architecture
Module 16 Bereavement; Module 32 AI Platform. Registered as capability key `bereavement_risk_narrative`, backend `anthropic-claude-opus-4-7`.

## Lifecycle
State: PROPOSED. Module 32's Phase-1 inventory seeds it DESIGN_REVIEW; that advance is not ratified here and requires the section 5 approval workflow. Module 16 ships its deterministic D3/D17 score alone until this promotes, and its `ai.full` ladder is already built against that expectation.

## Controls
Kill switch: `ai.bereavement_risk_narrative_kill`. The deterministic score remains authoritative and is never replaced by the narrative. Human review before the narrative is filed, audit of every invocation, and full function of Module 16 with the capability off are required.
