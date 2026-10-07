# M12 DoseSpot adapter and the seven §4.8 crons (GAP-037 close-out)

## What exists now

All ten M12 §4.8 queues are built (`apps/backend/src/modules/12-dosespot/jobs/queue-catalog.ts` is the per-queue
account, pinned to the spec list by `gap-037-m12-queue-catalog.test.ts`).

| Queue | Where | Notes |
|---|---|---|
| `dosespot.transmit_newrx` | `jobs/transmit-newrx.ts` | every minute; claims `queued` orders with `FOR UPDATE SKIP LOCKED`, calls `transmitNewRx` with the D8 key outside any transaction, settles the order + `medication_order_transmission` row; 1/2/4/8 min backoff, 5 retries then `transmission_failed`; a permanent rejection exhausts at once; an OPEN BREAKER defers without spending a retry |
| `dosespot.transmit_queued_on_recovery` | `jobs/transmit-newrx.ts` | every 5 min; releases `in_flight` claims older than 10 min (crashed worker) and drains the backlog with a larger batch. Poll-driven, not subscribed to `m12.dosespot_recovered` |
| `dosespot.patient_sync` / `fetch_medhx` | `jobs/worker.ts` (existing) | now EDITS an already-known DoseSpot patient instead of re-creating, and drops `rx_benefit_cache` when `invalidate_rx_benefit_cache` is set |
| `dosespot.rx_benefit_prewarm` | `jobs/rx-benefit-prewarm.ts` | daily; fills `rx_benefit_cache` (migration 0411) from real lookups only; stops after 3 consecutive failures |
| `dosespot.refill_sla` | `jobs/refill-sla.ts` | hourly; 48h/72h events once per stage (markers from migration 0412) |
| `dosespot.ial2_expiry_warn` | `jobs/ial2-and-epcs-sweeps.ts` | daily; 30d/7d stages once each; an expired prescriber becomes `ial2_status='expired'` and loses `epcs_enabled` |
| `dosespot.transmission_timeout_sweep` | `jobs/transmission-sweep.ts` | every 10 min (spec: hourly) because it is also the ack/nack POLL; 24 h with no acknowledgement => `transmission_failed` |
| `dosespot.epcs_attempt_expiry_sweep` | `jobs/ial2-and-epcs-sweeps.ts` | every minute; pending attempt past `expires_at` => `failed_timeout`, order back to `pending_signature` |
| `dosespot.dispatch_webhook` | `webhooks/ingest.ts` + `webhooks/handlers.ts` | `script_status_update` Dispensed/PickedUp (existing), `Sent` => ack (order activates), `RxFillError`/`Rejected` => nack; `refill_request` => pending refill; `prescriber_status_changed` => IAL2 status (never enables EPCS). `medication_history_result` and `patient_mismatch` are still recorded as `*_not_handled` |

The sign path (`transmission-enqueue.ts`) queues a signed order for transmission INSTEAD of activating it locally only when
`DOSESPOT_TENANT_CONFIGS` has a complete config for the tenant AND the order has an RxCUI and a structured sig. Otherwise the
F-058 local activation (`not_required`) is unchanged.

## The adapter (`packages/dosespot/src/client/`)

`createHttpDoseSpotClient` implements the `DoseSpotClient` port over the DoseSpot v2 REST API:
OAuth2 token minting and caching per (tenant, clinician) with early refresh and one forced re-mint on a 401; the
`Subscription-Key` + `Authorization: Bearer` headers; a hard request timeout; 429/5xx/network => retryable with the per-call
250/500 ms backoff, then a retryable `DegradedError` for the BullMQ layer; other 4xx and `Result.ResultCode = "ERROR"` =>
permanent; the per-tenant circuit breaker (open/close edges are published as `m12.dosespot_degraded` / `_recovered` by the next
cron tick); NewRx idempotency (the D8 key is sent as `Idempotency-Key` AND a created-but-unsent prescription is remembered in
process so a retry re-sends rather than creating a second).

**Fail-closed.** With no complete per-tenant config (`DOSESPOT_TENANT_CONFIGS`; https only) every call rejects with a
non-retryable `DegradedError` before any payload is touched, the vendor-facing crons skip the tenant, and nothing is queued.
A controlled substance is refused for a tenant whose config does not say `epcsCertified` (D18). The boot log states
"UNBOUND until per-tenant credentials are configured" or the bound tenant count, plus the unverified endpoint list.

## What was verified, and against what

