# Capability - Semantic Search

## Purpose
Embedding-based retrieval across chart, document, and message content.

## Risk Classification
Medium. Results are retrieval aids that users must verify.

## Architecture
Module 32 AI Platform with Module 22 document-search participation.

## Lifecycle
State: PROPOSED. Disabled by default until M32 governance and owner modules wire the search surfaces.

## Controls
Kill switch: activate an `ai_kill_switch_state` row for capability_key `semantic_search_chart` — platform-wide (`organization_id IS NULL`) or for one tenant. The platform row and a tenant row OR together: neither overrides the other, so lifting one does not resume a capability the other still stops. Deterministic keyword fallback, relevance evaluation, report-output path, audit events, and tenant opt-in are required before activation.
