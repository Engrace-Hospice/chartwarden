# Stage 1 proposal and Stage 2 design review - ADR documentation readiness

Capability: `adr_documentation_readiness` (PROPOSED, advisory). Governance sections 5.1 and 5.2. Nothing here enables AI; no vendor or model is chosen.

## Stage 1 - Proposal
**Problem.** An ADR response packet is assembled by staff against a six-key checklist (`ADR_CHECKLIST_KEYS`, which the SME has not confirmed). Gaps are found after the MAC responds. Staff want to see likely gaps before submitting.

**Non-AI alternative (built first, 8a-1).** A deterministic view: for each checklist key, the documents attached to it, with keys that have none flagged. It needs no model, is always available, and is the control arm for evaluation.

**Proposed AI approach.** An advisory readiness review that reports whether a document that appears to be of a given kind is attached, citing where, or "cannot tell". Never sufficiency under CMS; never an "all clear".

**Initial risk classification.** Medium with High-class controls (recommended default); alternative High because over-reassurance on a filing is the product's own high-impact risk. Decision D2, AI Safety Owner.

**Cost estimate.** TBD; a per-tenant token cap must be set by the product owner before enabling (no authority states a figure).

**Initial success criteria.** Measurable gap-recall lift over the deterministic baseline, zero invalid citations after the filter, zero cross-tenant leakage (metrics in `docs/ai/evaluation/adr-documentation-readiness-dataset-spec.md`; thresholds TBD).

## Stage 2 - Design review
**Architecture.** M25 holds a local structural port `AdrReadinessAssistPort`, resolved to a deny-stub (`capability_unavailable`), bound later to an opaque M32 seam; no import of the AI platform package. The result is `{ available: true, findings, invocationId, modelVersionPin, promptTemplateVersion } | { available: false, reason }`, never a throw. Model, vendor and backend: none chosen (D1).

**Control flow.** Reviewer requests a review; M32 runs its eight-gate invocation order (kill switch, tenant opt-in, PHI validator, token budget and the rest); output is schema-validated (one retry), citation-filtered against packet document ids, and merged under rules that forbid an AI finding from turning a deterministic gap into "present"; findings are stored apart from the human checklist; the human disposes each finding.

**PHI flow.** Leaves M25: ids and counts only (`adrCaseId`, `documentId`, `checklistKey`, `pageCount`). Document text is read inside the M32 boundary under the caller's tenant scope; M25 never handles it. Where machine-readable text comes from is an open investigation (M22 pipeline; no stored OCR text column was found). Prompt and response are stored as ciphertext in the immutable ledger. Cross-tenant pooling is prohibited. Nothing leaves the platform until a BAA, ZDR and sub-processor review are confirmed (checklist below).

**Threat model.**

| Threat | Mitigation |
|---|---|
| Prompt injection via document text | Delimiters, instruction to ignore embedded instructions, no tools, schema-validated output, output cannot write anything, `injection_suspected` flag, adversarial suite |
| Hallucinated citation | Citation filter against packet document ids; uncited finding dropped; validity measured before and after the filter |
| Over-reassurance (false "present", implied "ready") | Presence-only claims, no "all clear", deterministic gaps cannot be overridden, wording avoids "compliant" and "sufficient", persistent banner, recall-first evaluation |
| Cross-tenant leakage | RLS FORCEd on findings tables, tenant-scoped invocation, canary test, no pooling |
| PHI in logs, events or alerts | Ids only in events; notes audit-scrubbed; ciphertext payloads; no PHI in prompt templates |
| Scope creep to sufficiency or checklist auto-fill | AI-prohibited zone for M25 entities with boot validator, merge-rule tests, review checklist |
| Silent unavailability / cannot be stopped | Deny-stub tests, kill-switch drill (8b acceptance), wiring grep of `apps/backend/src/index.ts` |
| Data exfiltration via the chart context | Allowlist of primitives, no free text from M25 |
| Bias by document type or MAC | Slice metrics |

**Human in the loop.** Each finding is acknowledged, dismissed or disputed; "Report wrong finding" feeds `ai_hallucination` triage. Dispositions are the evaluation feedback loop. Reviewing is never a sign-off requirement.

**Audit design.** M32 `ai_invocation` ledger (model pin, template version, token counts, ZDR flag); M25 events `m25.adr_readiness_*` carrying ids only.

**Calibration plan.** See the dataset spec; thresholds TBD.

**Vendor BAA confirmation checklist (all unchecked; nothing assumed).**
- [ ] Vendor and backend decided by the user (D1)
- [ ] BAA signed and covers this use (the Anthropic BAA is documented as in negotiation)
- [ ] ZDR confirmed for the tenant route
- [ ] Sub-processor review complete
- [ ] Tenant compliance officer policy on AI use of records noted (SME item)
- [ ] Per-tenant token cap set

## Open decisions and SME items
Decisions: D1 vendor/backend; D2 risk class; token budget; pilot tenant. SME: what each MAC ADR letter requires and whether the six keys are right; whether the MAC letter text is an input; what counts as sufficient (out of scope for AI); who labels the dataset and what recall is acceptable; whether a compliance officer must approve AI use. Approvers: AI Safety Owner, Privacy Officer; Clinical Reviewer if classified High.
