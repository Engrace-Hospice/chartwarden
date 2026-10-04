# ADR-0048 — DocLens is Docling + an M32 grounded extractor; no `langextract-worker`; extraction is routable to a local model or to Claude under the BAA

- **Status:** **Accepted** — decided by the product owner 2026-10-03 (F-236).
- **Date:** 2026-10-03
- **Phase:** DocLens build-out (M22 Pillar 3), following F-235 / #248 (the chart writeback).
- **Amends:** Architecture §10.6.1 (pipeline stage 4), §10.6.5 ("PHI never leaves the perimeter for
  classification or extraction"), §10.6.2 (classifier), System Design §1.1 / §1.3.4 / SD-004 (the
  Python worker list) — see "Consequences".

## Context

The architecture specified DocLens as eight stages with two Python sidecars on the parse/extract path:
`docling-worker` (layout + OCR, stage 2) and `langextract-worker` (schema-driven extraction with Google's
LangExtract library, stage 4), plus a DistilBERT `ml-worker` classifier (stage 3). None of the three
existed. Three facts shaped the decision:

1. **LangExtract is not a model.** It is an orchestration library around an LLM (few-shot prompting,
   chunking, character-offset grounding). It keeps PHI local only if the LLM behind it is local, and its
   grounding is in TEXT offsets — the review screen needs PAGE BOXES, which only the layout parser has.
   Mapping text back to Docling's boxes is needed either way.
2. **The M32 registry already disagreed with §10.6.5:** `doclens_extract` defaults to a hosted Claude
   backend while the architecture says extraction stays on local workers.
3. **No labelled training set exists** for a DocLens DistilBERT classifier.

## Decision

1. **Stage 2 is Docling**, as a CPU-only `services/docling-worker` (FastAPI). The backend hands it a
   short-lived presigned GET URL (it holds no object-store credentials) and authenticates with a
   worker-specific `DOCLING_WORKER_TOKEN` — never the backend's own `INTERNAL_SERVICE_TOKEN`, which
   authenticates *to* the backend. It returns per-page text blocks with top-left-origin page-point boxes.
2. **There is no `langextract-worker`.** Extraction is an **M32 capability** (`doclens_extract`) called
   through the existing governed invocation pipeline (flag → lifecycle → kill switch → opt-in → opt-out →
   token cap → PHI minimisation → routing → ledger). The model is asked for each field's value plus a
   **verbatim quote** and page. **M22 grounds the quote deterministically** against Docling's text: a
   quote not found in the parsed text, or a value not contained in its quote, drops the field
   (`packages/intake-extraction/src/pipeline/grounding.ts`). The box shown to the reviewer is always
   Docling's, never the model's.
3. **Classification (stage 3) is the same M32 model path** (`doclens_classify`), confirmed by the
   reviewer through the existing confirm-classification route. No `ml-worker` for DocLens.
4. **The backend is routable per tenant: a local model (Ollama) or Claude under the BAA.** Both are
   `ModelBackend` adapters in `packages/ai-platform` (the vendor-adapter mandate's one address). The
   Anthropic adapter keeps its D19 constructor invariant (no dispatch without a resolved, unexpired ZDR
   contract). Which one a tenant uses is the existing M32 routing machinery — the tenant's consented
   `ai_routing_preference` (`local_only` forbids the cloud absolutely, W8) and the capability's
   `allowed_backend_keys`.

## Consequences

- **§10.6.5 is amended**: "PHI never leaves the perimeter for classification or extraction" becomes
  "PHI leaves the perimeter for classification or extraction **only** for a tenant whose consented
  routing permits a cloud backend, only to a backend with a ZDR contract under the BAA, and every such
  call is an `ai_invocation` row (§164.528)". A `local_only` tenant keeps the original guarantee.
- **SD-004's worker list** loses `langextract-worker`; `docling-worker` stays. DocLens does not need
  `ml-worker`. (Other modules' `ml-worker` / `embeddings-worker` are unaffected.)
- Grounding is **block-level**, not character-level: a highlight is as precise as Docling's layout block.
  A field whose value is split oddly by OCR may fail to ground and is dropped (visible as a count), which
  is the fail-closed direction.
- Nothing becomes active by this ADR. The four `doclens_*` capabilities stay at `DESIGN_REVIEW`; `ai.full`
  and `documents.doclens` stay OFF for every tenant. Promotion remains the AI Safety Owner's act.

## Amendment (F-237, 2026-10-03) — stage 5 and SUD detection

- **Stage 5 is a blind re-read, not a confirmation.** `doclens_vision_verify` receives a crop of the value's
  Docling box (rendered by the docling-worker's `/render`) and the field's path and description — never the
  extracted value. M22 compares. List fields read every visible entry and verify membership.
- **A local vision route.** §2.3 gave vision verification one home (Opus), which left a `local_only` tenant
  without stage 5. `local-qwen2.5-vl-7b-instruct` (Apache-2.0, `text` + `vision`) is registered for
  `doclens_vision_verify` only. Images travel in `ModelBackendCompletionRequest.images`; a request carrying
  images requires the `vision` modality at the routing gate; the ledger keeps image SHA-256s, never bytes.
- **SUD detection is rules first.** A deterministic flagger runs on every page whatever the AI posture;
  `doclens_sud_detect` (served locally by the Llama route as well) only ADDS indicators, each grounded like
  an extraction quote. Nothing is promoted: all four capabilities remain at `DESIGN_REVIEW`.

