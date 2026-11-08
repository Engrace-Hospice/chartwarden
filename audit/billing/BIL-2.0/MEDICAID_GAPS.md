# M24 — Medicaid Billing Findings

## Existing capability

M24 owns state Medicaid claim/eligibility/submission and keeps a pluggable state adapter interface. Claims are attributed to organization, provider entity, patient, coverage and service state; control numbers are state-namespaced. Assembly resolves Medicaid coverage over the entire service window, active provider trading partner, state plan code and CCN, then derives hospice/R&B lines from owner seams ([write-service-drizzle.ts](../../../apps/backend/src/modules/24-billing-medicaid/routes/write-service-drizzle.ts#L420)). Validation, submit, replace, void and abandon operations have route/service contracts. The submission worker interprets adapter results as synchronous accepted/rejected or pending async, polls where appropriate and writes state/history/outbox ([submission-jobs.ts](../../../apps/backend/src/modules/24-billing-medicaid/jobs/submission-jobs.ts#L166)). M25 uses the published claim-match seam; it does not imply that Medicaid remittance can be routed through Claim.MD.

## State support as implemented

| State | Repository status | Notes |
|---|---|---|
| Oregon | Reference adapter (`oregon-oha-direct`), gateway injection and modeled sync contract | No verified live OHA MMIS/CCO endpoint or trading-partner certification in source evidence. Without gateway/credentials, I/O fails closed. |
| Washington | Deny-stub | No electronic claim/eligibility/ack implementation. |
| Idaho | Deny-stub | No electronic claim/eligibility/ack implementation. |
| California | Deny-stub | No electronic claim/eligibility/ack implementation. |
| Nevada | Deny-stub | No electronic claim/eligibility/ack implementation. |
| Other states | No registered adapter | Registry refuses the route. |

Sources: [registry.ts](../../../packages/medicaid-adapters/src/registry.ts#L25), [deny-stub-states.ts](../../../packages/medicaid-adapters/src/deny-stub-states.ts#L1), [oregon/index.ts](../../../packages/medicaid-adapters/src/oregon/index.ts#L2).

## Findings

### M24-1 — Oregon payload is a modeled JSON envelope, not a certified X12/state protocol (P1 external dependency)

The adapter source explicitly states that Oregon's wire I/O is represented as JSON REST and that it is not raw 837I generation; `assembleOregonSubmissionPayload` serializes a `chartwarden.oregon-direct-mmis.v1` JSON object. The source also says real per-tenant OHA/CCO endpoint and trading-partner certification is external-sandbox pending ([launch-gateway.ts](../../../packages/medicaid-adapters/src/oregon/launch-gateway.ts#L7), lines 7–17 and 147–165; [oregon/index.ts](../../../packages/medicaid-adapters/src/oregon/index.ts#L7)). Treat this as an internal adapter exercise, not a production Oregon billing connection.

### M24-2 — State-specific readiness must be visible before assembly/send (P1 workflow gap)

The backend has `electronicSubmissionRefusal` and fails before enqueue when no state gateway is available ([registry.ts](../../../packages/medicaid-adapters/src/registry.ts#L85)). Ensure the UI shows state/channel support, credential status, adapter availability and manual-submit alternative before users complete a claim that cannot transmit. Do not weaken the backend refusal.

### M24-3 — Keep M24 direct/state workflows independent from Claim.MD (non-regression constraint)

M24 credential and adapter selection is per provider entity/state and may route direct MMIS, CCO clearinghouse, SFTP or portal per configuration. No source evidence establishes Claim.MD as a general Medicaid route. BIL-2 must not attach M23/M41 shared Claim.MD account defaults to M24.

### M24-4 — External payer policy and rate/catalog provenance (P1 external dependency)

State plan codes, rates, MCO assignments, EVV and R&B rules are effective-dated. Before enabling an additional state, require authoritative state/MCO companion guides, trading partner enrollment, supported transaction/channel, test response fixtures, and effective-dated catalog provenance. No generalized “all states” acceptance criterion is valid.

## Implementation boundary

BIL-2.4 should improve state support discoverability and readiness contracts; an actual new state adapter is a separate approved state-specific slice with authoritative requirements. First test OR's safe “gateway absent” path and a fixture gateway; do not make external calls during that phase.
