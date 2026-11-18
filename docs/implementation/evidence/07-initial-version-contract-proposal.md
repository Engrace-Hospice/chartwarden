# Workflow 07 — Initial Version Contract Proposal

**Status:** ENDPOINT, ACTION PROJECTION, AND START/REOPEN UI IMPLEMENTED
**Prepared:** 2026-11-17
**Approved:** 2026-11-17
**Depends on:** `07-discipline-plans-current-state.md`

## Problem

`m6.admission.activated` creates aide, MSW, and spiritual plan roots, but it does not create a
`discipline_care_plan_version`. The current public routes can author plan-root goals, interventions, and
assessments and can finalize/sign a known version, but no public route opens the first draft version. IDG and
discharge consumers create their own special-purpose versions; they are not an initial-authoring contract.

The frontend must not manufacture a version id, sequence, status, signer set, or root transition.

## Recommended endpoint

```http
POST /api/v1/discipline-plans/{planId}/versions
Authorization: existing session
Idempotency-Key: required
If-Match: <current plan-root version>
Content-Type: application/json

{
  "kind": "initial" | "interim_revision",
  "reason": "optional non-PHI coded/display reason"
}
```

Successful response:

```json
{
  "versionId": "uuid",
  "planId": "uuid",
  "sequence": 1,
  "status": "draft",
  "kind": "initial",
  "createdAt": "instant",
  "version": 0
}
```

Use `201` when a version is created. A replay with the same idempotency intent returns the stored successful
response. The endpoint must never accept `idg_review` or `discharge`; those remain system/event-owned.

## Authorization and scope

- Permission: `discipline_plan.author` (existing key; no new grant by default).
- ABAC: enforce the same closed discipline-scope matrix from the server-loaded plan kind. The normal RN
  case-manager alias is accepted; the Clinical Supervisor override remains unavailable until its required
  documented-reason and RN re-sign workflow is implemented.
- Patient scope: use the same caseload/org-wide write decision and non-leaking lookup as current goal,
  intervention, assessment, and finalize writes.
- Tenant: execute under `withOrgContext`; every selection and insert remains organization-scoped and RLS
  forced.
- The route's hidden/non-leaking behavior must match existing plan writes. Navigation visibility is not an
  authorization control.

## Transition rules

| Root/current state | Requested kind | Result |
|---|---|---|
| `draft`, no version exists | `initial` | Create sequence 1 draft; root remains `draft` |
| `draft`, any version exists | `initial` | `409 VERSION_ALREADY_EXISTS` |
| `active`, no open version | `interim_revision` | Create next sequence draft; root transitions to `draft_revising` |
| `draft_revising`, open version exists | either | `409 OPEN_VERSION_EXISTS`, returning no PHI-rich body |
| `discharged` | either | typed illegal-transition conflict |
| any state | `idg_review` or `discharge` | request-schema rejection |

The service must call `openDisciplinePlanVersion`; it must not restate the lifecycle graph. The existing
partial unique index on `(organization_id, plan_id)` for `draft|in_review` is the final concurrency guard.
The `(organization_id, plan_id, sequence)` unique index is the final sequence guard.

Sequence allocation and root transition must occur in one transaction. Lock the plan root, read the latest
sequence in the same organization, perform the lifecycle transition, insert the draft version, and update
the root version using the supplied `If-Match`. A uniqueness race returns a typed conflict and never retries
blindly.

## Signers, snapshots, audit, and events

- Opening commits to no clinical content: `state_snapshot` and `required_signer_set` remain null.
- Finalize continues to seal the current state snapshot and resolve/freeze the required signer set.
- No `version_opened` outbox event is proposed. The lifecycle factory currently specifies audit only, and an
  abandoned draft is not a downstream clinical fact.
- The existing PHI write audit trigger records the insert. The route/service must not log the reason or plan
  content.
- Sign, step-up, signer-role binding, quorum completion, and signed-version events remain unchanged.

## Existing stub plans

No bulk backfill is recommended. Existing draft roots without a version become authorable through the same
endpoint and create sequence 1 on demand. Before release, a read-only report should count roots by lifecycle
and version presence so reviewers can distinguish expected admission stubs from anomalous active roots with
no signed history. Any repair of anomalous production data requires a separate, reversible operator plan.

## Presentation contract (implemented additive response change)

