# BIL-5.2B.1 — Investigation Workflow Hardening

This increment keeps the M25 investigation overlay and its existing FORCE RLS model. It adds source-owner historical authorization for existing cases, request idempotency for opening, a case history worklist in Billing Operations, and live M23/M41 route lifecycle coverage.

## Delivered

- Existing cases remain readable when an authorized M23/M41 submission leaves `in_doubt`; the detail response reports current source status separately from administrative case status.
- Historical source access still runs through M23/M41 owner readers, including M41 provider and patient-caseload checks. Cached case ownership alone never authorizes access.
- Assignment candidate discovery and assignment both verify current source eligibility for the target user.
- The existing `/billing/operations` experience can reopen persisted investigation history and perform the existing assignment, note, transition, resolution, closure and reopening operations.
- The live Fastify suite exercises M23/M41 against private PostgreSQL using the restricted application role.

## Boundaries

Cases store source references and administrative history only. The underlying submission and claim remain source-owned. This phase adds no retransmission, posting, financial, or replay operation.

See [test results](TEST_RESULTS.md) and [remaining blockers](REMAINING_BLOCKERS.md).
