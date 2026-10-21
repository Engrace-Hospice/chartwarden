# DevOps, Observability, and Operations

## OPS-001 - Deployment workflow does not deploy or validate a release

- Severity: High
- Priority: P1
- Confidence: Confirmed
- Category: Deployment
- Production blocker: Yes
- Affected workflow: Release and rollback
- Affected persona: Operator, all users
- Evidence: Workflow header calls itself a skeleton; build runs, optional manual job only pushes GHCR; no target, environment reviewer/branch rules, rollout, migration, health validation, rollback, signature, or SBOM.
- File(s): `.github/workflows/deploy.yml:3-12,29-85`; `Dockerfile:1-20`
- Symbol(s): Deploy workflow
- Description: A reproducible image exists, but there is no production deployment process.
- Root cause: Runtime scaffold landed before infrastructure target and release governance.
- User impact: No supported safe launch/update/recovery path.
- Technical impact: Manual environment drift and untested rollback.
- Security or data impact: Missing artifact provenance/approval increases supply-chain and change-control risk.
- Recommended remediation: Define immutable target, protected environment approvals, artifact attestations/SBOM/signing, preflight migration, phased rollout, smoke/readiness, automated abort, and tested rollback.
- Tests required: Staging deploy from clean SHA, migration, API/worker health, smoke, rollback, active-job deploy.
- Dependencies: Infrastructure choice and secret manager.
- Acceptance criteria: A protected pipeline deploys a SHA-pinned artifact and proves health/rollback without manual host mutation.

## OPS-002 - Backup and recovery evidence is not production-real

- Severity: High
- Priority: P1
- Confidence: High confidence
- Category: Disaster recovery
- Production blocker: Yes
- Affected workflow: Data recovery and tenant isolation after restore
- Affected persona: Operator, all tenants
- Evidence: DR documentation admits restored-schema RLS smoke is not implemented; local compose explicitly provides no HA/backups. No real backup artifact, offsite policy, restore duration, object version recovery, or queue reconciliation evidence was available.
- File(s): `docs/architecture/CHARTWARDEN_DR_BCP_v0.1.md:764-766`; `docker-compose.yml:1-7`
- Symbol(s): DR drill process
- Description: Runbooks and synthetic scripts do not prove recoverability of PostgreSQL, MinIO versions, Valkey/job state, and secrets together.
- Root cause: No production target or scheduled evidence-producing drill.
- User impact: Recovery time/data loss is unknown.
- Technical impact: RPO/RTO, post-restore migrations, and in-flight job reconciliation are unverified.
- Security or data impact: Restore could weaken tenant isolation or omit required records.
- Recommended remediation: Automated encrypted backup plus isolated restore drill; run migrations, full RLS/auth smoke, object checks, outbox/queue reconciliation, and record measured RPO/RTO.
- Tests required: Corrupt/partial backup, missing object version, rotated key, active job, rollback release.
- Dependencies: Production storage/KMS/topology.
- Acceptance criteria: Latest production-shaped backup restores within approved objectives and passes security/data checks.

## OPS-003 - Environment template cannot configure a production process

- Severity: Medium
- Priority: P1
- Confidence: Confirmed
- Category: Configuration
- Production blocker: Conditional
- Affected workflow: Deployment boot
- Affected persona: Operator
- Evidence: `.env.example` lists a small Phase-0 set and omits most production-required variables in `bootstrap/env.ts`, including platform DB, encryption keys, RP IDs, cursor key, proxy CIDRs, and internal token.
- File(s): `.env.example:1-26`; `apps/backend/src/bootstrap/env.ts:27-125`
- Symbol(s): `REQUIREMENTS`, `assertProductionEnv`
- Description: Production correctly fails closed, but the documented template does not tell an operator how to satisfy it.
- Root cause: Env documentation was not generated from the validation schema.
- User impact: Deployment fails or is configured ad hoc.
- Technical impact: Environment drift and secret-rotation uncertainty.
- Security or data impact: Operators may choose unsafe placeholder values outside a managed secret workflow.
- Recommended remediation: Generate a redacted environment reference with purpose, format, owner, rotation, API/worker scope, and secret-manager source.
- Tests required: Production-env contract test against deployment manifests.
- Dependencies: OPS-001.
- Acceptance criteria: Every required variable is supplied by deployment configuration and documented without a secret value.

## OPS-004 - Metrics exist, but end-to-end tracing and alert delivery are unproven

