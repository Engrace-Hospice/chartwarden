# M23/M41 case lifecycle

The existing M25 service and migration 1454 remain the case, note, and append-only event owners. No second case store or migration was added.

`apps/backend/__tests__/m41-commercial-routes.live.test.ts` now covers authenticated Fastify create, detail, list, assignment, note, transition, resolution, closure, reopening, and history for both sources with real database persistence.

M23 source completion is performed through its owner submission record. M41 source completion respects the `commercial_submission_sent_stamp` invariant. Both tests confirm the case remains available and exposes the current source state after that transition.

Opening retries first reauthorize the source historically, then resolve the stored request fingerprint before checking whether a *new* case may be opened. This preserves an exact creation retry after the source state changes without permitting a new case from a non-`in_doubt` submission.

Concurrency is revision-based: competing assignments and status changes against the same version produce one successful update and one conflict. Notes are append-only and serialize through the existing transaction lock.
