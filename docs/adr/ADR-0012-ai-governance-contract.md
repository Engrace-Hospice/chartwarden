# ADR-0012 — AI governance contract: auto kill-switch, eval gate, mandatory `ai.*` audit events, BAA+ZDR gate

- **Status:** Accepted
- **Date:** 2026-06-11
- **Phase:** 3 (governed subsystems)
- **Resolves:** X7; M32-F01/F02/F03/F08; M08-F01; the AI-governance under-implementation across
  M07/M14/M16/M19/M22/M23/M24/M30/M36/M38
- **Changes:** `WARDENX_MODULE_32_AI_PLATFORM_SPEC` (the substrate), `WARDENX_MODULE_08`, every AI-touching module (CI-gated)

## Context

M32 (AI Platform) is the governance substrate every AI feature inherits. The audit found M32
itself FAILS, and that almost every AI-touching feature under-implements the mandated lifecycle.
The platform cannot enable any governed AI capability until these contracts are real and enforced.

## Decision

### D1 — The 30% drift kill-switch is AUTOMATIC, not discretionary (AI-025)

A red-band drift breach (≥30%) **auto-activates** the capability kill-switch (actor_kind
`automated_drift_monitor`) and raises SEV-1, *pending* AI-Safety-Owner investigation. The
`ai:drift-sweeps` worker calls the kill-switch activation path on a red breach — it does not merely
emit an alert the owner "may" act on. Drift evidence is stored in a **declared** structure
(`ai_drift_event`, an owned table), not an undefined JSONB blob.

### D2 — No model ships hot without a passed Stage-3 eval + per-backend calibration (AI-052/AI-079)

A capability's *backend* (cloud or local) may serve production PHI-derived output **only** after a
per-backend Stage-3 side-by-side evaluation pass and an `ai_capability_calibration` row for that
`(capability, backend)`. Un-evaluated local models (`local-llama-3.1-8b`, Mistral, Phi-3.5 —
"pending Stage-3" per AI-079/OPEN-015) are **not** usable in production; a `local_only`/`prefer_local`
tenant for such a capability is told it is unavailable until the eval lands. PILOT precedes APPROVED
(AI-013/AI-018): a fixture-only eval does not satisfy the Stage-4 pilot.

### D3 — Mandatory `ai.*` audit-event taxonomy (AI-082/AI-046/AI-055)

Every governed invocation emits the **exact** event names the AI-Governance §16.1 contract and the
§164.528 accounting query key off — not renamed/collapsed substitutes:

- `ai.capability_invoked` (every invocation)
- `ai.phi_disclosed` (every **cloud** invocation — the §164.528 disclosure feeder; see ADR-0013)
- `ai.local_inference` (every **local** invocation)
- the four **discrete** `ai.output_accepted` / `ai.output_edited` / `ai.output_rejected` /
  `ai.output_flagged` events (not one collapsed `hitl_outcome` field).

Cloud-vs-local is keyed off `ai_model_backend.kind = 'cloud'` (there is no `is_cloud` column).

### D4 — BAA + ZDR activation gate before any cloud AI call (INT-034/AI-042/AI-043)

No PHI leaves the perimeter to a cloud AI vendor unless the triple gate is satisfied:
**capability opt-in flag ∧ BAA+ZDR executed/confirmed ∧ routing-allows-cloud**. The **Anthropic BAA
is "in negotiation" (AI Governance §9.2), NOT executed** — so the cloud path is **disabled** until
the platform-level `external.anthropic_baa_executed` flag is set. M32's cloud backend
**hard-refuses dispatch** (reason `baa_not_executed`) until then; consuming features surface the
refusal. Asserting "BAA in place" anywhere is a defect (M08-F01).

### D5 — Every AI feature registers in the capability catalog and gates against M32

No module calls an LLM directly. Every AI-touching feature (M07/M08/M14/M16/M19/M22/M23/M24/M30/M36/M38)
registers an `ai_capability` in M32's catalog and routes through M32's SDK, inheriting the
kill-switch, BAA+ZDR gate, calibration thresholds, the `ai.*` audit emission, the "Report this
output" path, and the AI-prohibited-zone enforcement. A feature that under-implements any gate fails
the AI-governance review.

## Consequences

- M32 is fixed first (M32-F01/F02/F03/F08). Until D4's BAA flag flips, all cloud AI is dark and the
  approved local-model capabilities are limited to D2-evaluated backends.
- M08's HearthNote Layer 2 gains `baa_not_executed`/`routing_preference_blocks_cloud`/
  `kill_switch_active` eligibility reasons and strikes its false BAA assertion.
- The §164.528 AI-disclosure accounting (ADR-0013) now has the `ai.phi_disclosed` event to enumerate.
