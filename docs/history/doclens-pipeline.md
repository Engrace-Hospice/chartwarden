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

## F-237 — the review screen, stage 5, SUD detection, and the server-side licence check (2026-10-03)

*What.* The four DocLens items F-236 left open. (1) **The licence check is the server's.** Route 20's
`extraction_reviewer_eligible` read the candidate's risk tier from `?riskLevel=` (and bulk approve read
`?anyHighRisk=`), so a browser that sent `low` for a medication let an unlicensed reviewer decide it. The
predicates now load the tier from the candidate row, constrained to the review's own batch (a stranger id
is denied); the discrepancy route resolves its candidate through the discrepancy, never a body field; the
services re-check batch ownership (404) on decide and bulk approve. (2) **Stage 5.** High- and
medium-risk values (medications, allergies, legal name, DOB) are re-read by a vision model from a crop of
their Docling box rendered by the docling-worker's new `/render`; the model is **never shown the extracted
value** — M22 compares the reading (alphanumerics) and stores `vision_verified`, or the reading
DEK-encrypted in `vision_disagreement`, or neither (unverified, said out loud). List fields read every
visible entry and verify membership (Docling often returns a whole list as one block, so a crop cannot
isolate a line — the first E2E run read the neighbouring medication). M32 gained image support end to end
(`ModelBackendCompletionRequest.images`, Ollama `images`, Anthropic image blocks; a request with images
requires the `vision` modality at routing; the ledger records image SHA-256s, never bytes) and a local
vision route, `local-qwen2.5-vl-7b-instruct` (ADR-0048 amendment). Approving a disagreed value unchanged
needs a reason (422). (3) **SUD detection (§7.4 W4 / D8).** A deterministic, high-recall rule set
(`sud-detection/flagger.ts`: MAT drugs, ICD-10 F10–F19 minus tobacco per 42 CFR §2.11, disorder/withdrawal
wording, substance-use history, treatment settings; negation suppresses wording, never a medication) runs
on every page whatever the AI posture, plus the governed `doclens_sud_detect` model pass whose quotes are
grounded before they count. Candidates on indicator pages are tagged; evidence is stored only as
ciphertext; `m22.intake.sud_detected` (ids only) is published atomically with completion; M5's new
`m5.m22-intake-sud-privacy` consumer adds an interim `sud` flag (migration 0308 `sud_flag_origin`), promotes
it on confirm, and retires it on a false-positive rejection **only if DocLens put it there**. Completion is
409 while SUD is unresolved; resolution needs RN-or-above and, for a rejection, a reason; after a rejection
SUD-page contact fields become committable. (4) **The review screen** (`/intake` queue,
`/intake/:batchId/review` workspace): page images with every value's box, per-field accept / edit / reject
behind a per-field source-view confirmation, stage-5 and SUD chips, the W4 banner, bulk approve of eligible
low-risk fields, and a completion dialog showing what will and will not reach the chart. Server half:
`GET /intake/uploads`, `GET …/:id/workspace` (decrypted, read-audited), `GET …/:id/pages/:page/image`,
`POST …/:id/sud-review`. Decisions can now be revised (upsert, audited). Also fixed: `decisions:bulk-approve`
was registered unescaped, so find-my-way read `:bulk` as a parameter (the route matched
`decisions<anything>-approve`); it is `decisions::bulk-approve` now and the OpenAPI emitter understands `::`.

*Not built.* Discrepancy detection (stage 6) and its drawer; reclassification and the fax splitter; an
intake upload UI (batches are still created by API); writeback beyond M5 contacts. Boxes are Docling
block-level: when Docling merges a list into one block every entry shares the list's box. The Claude path
is wired (including images) but untested against the real API.

*Verification.* Real local models on the Docker stack (llama3.1 8B + qwen2.5-vl 7B on host Ollama), a
synthetic fax with methadone and heroin history: rules + model flagged page 2 → M5 interim flag →
workspace/queue/page image over HTTP → 422 on an unchanged disagreed approval → 409 completing with SUD
unresolved → 422 rejecting without reason → rejection retired the flag → completion wrote only the 8
contact fields. Stage 5 verified name, DOB, allergy and two medications and correctly flagged an
OCR-damaged lorazepam line. Tests: `f237-sud-flagger` (20), `f237-doclens-stage5-sud` (24),
`document-routes` (+5, the `?riskLevel=low` bypass now 403), docling-worker pytest (+9), web DOM (7), and
the live suite `test:f237:doclens-review:live` (4) plus the F-235/F-236/M22/M5/M32/M39/dispatcher live
suites. Mutation checks (each reverted, each caught): licence bypass on high risk, planner ignoring SUD,
rejection lifting a consent-derived flag, images not routed to a vision backend.
