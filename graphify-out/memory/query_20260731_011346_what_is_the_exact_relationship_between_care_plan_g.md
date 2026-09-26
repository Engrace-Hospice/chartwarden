---
type: "query"
date: "2026-07-31T01:13:46.514470+00:00"
question: "What is the exact relationship between CARE_PLAN_GATES (5-day initial and 15-day review encounter-sign gates, D2/D3) and the Encounter Lifecycle State Machine & Layer-3 Signing Gate?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["CARE_PLAN_GATES — 5-day initial and 15-day review encounter-sign gates (D2, D3)", "Encounter Lifecycle State Machine & Layer-3 Signing Gate", "Per-Patient (Per-POC) 15-Day Review Floor (D17 / M14-F01)", "CarePlanReader", "Encounter-Sign Gate Fails Open with degraded Marker"]
---

# Q: What is the exact relationship between CARE_PLAN_GATES (5-day initial and 15-day review encounter-sign gates, D2/D3) and the Encounter Lifecycle State Machine & Layer-3 Signing Gate?

## Answer

Expanded from original query via vocab: [care, plan, gate, gates, encounter, sign, signing, lifecycle, state, machine, layer, clock]. Then traversed shortest-path + explain on both endpoints. RESULT: producer/consumer across the M7->M8 seam, not a duplication. The AMBIGUOUS tag is a chunk-locality artifact (M7-side extractor could not see M8's node); the reverse edge from MODULE_08_ENCOUNTERS_SPEC_v0_2.md 'Depends on 7' is EXTRACTED at 1.0 and states 'careplan.isReviewOverdue() is the 15-day signing gate this module enforces'. Chain: M14 owns the per-patient 15-day IDG review clock (D17/M14-F01); M7 defines CARE_PLAN_GATES consuming it (MODULE_07 s11 D2 D3); the CarePlanReader seam at packages/types/src/care-plan.ts:L287 exposes .isReviewOverdue() (L298) and .relevantElementsForEncounter() (L290); M8 imports it at apps/backend/src/modules/08-encounters/seams/index.ts:L13 - the entire coupling, no table read (ADR-0005). M8's Layer-3 gate is composite: also consumes M9 ScaleSeriesProvider/LatestAssessmentProvider and M10 HOPE Five RFA Timepoints. CRITICAL: the gate FAILS OPEN - M7 is DR Tier 2, M8 is DR Tier 1 (signature surface), so an unreachable CarePlanReader lets the encounter sign with a 'degraded' marker plus a retroactive-gate-audit sweep on m7.service.restored. The compliance clock records, it never blocks clinical signing. M15 aide supervisory attestation (14-day cadence) is a parallel ladder [INFERRED].

## Outcome

- Signal: useful

## Source Nodes

- CARE_PLAN_GATES — 5-day initial and 15-day review encounter-sign gates (D2, D3)
- Encounter Lifecycle State Machine & Layer-3 Signing Gate
- Per-Patient (Per-POC) 15-Day Review Floor (D17 / M14-F01)
- CarePlanReader
- Encounter-Sign Gate Fails Open with degraded Marker