# Mobile handoff — EVV offline queue and reconciliation (PR E.2)

The mobile repository must implement an encrypted local queue around
`POST /api/v1/evv/offline-sync/v2`.

For every user tap, generate one UUID `localId` and persist it with the exact request fields before showing the
capture as queued. Never regenerate it for retry and never edit a queued payload under the same id. Store the
queue using platform-backed encrypted storage; do not put coordinates, visit identifiers, response bodies or
tokens in logs, analytics, crash breadcrumbs or notification text.

Recommended state machine:

1. `pending`: durable locally, never acknowledged by the server.
2. `syncing`: one in-flight attempt; process captures for a visit by `capturedAt`, check-in first on ties.
3. `accepted`: only `applied` or `already_applied` plus a syntactically valid server `eventId`.
4. `rejected`: stable server code; retain enough encrypted data for correction/review, but do not auto-retry.
5. `pending_reconciliation`: timeout, disconnect, malformed/ambiguous response, 5xx, or `retryable`; resend the
   identical payload and localId with bounded backoff after connectivity/auth recovery.

Batch at most 100 items, never duplicate a `localId` in one batch, and use only the authenticated clinician's
approved device id. A 401 pauses the queue until reauthentication. A batch-level 4xx is not an item success:
keep every item and surface the request error. Do not add automatic retry middleware around other clinical
mutations; retry applies only to this idempotent capture contract.

Delete encrypted queue material only after the accepted state has been durably stored in the local UI model.
Keep the server `eventId`, status and displayed verdict; GPS/geofence verdicts must not be presented as proof of
regulatory compliance. Device attestation remains fail-closed when the deployment enables it; App Attest / Play
Integrity client integration is a separate mobile/backend rollout prerequisite.

