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
Kill switch: `ai.semantic_search_kill`. Deterministic keyword fallback, relevance evaluation, report-output path, audit events, and tenant opt-in are required before activation.
