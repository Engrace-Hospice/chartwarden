# Routing and transport safety

## Request path

The server derives route readiness from the claim's service state and stored MCO assignment. The client cannot select a transport by `channelHint`, nor mutate the claim's MCO through PATCH. `submitClaim` returns `MEDICAID_STATE_NO_ELECTRONIC_GATEWAY` before inserting a submission attempt or outbox work while readiness is unavailable.

## Worker path

The durable worker rechecks current route readiness before loading credentials (`apps/backend/src/modules/24-billing-medicaid/jobs/submission-jobs.ts:184-208`). If an old pending job exists for an unsupported route, it terminalizes that attempt as a transport failure with a stable reason and does not invoke the state adapter. For a route that becomes supportable in a future phase, the worker also compares the credential's state/channel/MCO binding to the server-owned claim identity (`submission-jobs.ts:245+`).

The poll worker applies the same readiness check before credential resolution or `adapter.poll` (`submission-jobs.ts:524-527`). An existing pending-async attempt remains pending for authorized reconciliation rather than producing an unsupported network request.

## No Medicaid Claim.MD routing

M24 does not use the shared Claim.MD account. M23/M41 Claim.MD configuration must not be treated as M24 transport authorization. State-direct and managed-care routes require their own approved endpoint/clearinghouse, program identity, enrollment, credential, test approval, and matching state guide.

## Recovery

This phase adds no retry or resubmission behavior. Existing claim correction/history routes remain as they were. Unsupported submission creates no attempt; stale submit work is terminalized safely, while pending-async poll work remains pending for authorized reconciliation without a send.
