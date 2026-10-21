# ChartWarden — Phase 2 Part A: flag-activation upgrades (Archon task plan)

Phase 2 Part A from `PHASE_2_PLAN.md` §2 — **re-open Phase-1 modules to flip default-off flags on**,
each re-running the full DoD gate for the *new surface* (schema delta if any + routes + UI + audit +
RBAC + tests). **Conventions, determinism rules, and the validate gate are inherited from
`M01-M02_VERTICAL_SLICE_PLAN.md`.** No manifest changes (these are flag activations on already-owned
tables/code); architecture wins over specs.

> **Sequence (PHASE_2_PLAN §2):** **M32 `ai.full` FIRST** (everything else consumes it) → **M8
> `hearthnote.layer2`** → **M14 full IDG aggregation**; **M22 DocLens** and **M17 route-opt** are
> independent and parallel once M32-full lands.
>
> **AI governance is the gate (M32):** every capability registered, prompt-registry validated, the
> per-module AI-prohibited zones (`validate*AIBlock()`) hold at boot, kill-switch + per-tenant opt-in +
> per-clinician opt-out enforced (`WARDENX_AI_GOVERNANCE`). Layer 2 is **narrate-around-existing-rows
> only** — never invents clinical facts; shares M8's hard-block category list.

## A1 — M32 AI Platform: activate `ai.full`
- **A1-T01** Flip `ai.full` capabilities from Phase-1 deny-stubs to real: predictions, chart copilot,
  semantic search (M38 `concept_embedding`/pgvector endpoint, closing the Phase-1 M38 gate). Local
  models via Ollama default (architecture §10.7); cloud per-capability per-tenant.
- **A1-T02** Populate `ai_model_backend` + `ai_prompt_template` + `AIPromptRegistry`; calibration +
  evaluation runs (`ai_capability_calibration`/`ai_evaluation_run`); bias/drift monitoring.
- **A1-T03** Boot-validate every consumer's AI-prohibited zone (`validate*AIBlock()`); kill-switch +
  token-budget + opt-in/opt-out enforced on the now-live capabilities.
- **A1-T04** Tests (M32 §10 W2–W8: token cap, kill switch, opt-in, hallucination triage, local-only
  routing) + AI-governance acceptance. → `bun run test` + full `arch:fitness`.

## A2 — M8 Encounters: activate `hearthnote.layer2`  (needs A1)
- **A2-T01** Wire M8's Layer-2 `narrativeEnhancement` to the real M32 capability (was a deny-stub);
  tenant opt-in + per-encounter opt-out; record `hearthnote_llm_modification`.
- **A2-T02** Enforce M8's hard-block category list at the Layer-2 boundary (narrate-around-rows only).
- **A2-T03** Tests (Layer-2 finalize/review §5.3, opt-out, hard-block) + DoD for the new surface. → gates.

## A3 — M14 IDG: full HearthNote aggregation  (needs A1 + A2)
- **A3-T01** Upgrade the basic packet to **full packets + LLM polish** (the no-prep IDG feature):
  Layer-2 aggregation of the per-patient packet from M8 signed encounters + M9/M10 + M7.
- **A3-T02** Signed minutes with LLM-assisted draft; SUD redaction preserved at packet read.
- **A3-T03** Tests (full-packet build, LLM polish, signed minutes) + DoD. → gates.

## A4 — M22 Documents: activate `documents.doclens`  (needs A1)
- **A4-T01** Flip DocLens from **503 EXTRACTION_DISABLED** to live: `packages/intake-extraction`
  classifier/extractor/vision-verify via M32; the full W1 intake pipeline (classify → extract →
  review → chart writeback) over `extraction_*` tables.
- **A4-T02** SUD-detection path live (W-CON-04 with M39): interim PrivacyFlag → consent capture;
  per-field high-risk review gate; provenance.
- **A4-T03** Tests (W1 happy path, extraction review, SUD detection) + DoD. → gates.

## A5 — M17 Scheduling: activate `scheduling.route_optimization`  (needs A1 not required)
- **A5-T01** Flip route optimization on via `packages/routing-client` (Mapbox/OSRM, §7.9); degraded
  fallback to unoptimized scheduling (Phase-1 behavior) when the routing service is down.
- **A5-T02** Tests (route-opt happy path + OSRM degraded mode) + DoD. → gates.

## Part A acceptance
1. All five flags ON; each upgrade passes DoD for its new surface; no schema/manifest change beyond
   what the owning module already owns.
2. AI governance acceptance passes (A1); the "no-prep IDG" chain (encounters L2 → discipline plans →
   IDG full packet → signed minutes) works once A2/A3 + Wave P2-1 M15 land.
3. Phase-3 flags stay OFF (`dosespot.epcs`, `fhir.write`, `saas.multi_tenant`,
   `quality.cahps`/`hvldl_hci`, `cap.full_projection`).
4. `bun run build && bun run arch:fitness && bun run test` green; fixtures still red.

> Run via Archon, e.g.: `archon workflow run chartwarden-piv --branch feat/ai-full "Use the plan at docs/plans/PHASE_2A_UPGRADES_PLAN.md (A1 only)"`
