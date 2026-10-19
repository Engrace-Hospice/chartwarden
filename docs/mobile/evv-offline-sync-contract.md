# EVV offline sync v2 contract

## Endpoint and guarantees

`POST /api/v1/evv/offline-sync/v2` uses the authenticated organization and membership. The body cannot select
either identity. Transport is **at-least-once**; server persistence is transactionally deduplicated per capture.
An HTTP timeout is not proof of failure or success.

### Storage decision

The authoritative deduplication key is `(organization_id, evv_device_id, local_id)` in the non-partitioned,
append-only `evv_offline_capture_receipt`. An advisory transaction lock serializes this identity; event,
geofence snapshot, outbox effects, audit and receipt commit together. This was chosen over the short-lived HTTP
`Idempotency-Key` store and monthly leaf indexes, neither of which guarantees capture identity across months.

The receipt stores no coordinates, patient id, address or free text. It stores HMAC-SHA-256 of a fixed-order,
versioned canonical payload. `EVV_OFFLINE_FINGERPRINT_KEY` is required in production, must be identical on all
replicas, must never be logged, and must remain available for the entire receipt lifetime. It cannot be rotated
in place until a multi-key reader exists. Receipts have no automatic expiry; an archive must preserve the
authoritative uniqueness lookup. Historical `local_id IS NULL` events are not retroactively deduplicated.

Request (1–100 events; UUID/date-time/coordinate/accuracy validation is fatal for the whole batch):

```json
{
  "evvDeviceId": "33333333-3333-4333-8333-333333333333",
  "events": [{
    "kind": "check_in",
    "localId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "visitId": "22222222-2222-4222-8222-222222222222",
    "serviceTypeCode": "routine_visit",
    "capturedAt": "2026-10-16T08:30:00.000Z",
    "coords": { "lat": 40.0, "lng": -75.0 },
    "accuracyM": 8,
    "evvDeviceId": "33333333-3333-4333-8333-333333333333",
    "offlineCapture": true
  }]
}
```

`localId` values must be unique inside the batch and each item device must equal the batch device. The server
always persists `offline_capture=true` and generates `synced_at`; it never accepts a device `syncedAt`.
`serviceTypeCode`, discipline, patient and location remain server-derived for persistence.

Successful HTTP response is 200 even when item outcomes differ:

```json
{
  "results": [{
    "localId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "status": "applied",
    "eventId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "kind": "check_in",
    "capturedAt": "2026-10-16T08:30:00.000Z",
    "gpsQuality": "high",
    "geofenceDecision": "pass",
    "visitStateAfterEvent": "in_visit"
  }],
  "summary": { "applied": 1, "alreadyApplied": 0, "rejected": 0, "retryable": 0 }
}
```

Results are in request order. Processing is deterministic by visit, `capturedAt`, then check-in before check-out
at equal instants. A check-out earlier than every same-batch check-in is `rejected` with
`EVV_CAUSAL_ORDER_INVALID`; the server never rewrites device time.

## Status meanings

- `applied`: this call committed the event and receipt. `eventId` is server proof.
- `already_applied`: an earlier call committed the identical capture; the stored `eventId` and verdict are
  returned and no geofence/outbox/M17 effect is re-emitted.
- `rejected`: do not retry unchanged. Correct the local data or route the case for review. Examples include
  `IDEMPOTENCY_CONFLICT`, permissions/assignment/window refusal, and invalid causal order.
- `retryable`: no commit proof was returned. Keep the exact item and retry with the same `localId` and payload.

Authentication absence/expiry is an HTTP 401. Malformed schema, duplicate batch `localId`, incoherent device,
or invalid batch size fails the entire request (4xx) before writes. Item errors expose only stable codes and a
`correlationId`—never coordinates, patient data, visit existence detail, or secrets. Request-level failures use
the same correlation ID in the standard error envelope.

The endpoint performs EVV capture only. It cannot sign an encounter or mutate other clinical documentation.
Geofence and GPS quality are verdicts, not a compliance attestation.

## Reconciliation protocol

Persist the exact capture and `localId`, submit, and delete locally only after `applied` or `already_applied`
with a valid server `eventId`. After timeout, disconnect, 5xx, or `retryable`, keep the item unchanged and resend.
Never mint or infer `eventId`. On `rejected`, stop automatic retry and show a correction/review state. Reusing a
`localId` with changed semantic data always conflicts.

The legacy `/api/v1/evv/offline-sync` retains its array response. It is sequential and uses durable receipts
when `localId` exists; captures without `localId` remain unable to prove the result after acknowledgement loss.

## Deployment and rollback

Apply migration `1121_m18_evv_offline_capture_receipt.sql` before deploying the API and provision the HMAC key
before production boot. Application rollback is safe while the additive receipt table remains. Do not drop the
table as an automatic rollback: first disable v2, reconcile every mobile queue, and preserve identities through
the approved EVV retention/destruction process.

