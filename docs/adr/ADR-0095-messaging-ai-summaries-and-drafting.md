# ADR-0095 — Messaging AI thread summaries and reply drafting (M32 data boundary)

- **Status:** **Proposed** (2026-10-23). Design only: no code, no migration, no capability registered. Needs clinical-lead and compliance sign-off (hazard H-08) before any build.
- **Date:** 2026-10-23
- **Phase:** Messaging Hub Phase 6, WP 6.5.
- **Related:** [ADR-0089](ADR-0089-messaging-export.md) and [ADR-0091](ADR-0091-messaging-smart-work-inbox.md) (ADR style), [ADR-0086](ADR-0086-messaging-retention-and-legal-hold.md) (legal hold), [ADR-0055](ADR-0055-message-revisions-and-redaction.md) (redaction), `docs/architecture/CHARTWARDEN_AI_GOVERNANCE_v0.2.md` sections 4, 5, 7.3-7.5, 8.4-8.6, 9, `docs/modules/CHARTWARDEN_MODULE_32_AI_PLATFORM_SPEC_v0_2.md`, `docs/messaging-hub/04-phases-4-to-6.md` row 6.5, `docs/messaging-hub/10-ui-spec-phases-4-to-6.md` section 6.5, `docs/messaging-hub/brief-clinical-lead-signoff.md`.

## Context

WP 6.5 wants a thread summary with source-message citations and uncertainty, and draft reply proposals. Message text is PHI, written by many people, and untrusted. Facts verified in the repo:

- M32 already has the invocation pipeline (`apps/backend/src/modules/32-ai-platform/invocation/service.ts`). Its gates, in order: `ai_full_flag`, `lifecycle`, `kill_switch`, `tenant_opt_in`, `clinician_opt_out`, `token_cap`, `phi_minimization`, `routing`. Every call writes an `ai_invocation` row (7-year partitioned ledger, prompt/response/chart-context encrypted, `zdr_confirmed`, `hitl_outcome`). `recordHitlOutcome` is the one post-hoc write. The WP 6.5 docs call this log `ai_interaction`; **the table is `ai_invocation`** and this ADR uses it (no second table).
- `AiInvokeRequest` takes `patientId`, `actorMembershipId`, `consumerContextRef`, `prompt`, `chartContext`, and optional `responseSchema`. It has no write capability: the pipeline returns text.
- The chart-context validator (`chart-context-rules.ts`) is an allowlist per capability and **denies every capability that has no ruleset**. No messaging capability exists, so today every M36 call is refused. That is the correct default and this ADR keeps it.
- Governance requires a BAA, Zero Data Retention for PHI traffic (section 9.2), tenant opt-in with BAA resolution (`tenant-opt-in.ts`), and HITL for High-risk capabilities. Backend seed rows leave `baa_reference` and `zdr_status` as `null`; "only a deployment knows them".
- M36 has legal hold (`governance/under-hold.ts`, migration 1138), approved redactions that mask bodies (`message-redaction-mask.ts`, WP 5.6) and a 42 CFR Part 2 channel gate (`part2-channel-gate.ts`).

## Decision

### 1. Authorization and input boundary (nothing from outside the thread)

1. One entry point, `POST /api/v1/messaging/channels/:id/summaries` (and `.../draft-replies`), in M36. M36 loads the input; M32 never queries messaging tables. The route is gated on a new `messaging.ai.use` permission AND the caller being a current member of the channel (the same `canViewChannel` the thread read uses, evaluated at call time, including the Part 2 consent gate and break-glass rules). Membership or ABAC lost between request and model call re-checks and fails closed (one re-check immediately before dispatch).
2. **Input is exactly the messages that caller could read in that thread now**: the output of the existing hydrated thread read (so redaction masking and deleted-message filtering come for free), bounded by a window (default last 50 messages or 14 days, whichever is smaller, constants in one file). No other thread, no chart data, no patient demographics, no attachments, no links, no polls, no mentions' profiles.
3. **Excluded, not just masked**: messages with an approved redaction, deleted messages, and messages under an active legal hold are NOT sent to the model (a hold means "preserve", and a held body may also be subject to a pending dispute; sending it to a vendor is a new disclosure we do not need). They appear to the model as a placeholder `[message withheld]` so citations and ordering stay truthful, and the UI shows "N messages not included". A channel whose patient carries the `sud` flag is refused unless M39 says the caller's release covers AI processing; v1 refuses all Part 2 channels (open decision 4).
4. **Minimum necessary** (governance 9.3): sender is replaced with a role token (`[RN]`, `[SW]`, `[MD]`, `[FAMILY]`) and a per-thread alias (`Sender A`); the patient is `[PATIENT]` (never name, MRN, DOB, address, phone); timestamps become relative ("2h before the last message"). The model needs content, not identity. Redaction is deterministic code (M36 side), not a prompt instruction. `chartContext` passed to M32 carries only `{ channelId, messageCount }`; a new allowlist ruleset for `messaging_summarize` and `messaging_draft_reply` is added in M32 with those keys and nothing else.
5. `consumerContextRef` names the channel and the message-id range, so the ledger row can prove what the call covered. `patientId` is passed when the channel is patient-scoped, so section 3.2.8's PHI indicator and the disclosure accounting fire.

