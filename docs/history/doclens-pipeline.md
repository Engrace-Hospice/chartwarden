# DocLens pipeline (M22 Pillar 3 + M32) — F-236

Decisions and build record for DocLens stages 2–4 and the first live M32 invocation pipeline. The
architecture-level decision is [ADR-0048](../adr/ADR-0048-doclens-docling-plus-grounded-extractor.md);
the chart writeback it feeds is F-235 in [`outbox-248-builds.md`](./outbox-248-builds.md).

**F-236 — DocLens is Docling + an M32 grounded extractor; the M32 pipeline is built for the first time
(2026-10-03).** The product owner chose option B (no LangExtract), a model-agnostic extractor with BOTH a
local model (Ollama) and Claude under the BAA, page classification on the same model path, and the
backend pipeline end to end (review UI later).

*Built, in three commits.* (1) **Stage 2** — `services/docling-worker` (FastAPI, Docling 2.133, EasyOCR,
CPU, models baked into the image): a presigned GET URL in (no object-store credentials in the worker), a
worker-specific `DOCLING_WORKER_TOKEN` (NOT the backend's `INTERNAL_SERVICE_TOKEN`, which authenticates TO
the backend), per-page text blocks with top-left page-point boxes out; never logs text or URLs. M22's
`docling-client.ts` validates the payload strictly. `groundQuote` (`@wardenx/intake-extraction`): a model
quote must occur in Docling's text and contain the value; the box is the tightest matching span, searched
in Docling's order and then in **visual reading order** (rebuilt from the boxes — found on a real run:
Docling emitted "Mobile phone:", "Email:" before both values). (2) **M32** — the `aiSdk.invoke` pipeline
had never been constructed (its blocker, the per-tenant DEK cipher for `prompt_payload_cipher`, now
exists over M34's key provider). Built from the existing Drizzle stores plus: an Ollama adapter (explicit
`num_ctx`; a reply whose prompt filled the window is refused — Ollama truncates silently; vendor token
counts; healthy only if the tag is pulled), the `@anthropic-ai/sdk` transport behind the existing
ZDR-gated adapter (structured outputs via `output_config.format`; refusal / max_tokens throw; SDK
installed in `packages/ai-platform` only), deployment config binding only inventory keys, a health sweep
(the first writer of `last_health_status`, via a two-column platform grant), `db:sync:ai-backends`
(registers configured backends with real pins/Ollama digests and the BAA/ZDR/license facts the DB CHECKs
require — never invented), an `ai_token_budgets` org setting (absent ⇒ refuse), PHI-minimisation
allowlists for the DocLens capabilities only, a real actor resolver (membership → role + default provider
entity; refuses without one), hash-pinned prompt files (`packages/ai-platform/prompts/doclens/*.v1.md`)
through a filesystem artifact reader (seams refuse without an active template; ABAC and R30 now share
that registry — ABAC had silently built a second one), a strict DocLens projector + JSON schemas, and a
per-call dispatch timeout. The capability sync now allows every inventory backend that serves a capability
(it allowed only the default, so a `local_only` tenant could never be served locally). (3) **Stages 3–4**
— field schemas for all 11 types (tier is the registry's, never the model's), the `m22-doclens-intake`
BullMQ job (presign → Docling → classify per page → extract per same-type run → ground → DEK-encrypted
candidates; refused AI ⇒ `awaiting_capability`, unparseable/unfiled ⇒ `parse_failed`, idempotent on
status), `/extraction/run` now enqueues (202) instead of returning an empty in-memory result, and
`POST /intake/uploads` accepts the verified-uploaded `documentId` (the batch used to carry a random
placeholder).

*Not built.* Stage 5 vision verification and the SUD detector (candidates are stored
`vision_verified=false`, `sud_detected=false`, stated in the code); the review UI; writeback targets beyond
M5 (F-235). The four `doclens_*` capabilities stay at `DESIGN_REVIEW` platform-wide; the dev seed's PILOT
promotion is dev-only. Pre-existing and still open: route 20's licence check reads the candidate's risk
from the query string (see F-235).

*Verification.* Real model runs on the host Ollama (`llama3.1:8b-instruct-q8_0`): 15/15 fields grounded on
the synthetic image-only fax; and the full HTTP flow on the local Docker stack — verified upload → batch →
`/extraction/run` → `extraction_complete` in ~48 s → 15 encrypted candidates with Docling boxes → four
`ai_invocation` rows (local backend, real pin, encrypted prompts, `local_only` routing) → review → commit →
only the 7 allowlisted contact fields written to M5. Tests: `f236-docling-grounding` (12, on real worker
output), `f236-m32-doclens-backends` (14), `document-doclens` (+2), pytest 6, and the live suite
`test:f236:doclens-intake:live` (6: the job as `wardenx_app`, plus the pipeline over its real stores —
`local_only` routed locally, ledger ciphertext decrypts, budget/flag gates). Mutation checks (each
reverted, each caught): ungrounded fields kept, a default token budget, the PHI allowlist disabled,
plaintext candidate values stored.