- Severity: Medium
- Priority: P2
- Confidence: Confirmed
- Category: Observability
- Production blocker: No for pilot; Yes for scale
- Affected workflow: Incident response and provider diagnosis
- Affected persona: Operator/support
- Evidence: Prometheus metrics, health/readiness, request ids, PHI-safe logs, queue metrics, and DLQ hooks exist. No OpenTelemetry exporter/trace pipeline, deployed dashboards/alert rules, or external alert-delivery exercise was found.
- File(s): backend bootstrap metrics/readiness/logger modules; worker/DLQ composition in `apps/backend/src/index.ts:2493-2501,2882-2888`
- Symbol(s): metrics registry, readiness probe, DLQ promotion sink
- Description: Operators can inspect local metrics/logs but cannot yet prove cross-service/provider causal traces or alert receipt.
- Root cause: Instrumentation primitives landed before production operations integration.
- User impact: Longer incident diagnosis and unclear affected tenant/workflow.
- Technical impact: No verified SLO/error-budget or provider-specific latency/cost view.
- Security or data impact: Trace attribute policy must avoid PHI when added.
- Recommended remediation: Add W3C trace propagation, provider/queue spans, PHI-safe attributes, deployed dashboards/alerts, and alert tests.
- Tests required: Synthetic provider failure, stuck queue, outbox depth, high latency, alert delivery, trace reconstruction.
- Dependencies: OPS-001 target and monitoring stack.
- Acceptance criteria: Operator can answer health, dependency, tenant/workflow impact, deployment, stuck job, latency/error/cost, and safe-retry questions from production telemetry.

## PERF-001 - Frontend artifact policy and performance budgets are absent

- Severity: Medium
- Priority: P3
- Confidence: Confirmed configuration; performance impact unmeasured
- Category: Performance / information exposure
- Production blocker: No
- Affected workflow: Initial load, field connectivity, incident/source disclosure
- Affected persona: All SPA users
- Evidence: All Vite configs set `sourcemap: true`. Staff main is 442 kB raw/135 kB gzip; portal 289/92 kB; admin 305/94 kB. Portal/admin builds emitted one main JS chunk.
- File(s): `apps/web/vite.config.ts:20`; `apps/portal/vite.config.ts:18`; `apps/admin/vite.config.ts:19`
- Symbol(s): Vite build config
- Description: Public source maps may expose source details; no route/initial-load budget prevents growth.
- Root cause: Debug-oriented production defaults and no bundle gate.
- User impact: Slower startup on constrained field networks as code grows.
- Technical impact: No regression threshold.
- Security or data impact: Source maps are not secrets but improve attacker code visibility if publicly served.
- Recommended remediation: Upload private maps to error monitoring or restrict access; add initial/route bundle and Web Vitals budgets; lazy-load portal/admin by route where useful.
- Tests required: Artifact access policy, bundle report, mobile throttling, offline/reconnect.
- Dependencies: Error-monitoring choice.
- Acceptance criteria: Source-map policy is explicit and performance budgets gate regressions.

## OPS-005 - Local MinIO image is floating

- Severity: Low
- Priority: P3
- Confidence: Confirmed
- Category: Reproducibility
- Production blocker: No
- Affected workflow: Local/CI object-store behavior
- Affected persona: Engineering
- Evidence: `docker-compose.yml:49-51` uses `minio/minio:latest`.
- File(s): `docker-compose.yml`
- Symbol(s): MinIO service image
- Description: Clean-clone behavior can change without a repository diff.
- Root cause: Convenience tag in local stack.
- User impact: None directly.
- Technical impact: Non-reproducible integration tests.
- Security or data impact: Unexpected upstream changes.
- Recommended remediation: Pin a tested version/digest and schedule updates.
- Tests required: Compose boot and S3 integration.
- Dependencies: None.
- Acceptance criteria: All runtime images are immutable in CI/release manifests.

## Operational Readiness Summary

| Capability | State |
|---|---|
| Structured PHI-safe logs | Implemented |
| Request/correlation ids | Implemented |
| Health/readiness | Implemented; workload capability detail missing |
| Metrics/queue depth/DLQ hooks | Implemented locally |
| Distributed traces | Not implemented/verified |
| Alert delivery/dashboards | Not verified |
| Deployment promotion/rollback | Not implemented |
| Backup/restore proof | Not verified |
| Production secrets/config reference | Incomplete |
| AI provider cost monitoring | Not applicable until provider live; required before enablement |