Source: the public staging swagger (`https://my.staging.dosespot.com/webapi/v2/swagger/docs/FullV2`, retrieved 2026-10-06) and the
public v2 surface descriptions. Confirmed there: `POST /api/patients` (`Patients_AddPatientV2`), `PUT /api/patients/{id}`,
`POST /api/patients/{id}/prescriptions/coded`, `POST /api/patients/{id}/prescriptions/send` (body `prescriptionIds`, `pin`),
`GET /api/patients/{id}/prescriptions`, `GET /api/patients/{id}/medications/history`, `POST /api/clinicians`, the `Result`
envelope, `IdentifierResponse { Id }`, and the `Prescription.Status` enum. The contract tests
(`packages/dosespot/__tests__/http-client.test.ts`) run the adapter against a RECORDED FAKE TRANSPORT scripted from those facts;
they prove OUR behaviour (config gating, token flow, classification, backoff, breaker, idempotent send), not DoseSpot's.

## Requires sandbox verification (isolated, not guessed)

Everything below is flagged in code (`client/endpoints.ts` `verification`, `client/mappers.ts` `WIRE_FIELD_MAPPING_VERIFIED = false`,
`webhook/payloads.ts` `DOSESPOT_WIRE_MAPPING_VERIFIED = false`) and appears in the boot log.

1. **Token endpoint** `POST /connect/token`: absent from the public swagger. Implemented as Basic `clinicId:clinicKey`,
   form `grant_type=password`, `Username=<clinician id>`, `Password=<clinic key>`, `scope=api`, plus `Subscription-Key`
   (the shape community clients document). Confirm the exact form, scope and whether the clinic key must be encrypted.
2. **Add/edit patient body** and **coded-prescription body**: field names are the v2 PascalCase convention
   (`FirstName`, `Rxcui`, `DaysSupply`, `Directions`, `PharmacyId`, ...). The swagger excerpt we could read did not list them.
   The mapping lives in `mappers.ts` only.
3. **Send confirmation**: the adapter requires the send response to echo our prescription id (an array of `IdentifierResponse`)
   and refuses to report success otherwise. If DoseSpot answers differently, sends will fail loudly (retryable) rather than
   mis-report.
4. **Idempotency**: DoseSpot's own dedupe is unknown; the `Idempotency-Key` header may be ignored. Cross-process safety rests on
   our unique `(organization_id, idempotency_key)` transmission row; an in-process map covers retries within one process. A
   crash between "created" and "sent" can leave one unsent draft prescription at DoseSpot (harmless, never transmitted).
5. **No endpoint found at all** (these fail closed with a non-retryable `DegradedError`): RxBenefit lookup (so `rx_benefit_cache`
   stays empty), `respondToRefillRequest`, `revokePrescriber`, EPCS signing session. The prewarm cron, the refill-response path and
   EPCS therefore cannot do vendor work until an endpoint is verified and added to `endpoints.ts`.
6. **Medication-history paging**: parameters were not readable, so one page is requested without any; item field names are read
   tolerantly (`DisplayName`, `Rxcui`, ...).
7. **Webhooks**: DoseSpot's public surface shows notification polling, not signed outbound webhooks. The inbound envelope and the
   HMAC scheme are spec-defined and the inner payload names are OUR provisional mapping; the status poll is the primary ack/nack
   source and the webhook handlers are an additional path. Both converge on `jobs/order-outcomes.ts`, so whichever arrives first wins
   and the other is a no-op.
8. **Pharmacy routing**: M40 pharmacies carry no DoseSpot pharmacy id, so `pharmacyDosespotId` is omitted and DoseSpot routes to the
   patient's preferred pharmacy; a `PharmacySelect` status means none is set.
9. **Prescriber token**: `transmitNewRx` authenticates as the prescribing clinician (`dosespotPrescriberId`); every other call as
   `serviceClinicianId`. Whether the send needs the prescriber's PIN is unconfirmed (`pin` is optional in the swagger).

## Operational notes

- Enabling a tenant = set its entry in `DOSESPOT_TENANT_CONFIGS` (staging URL first), enroll its prescribers (`dosespot_prescriber`
  with `dosespot_prescriber_id`), and let patient sync populate `dosespot_patient_sync`. A tenant that loses its config keeps its
  queued orders `queued` (the crons skip it) rather than failing them.
- A tenant with an outage longer than ~31 minutes of real failed attempts sees orders land in `transmission_failed`; the existing
  `retransmit` route mints the corrected order. Breaker-open ticks do not count.
- Live proof: `test:m12:crons-transmit:live` and `test:m12:crons-housekeeping:live` (CI job "M12 DoseSpot crons"), run against a
  throwaway Postgres 18 with `max_locks_per_transaction=4096`.