The overview currently cannot truthfully display owner/team, latest signed version, missing signer slots, or
durable IDG provenance from `PlanListItem`. Prefer an additive server projection rather than browser joins:

```ts
interface DisciplinePlanActionSummary {
  openVersion: null | {
    versionId: string;
    sequence: number;
    status: "draft" | "in_review";
    kind: "initial" | "interim_revision" | "idg_review";
  };
  latestSignedVersion: null | {
    versionId: string;
    sequence: number;
    signedAt: string;
  };
  missingSignerRoles: string[]; // derived only from the sealed signer set and collected signatures
  ownerMembershipIds: string[]; // existing root assignments only; no display names in this DTO
  idgDecisionId: string | null; // from the durable application record for an open IDG revision
}
```

The server should not publish a free-text “next action.” The frontend can map the typed facts exhaustively,
while unknown combinations fall back to “Review plan status.” Membership display names should use the
existing authorized identity seam rather than being copied into the plan table.

## Error contract

Use the standard `ChartWardenError` envelope and existing conventions:

| Condition | Status / code |
|---|---|
| Missing `If-Match` | `428 IF_MATCH_REQUIRED` |
| Root version moved | `409 STALE_VERSION` |
| Open draft/review exists | `409 OPEN_VERSION_EXISTS` |
| Initial version already exists | `409 VERSION_ALREADY_EXISTS` |
| Lifecycle rejects request | `409 ILLEGAL_TRANSITION` |
| No permission/scope or cross-tenant id | existing non-leaking behavior |
| Invalid kind/body | generated request-schema error |

## Required tests and gates

- Pure lifecycle tests for the allowed graph (reuse the current lifecycle machine).
- Inject tests for permission, ABAC, non-leaking lookup, `If-Match`, and idempotency.
- Service tests for sequence allocation, single-open-version races, and root/version atomicity.
- A private-Postgres live test as the NOBYPASSRLS application role for tenant isolation and concurrent
  open attempts. Never use the shared Docker cluster.
- Real catalog-validating publisher remains required for any event decision; this proposal emits none.
- OpenAPI enrichment, generated client parity, route reachability, read/write auditing, typecheck, architecture
  fitness, and full non-live tests.
- Security review is mandatory because the route writes PHI-adjacent clinical state and composes patient
  scope. If a Rust-bridged equivalent exists or is planned, parity must be decided explicitly before rollout.

## Rollback

The additive endpoint can be disabled without hiding existing roots, drafts, signed versions, or history.
Rollback must stop new version opens while leaving reads, finalize/sign for already-open drafts (unless the
incident requires otherwise), and immutable history available. No schema migration is required by the
recommended contract; if implementation discovers one, stop and return for migration/rollback review.

## Approval outcome and implementation record

The endpoint contract and on-demand handling of existing stubs were approved. Implementation preserves the
proposed transitions: `initial` only on a versionless draft root and `interim_revision` only from an active
root. Opening calls the existing lifecycle factories, locks the root, increments its optimistic version,
creates the draft in the same transaction, and emits no outbox event. The existing M4 write-audit trigger is
the audit mechanism; request content is not logged by this service.

The action-summary projection is now an additive required field on the plan list and detail responses. It is
derived only from M15-owned version, signature, root-assignment, and durable IDG-application metadata. The
frontend consumes its list shape and the version-open request/response directly from generated OpenAPI types;
it does not browser-join version or signature rows and does not manufacture lifecycle state. Start and Start
revision send the current plan-root version through `If-Match`, disable duplicate submission, reload the
authoritative list after success, and leave a visible retryable error after failure.

The endpoint and projection TypeBox schemas are the authoritative OpenAPI inputs; the published OpenAPI
document and generated UI client are regenerated from them.
Module 15 has no route in `RUST_BRIDGE_ROUTES`, so this endpoint remains Bun-owned; no Rust parity claim or
bridge fallback was added.

Unit/inject coverage pins permission denial, discipline scope, required `If-Match`, stale roots, invalid
system-owned kinds, idempotent replay, sequence allocation, atomic root/version writes, and the no-outbox
decision. Tenant-isolation and concurrent-open assertions were added to the existing private-Postgres M15
live suite. Local execution of that suite was refused by the committed Codex compliance hook even when a
fresh `chartwarden-postgres:dev` container and dedicated port were supplied; CI remains the execution path
for those live assertions.
