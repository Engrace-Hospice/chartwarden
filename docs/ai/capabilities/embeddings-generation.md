# Capability - Embeddings Generation

## Purpose
Generates embeddings that support semantic retrieval.

## Risk Classification
Low. This is operational infrastructure, but inputs can contain PHI depending on the source corpus.

## Architecture
Module 32 AI Platform.

## Lifecycle
State: PROPOSED. Disabled by default until M32 governance and storage controls land.

## Controls
Kill switch: activate an `ai_kill_switch_state` row for capability_key `embeddings_clinical` — platform-wide (`organization_id IS NULL`) or for one tenant. The platform row and a tenant row OR together: neither overrides the other, so lifting one does not resume a capability the other still stops. PHI minimization, approved model/provider posture, audit events, drift monitoring, and deterministic search fallback are required before activation.
