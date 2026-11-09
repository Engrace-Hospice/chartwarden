# BIL-2.0 — Claim Submission Workflow Audit

**Baseline:** `origin/develop` at `19b388c123fe543105a23bd09ed84a90c601304c`, fetched 2026-11-07. The local `develop` was 53 commits ahead and coincided with `origin/main`; its ahead-only work was excluded from the audit reference. BIL-1 commits `756c164d2` (BIL-1.3), `47cd1aaba`/`2ea823a19` (BIL-1.4), and `73b4538fb` (BIL-1.5A/B) are ancestors of `origin/develop`; migrations 1354–1361 are present. No BIL-1 dependency is missing from the remote development baseline.

## Executive summary

WardenX already contains meaningful claim-preparation, validation, transmission, response/history, and remittance integration in all three billing modules. BIL-2 should complete edges and provider-specific readiness, not replace these systems.

- **M23 Medicare hospice:** mature server-authoritative claim assembly, rule validation, 837I rendering, durable attempts, correction/void model, acknowledgments and history. The most concrete route risk is payer identity resolution for Claim.MD: `clearinghouse-context.ts` falls back to the MAC jurisdiction string as `payerId`, while a single optional environment override is global. This is configuration-sensitive and requires a payer-route contract test before claiming correct Claim.MD routing. Claim.MD notice upload remains separately disabled/unverified; it is not ordinary claim submission.
- **M41 commercial:** a complete internal assembly/validation/send-gate/queue/send/reconcile/timeline vertical slice exists, including immutable Claim.MD evidence and acknowledgment integration. A concrete workflow gap is no replacement-claim workflow after a payer has received a claim; `void` correctly refuses to act as a payer-side void, and there is no replacement endpoint/model in the M41 route surface. Payer-specific readiness and test-account outcomes remain external certification items.
- **M24 Medicaid:** state-specific claim, validation, submission, polling, correction, acknowledgment, and history machinery exists. Electronic route availability is intentionally narrow: Oregon is the reference adapter but its gateway contract is explicitly a modeled JSON REST envelope and its actual OHA/CCO endpoint/certification is external; WA/ID/CA/NV are deny-stubs. Medicaid must not be redirected through Claim.MD by default.
- **Frontend:** separate module workbenches and detail/timeline screens already expose assembly, validation and status/history. BIL-2 should improve task completion around blocked payer routes, actionable field errors and corrections, while preserving BIL-5's broader workspace scope.

## High-confidence verdict

**GO for BIL-2.1 implementation planning and a narrowly scoped first vertical slice.** The baseline is complete enough, and the internal claim domains are present. Before any live route is presented as generally available, validate the M23 Claim.MD payer mapping and keep unsupported M24 state routes fail-closed. No external certification or new worker activation is authorized by this audit.

## Priority findings

| ID | Priority | Finding | Evidence |
|---|---|---|---|
| BIL20-001 | P1 | M23 Claim.MD payer identity can fall back to MAC jurisdiction; one global override cannot establish correct per-route mapping across all provider entities/MACs. | [clearinghouse-context.ts](../../../apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-context.ts#L12) lines 12–25, 40–78 |
| BIL20-002 | P1 | M41 lacks a payer-side replacement/correction claim workflow after a claim is sent; the existing local void endpoint intentionally refuses sent claims. | [commercial-billing.routes.ts](../../../apps/backend/src/modules/41-billing-commercial/routes/commercial-billing.routes.ts#L248) lines 248–301; [claim-lifecycle.ts](../../../apps/backend/src/modules/41-billing-commercial/services/claim-lifecycle.ts#L328) lines 328–350 |
| BIL20-003 | P1 | M24's Oregon electronic adapter is not proof of production interoperability: its payload is a WardenX JSON envelope, and the source explicitly records endpoint/trading-partner certification as pending. | [oregon/launch-gateway.ts](../../../packages/medicaid-adapters/src/oregon/launch-gateway.ts#L7) lines 7–17, 147–165; [oregon/index.ts](../../../packages/medicaid-adapters/src/oregon/index.ts#L2) lines 2–13 |
| BIL20-004 | P1 | State coverage is intentionally incomplete: four named states use deny-stubs; every other unregistered state is refused. | [deny-stub-states.ts](../../../packages/medicaid-adapters/src/deny-stub-states.ts#L1) lines 1–14; [registry.ts](../../../packages/medicaid-adapters/src/registry.ts#L53) lines 53–77 |
| BIL20-005 | P2 | Operator workflow is split among module-specific queues and status models; BIL-2 should unify task discovery and explain blockers without flattening payer-specific rules. | Frontend inventories in [FRONTEND_UX_FINDINGS.md](./FRONTEND_UX_FINDINGS.md) |

## What this audit does not certify

Static source and existing tests are not a live runtime certification. The earlier sandbox run proves an initial Claim.MD test-account exchange for two synthetic claims and three matching responses only. It does not establish payer acceptance, Medicare/MAC routing, complete 835/ERA handling, commercial payer enrollment, production behavior, or M24 state gateway certification. See [INTEGRATION_DEPENDENCIES.md](./INTEGRATION_DEPENDENCIES.md).

## Documents

- [Current workflow maps](./CURRENT_WORKFLOWS.md)
- [Completeness matrix](./FEATURE_COMPLETENESS_MATRIX.md)
- [Medicare findings](./MEDICARE_GAPS.md)
- [Commercial findings](./COMMERCIAL_GAPS.md)
- [Medicaid findings](./MEDICAID_GAPS.md)
- [Frontend findings](./FRONTEND_UX_FINDINGS.md)
- [Dependencies](./INTEGRATION_DEPENDENCIES.md)
- [Roadmap](./IMPLEMENTATION_ROADMAP.md)
- [Test strategy](./TEST_STRATEGY.md)
- [BIL-2.1 readiness](./NEXT_PHASE_READINESS.md)