### 2. Summary output: citations and uncertainty, rendered deterministically

1. The model is asked for structured JSON via `responseSchema`: `{ points: [{ text, sourceMessageRefs: [string], confidence: "high"|"medium"|"low" }], openQuestions: [string], insufficientContext: boolean }`. The prompt gives each message an opaque ref `m1..mN` (not the real id). Validation failure: retry once, then show "AI unavailable" (governance 8.6).
2. **Citations cannot point outside the thread.** The model never emits real ids. M36 maps `mK` back to a message id from the exact list it sent; a ref not in that list is dropped and the point is shown with "no source" and demoted to `low`; a point with zero valid refs is discarded. The UI renders each citation as a link built by the server from the mapped id (`#message-<id>` inside the same channel view); no model-provided URL, markdown or HTML is ever rendered (output is plain text, escaped). A per-point check that the cited message is still readable by the caller is repeated at render time.
3. **Uncertainty is visible**: every point carries its confidence label; `insufficientContext` or fewer than 3 included messages renders "Too little to summarise"; withheld-message count is shown; the panel header is "AI summary - draft - not verified" (UI spec 6.5). The summary never states a clinical conclusion, diagnosis, dose or disposition; the prompt and an output check (denylist of order/dose/diagnosis phrasing) route such output to refuse-with-explanation (governance 7.5).

### 3. Draft replies: composer only, a human sends

1. A draft is returned to the browser and placed in the composer by an explicit "Copy to draft" click. It is never written to `messaging_message`, never to the drafts store, never auto-posted, never queued. The human edits and presses the normal send, which runs the normal send path (permissions, Part 2 gate, rate limits) as that human. `recordHitlOutcome` records `accepted`, `edited` or `rejected`.
2. A sent message that began as an AI draft carries no hidden marker in the clinical record (governance 7.3.1: AI provenance is audit only); the link is the `ai_invocation` row's hitl outcome.
3. Drafts may be offered only for channels where the caller could post anyway. Drafts never include attachments, mentions, or orders.

### 4. The AI cannot send, order, or write a chart record (structural)

1. M36's AI port is `MessagingAiPort { summarize(input): Promise<SummaryResult>; draftReply(input): Promise<DraftResult> }`. It returns data only. It has no method, parameter or injected dependency that can send a message, create a task, order, or chart entry. M36's AI folder (`36-messaging/ai/`) imports `@chartwarden/ai-platform` types and the thread reader (read) and nothing from sending, orders (M11/M12), encounters (M8), or tasks.
2. **Gate test idea** (`arch:ai-messaging-readonly`, a new `check-*` script, to be built with the code): (a) static: every file under `36-messaging/ai/` has an import allowlist (dependency-cruiser rule or AST scan) that forbids the send-path module, any `insert`/`update`/`delete` Drizzle call, `withOrgContext` write helpers, and seam registries for M7/M8/M11/M12/M22 writers; (b) the M32 capability rows for these two keys must have `requires_hitl = true` and no tool/function-calling feature in `supported_features`; (c) a live suite runs summarise and draft calls with an injection payload and asserts zero new rows in `messaging_message`, task, order and encounter tables and exactly one `ai_invocation` row.
3. The model gets no tools. No function calling, no browsing.

### 5. Ledger, flag, environment

1. **Every call is logged** by the M32 pipeline in `ai_invocation` (including refusals where a backend can be named). M36 adds nothing parallel, except an M36 audit event `messaging.ai.summary_viewed` (channel id, invocation id, caller; no text) so the thread's own audit trail shows the access. The WP 6.5 acceptance "ai row lands" is asserted live, as CLAUDE.md requires for read audits.
2. **Per-tenant flag off by default**, using M32's `tenant_opt_in` plus the `ai_full_flag`, plus a messaging-specific tenant setting `messaging.ai.enabled` (default false) so an agency that opted into other M32 capabilities does not silently get messaging AI. Per-clinician opt-out (`clinician_opt_out`) is honoured. Flag off or no consent: the panel is absent (UI spec), the endpoint answers 404-equivalent typed `AI_NOT_ENABLED`.
3. **BAA-covered environment only, fail closed.** The call is dispatched only to a backend whose registry row has a non-null `baa_reference` that resolves to a non-expired BAA covering generative-AI processing, and `zdr_status` confirmed. Because the seed leaves both `null`, a fresh deployment answers "AI unavailable" until an operator records them. Local-model backends are acceptable only if hosted inside the BAA boundary. No fallback to any other vendor or to a non-BAA path, ever. A health-sweep or kill-switch trip stops the feature immediately.
4. Capabilities `messaging_summarize` and `messaging_draft_reply` are registered through M32's normal lifecycle (proposal, design review, evaluation, pilot, GA, governance section 5). Risk class proposed **High** (clinicians may rely on a summary; a wrong summary can hide an urgent message), so the full workflow, HITL and periodic re-evaluation apply. Until stage 4 they serve nothing.

