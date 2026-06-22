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
Kill switch: `ai.embeddings_generation_kill`. PHI minimization, approved model/provider posture, audit events, drift monitoring, and deterministic search fallback are required before activation.
