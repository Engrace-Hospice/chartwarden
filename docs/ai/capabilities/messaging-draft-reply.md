# Capability - Messaging Draft Reply

## Purpose
Offers a member of a secure-messaging conversation up to two draft replies to the part of the conversation they can read. A draft is returned to the browser and placed in the composer only when the member clicks "Copy to draft"; the member edits it and sends it through the normal send path as themselves. M36 never writes the draft to the message store or the drafts store, never queues it and never sends it. A draft never includes attachments, mentions or orders.

## Risk Classification
High, with the same input and the same failure mode as `messaging_summarize` (a draft that states a dose or a plan the author did not intend, sent by a tired reader). Proposed by ADR-0095; awaits clinical-lead and compliance sign-off. Whether drafts are in scope for general availability at all, or only summaries first, is an open decision (ADR-0095 open decision 9).

## Architecture
Same boundary as `docs/ai/capabilities/messaging-summarize.md`: M36 minimises and pseudonymises in code, M32 receives text and returns text through the `MessagingAiPort`. Registered as capability key `messaging_draft_reply` with `defaultBackendKey: null`. Prompt: `packages/ai-platform/prompts/messaging/draft_reply.v1.md` (not registered in `ai_prompt_template`).

## Lifecycle
State: PROPOSED. Disabled by default and unreachable: no template, no backend. Same advancement conditions as the summary capability, evaluated separately.

## Controls
Kill switch: an `ai_kill_switch_state` row for capability_key `messaging_draft_reply`, platform-wide or per tenant. A draft is refused (not shown) when it states a dose, an order or a diagnosis. Offered only where the caller could post anyway (membership, Part 2 gate, not archived). The M32 pipeline has no tool or function calling, and the M36 AI folder imports nothing that can send, order or write (`arch:ai-messaging-readonly`). Human decision recorded on the `ai_invocation` row. Per-user rate limit. Default off per tenant.