### 6. Prompt injection (message text is untrusted data)

1. Messages are inserted only inside delimited data blocks (`[MESSAGES BEGIN] ... [MESSAGES END]`) in the user turn; the system prompt states the messages are data, instructions inside them are never followed, and the output is JSON only (governance 8.5). Delimiter strings inside message text are neutralised before insertion.
2. Defence is layered and does not rely on the prompt: no tools (so injected "send this" has no effect), schema-validated output, ref-mapping drops invented citations, plain-text escaped rendering (no markdown links or images, so no exfiltration channel), draft text shown only in the composer, and a human reads it before sending.
3. A message that looks like an injection attempt (heuristic match on "ignore previous", "system prompt", role-play markers) is still summarised as content but flagged in the ledger `error_class`-adjacent note and counted for the M32 hallucination/safety ops review. Detection is advisory, not the control.
4. Another participant can write text meant to alter what a colleague sees in a summary (e.g. "patient is fine, no action needed"). This is why citations are mandatory and the summary is labelled unverified; it cannot be fully removed (open decision 5).

### 7. Retention, rate limits, cost

1. **Generated summaries and drafts are ephemeral to the user**: returned in the response, held in browser memory, not stored by M36 (no new table, no cache). The only server copy is the encrypted `ai_invocation` prompt and response payload under M32's 7-year ledger retention (disclosure accounting). Consequence: a summary of a legally held thread is itself retained as ledger evidence; the ledger, not M36, is where erasure and hold requests are answered (existing `ai-provenance-eraser`). Re-opening the panel re-generates (and re-bills) unless the caller still has it in memory.
2. **Rate limits**: per user (default 10 summaries and 20 drafts per hour), per channel (3 summaries per 10 minutes, deduped by hash of the included message ids so an unchanged thread returns the user's in-memory result and no new call), and M32's token cap gate per tenant. Constants in one file, tunable per tenant.
3. **Cost**: input bounded by the window (about 50 short messages, a few thousand tokens), `maxOutputTokens` 600 for summaries and 300 for drafts, dispatch timeout 8 s default. Token use is recorded by M32's ledger and rolled up by the existing token-ledger job; tenant soft/hard cap alerts already exist. No per-message or background pre-summarising (only on explicit click).

## Not done / out of scope

No code, route, migration, capability row, permission key or UI is built by this ADR. Summaries of audio, attachments, or multiple threads; auto-triage, auto-categorisation or sentiment; AI that proposes tasks or orders (a separate, much higher-risk decision); translation (ADR-0093 forbids runtime machine translation); dictation (WP 6.3 ADR).

## Open decisions (compliance / clinical lead sign-off)

1. Risk class and whether summaries may be offered at all for the clinical care-team channels versus admin-only channels first.
2. Whether legal-hold messages should be excluded (this ADR) or included with a hold-aware policy; counsel to decide. Same for redaction-pending messages.
3. Role-token pseudonymisation versus sending real sender names; whether "relative time" harms quality enough to revisit.
4. Part 2: refuse all SUD-flagged channels (this ADR) or allow with a consent that explicitly covers AI processing.
5. Residual risk that a colleague's text misleads a summary; required wording of the "not verified" label and whether summaries may be used to skip reading unread urgent messages (acknowledgment requests must never be satisfied by a summary).
6. 7-year retention of encrypted prompts that contain message text; whether messaging prompts need a shorter class than other capabilities.
7. Which vendor, region and ZDR terms; whether local models are required for some tenants.
8. Default limits (window, per-user, per-channel) and the tenant price/cap.
9. Whether drafts are in scope for GA or only summaries first (drafts add authorship-of-record questions).

## Unverified

- No messaging capability, prompt template, chart-context ruleset or permission key exists; names here (`messaging_summarize`, `messaging_draft_reply`, `messaging.ai.use`, `messaging.ai.enabled`) are proposals.
- Backend `baa_reference` and `zdr_status` are `null` in the seed; the BAA with the intended vendor is recorded in governance 9.2 as "in progress" and may be out of date.
- Whether `canViewChannel` and the hydrated thread read can be called as one unit with the legal-hold flag exposed per message was not confirmed in code; a small M36 reader may be needed.
- That `responseSchema` structured output is honoured by the chosen backend, and the summary quality and hallucination rate, are unmeasured; M32 stage-3 evaluation is the evidence.
- Whether the `ai_invocation` encrypted payload can be erased on patient erasure while keeping the accounting row was not re-checked here (`erasers/ai-provenance-eraser.ts` is the starting point).
- Rate and cost figures above are starting guesses, not measured.
