# Resolver runtime

## Current state: Facade exists; runtime binding missing

`createClaimMdIdentityWorker` is bounded and disabled when `enabled` is false (`apps/backend/src/modules/23-billing-medicare/claimmd-identity/service.ts:43-66`); config requires literal case-insensitive `true` (`config.ts:1-5`). The store invokes `withPlatformContext` using `CLAIMMD_CAPTURE_JOB_ID` (`claimmd-capture/store.ts:8,26-34`; `claimmd-identity/store.ts:33-39`). No registration or invocation for this resolver/capture job was found in the backend composition root. Thus the flag is not a runtime control today because no worker is registered.

## Target integration requirements

Bind only after the candidate adapter, evidence schema, key lifecycle and PostgreSQL role checks exist. Register the internal job identity before platform context use. Construct the inbox cipher from approved key management; never make a tenant-facing route read the central inbox. Add bounded schedule/queue, lease metrics, retry/DLQ alerts, and an audited internal requeue service requiring actor and reason. Requeue may only return eligible unresolved/review records to pending; it may not set a tenant/provider/claim target.

The feature remains false when absent or malformed. Claim.MD credentials alone must never activate it. Resolver output remains identity-only; no acknowledgment dispatch, claim-state update, ERA posting or automatic resubmission belongs here.

## Reprocessing and observability

Current retries use fixed delays; no operational requeue command or metrics wiring is present in the resolver. A safe future command should accept an event ID, reason and authenticated internal actor, append audit history, preserve prior resolution versions and reject malformed/conflicting terminal events unless reviewed by a separate correction procedure. Metrics must use stable internal IDs/counters and fixed safe error codes, never PHI or raw vendor bodies.
