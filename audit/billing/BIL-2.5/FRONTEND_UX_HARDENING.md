# Frontend UX hardening

## M41 submission action added

The commercial backend had a send-gate API and an idempotent submit endpoint, but [claim-detail.tsx](../../../apps/web/src/modules/41-billing-commercial/claim-detail.tsx) only linked to the gate and claimed sending belonged to a future slice. That left a user with no submission action despite the existing backend workflow. The detail now:

1. Shows **Review submission checks** only when the claim is `ready` and the user has the submit permission.
2. Loads the server's current send gate and shows each stable blocker.
3. Offers **Confirm and queue submission** only if the server says it can submit.
4. Posts with a fresh idempotency key. Backend permission, caseload and step-up guards remain authoritative.
5. Describes the result as queued and explicitly says clearinghouse receipt is pending.

DOM tests cover successful review/queue and a blocked route. Existing commercial correction and claim-timeline tests remain in the focused suite. No replacement/void eligibility was broadened.

## Other modules

M23 already presents renderer preview lifecycle, stale-source feedback and submission history; M24 shows local preparation while stating the current electronic route is unavailable/unverified. Their focused DOM suites passed. No unrelated workspace redesign was made.
