# ADR-0116 — Medicaid ERA assessment writes use an isolated M25 evaluator

- **Status:** Accepted (2026-11-24)
- **Date:** 2026-11-24
- **Related:** issue #1075, ADR-0033, ADR-0110, migrations 1543–1544 and 1547–1549

## Context

A durable Medicaid ERA review contains derived financial observations. The shared `chartwarden_platform_login` can be used by several generic processes and has BYPASSRLS for unrelated platform work. L6C proved that granting it review-table writes allowed a direct SQL session to forge an evaluator-shaped assessment. Migration 1544 therefore removed every application and platform writer, leaving the legitimate review workflow unavailable.

## Decision

Medicaid ERA evaluation runs in a separate Bun process. The public API keeps authentication, request validation and tenant reads, but has no assessment-writer credential. It sends only a strictly validated operation reference over an internal network using a short-lived Ed25519 JWS that binds the operation, command-body digest, session, user, membership and organization. The evaluator verifies the signature and re-resolves the current session, active membership, permissions and provider reach before executing the existing L5 evaluator.

Only the evaluator receives `chartwarden_m25_evaluator_login`. That login is NOBYPASSRLS, inherits only the `chartwarden_m25_evaluator` carrier, and has narrowly scoped review/history DML plus source-row SELECT. The shared app and platform roles cannot assume it. Provisioning clears both roles held by the isolated logins and roles that might inherit from those logins. The writer credential is a mounted secret file and never enters the shared production environment file. The evaluator exposes evaluate, note and nonposting disposition commands only. It is not a database proxy and cannot represent payment posting.

Migration 1548 adds a separate source-reader login whose only stage access is through `m25_read_staged_claimmd_era(stage, organization, provider)`. The SQL function is tuple-scoped, not actor-bound: a holder of that credential could request ciphertext for a known valid tuple. It cannot read the staging tables directly or decrypt the result. Only the isolated evaluator receives this credential and the separate Claim.MD artifact keyring; API, generic platform workers and ordinary tenant SQL do not. The evaluator and its infrastructure remain trusted for this narrow source-read boundary.

`isolated_evaluator` means the assessment was derived and persisted through this process and database identity. It is not a cryptographic signature over the stored row and does not claim protection from the database owner, superuser, evaluator host administrator or compromise of the evaluator itself. Historical rows and history events remain `legacy_unverified`.

## Consequences

- The evaluator is disabled in the base Compose topology. An explicit overlay, role provisioning and separately mounted secrets are required to activate it: API-only private command key; evaluator-only public key, writer/app/source database URLs and Claim.MD keyring; and provisioner-only database login-password files.
- API and generic worker compromise does not disclose the writer credential. A compromised command signing key still cannot supply evaluator-owned facts, and current database authority is checked again at execution.
- Database owner and infrastructure administrators remain trusted. Claim.MD source capture, M24 submission evidence and M40 classification remain independent authoritative inputs; unresolved evidence produces a nonposting hold.
- The assessment records evidence observed during evaluation. A final reinspection under the review lock prevents a waiting stale evaluation from replacing a newer review, but upstream source, enrollment, payer or claim evidence is not locked through the restricted writer commit. A narrow change-after-reinspection window can leave a stale nonposting snapshot; re-evaluate before any future downstream use.
- Migration 1549 stores a deterministic fingerprint of the complete evaluator snapshot and its observation timestamp. API projections call this `point_in_time_nonposting`; it records what the evaluator observed and is not proof of current enrollment, active authorization, payer acceptance, or posting authority. Any future financial use still requires a fresh assessment and its own transaction-time authorization. The general platform SQL credential remains unable to write the review rows; a database owner or superuser can still change schema, disable triggers, or rewrite data and remains trusted.
- Stedi JSON is still unsupported by the raw X12 path. Medicaid submission, ERA retrieval, payment posting and claim-state transitions remain disabled.
