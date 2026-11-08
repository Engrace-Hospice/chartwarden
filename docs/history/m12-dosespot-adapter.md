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
250/500 ms backoff, then a retryable `DegradedError` for the BullMQ layer (the prescription SEND is the exception: only a 429, a 503
or a connection never made is retryable, and every other send 5xx, a timeout or a reset is held as an unconfirmed outcome); other 4xx and `Result.ResultCode = "ERROR"` =>
permanent; the per-tenant circuit breaker (open/close edges are published as `m12.dosespot_degraded` / `_recovered` by the next
cron tick); NewRx idempotency (the D8 key is sent as `Idempotency-Key` AND a created-but-unsent prescription is remembered in
process so a retry re-sends rather than creating a second).

**Fail-closed.** With no complete per-tenant config (a tenant's own `dosespot_clinic_registration` that is `active`, or, for a tenant with NO row, its `DOSESPOT_TENANT_CONFIGS` entry; https only) every call rejects with a
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

## Tenant registration (slice 4, ADR-0110)

A tenant registers its own clinic: `PUT /api/v1/tenant/dosespot` (org admin) or `PUT /api/v1/platform/tenants/:orgSlug/dosespot`
(platform ops, while the tenant is onboarding), then `verify` (one token mint, no PHI), then `activate`. The clinic key is sealed under
the tenant key ring and never returned; the environment (`sandbox` | `production`) maps to a platform host, never a tenant-typed URL.
A rotation lands on `registered` and needs a fresh test; a plain deactivation goes to `verified`. `GET` shows `prescribersEnrolled` and
`queuedTransmissions`; neither gates anything. A prescriber is enrolled with DoseSpot by
`POST /api/v1/admin/dosespot-prescribers/:membershipId/dosespot-enrollment` (or the operator's copy), which records the vendor id the
transmit cron sends under; the sign path queues an order only for a prescriber linked this way.

**Added to "requires sandbox verification" (all still unverified):**

10. **The Subscription-Key**: per clinic (platform support enters it per tenant, sealed in the registration) or ChartWarden's own,
    shared (the platform env `DOSESPOT_SUBSCRIPTION_KEY_*` applies when a row carries none)? The tenant lane may rotate one that
    platform support set and never introduce one, so a platform key is never typed in by a tenant. The sandbox run decides.
11. **Clinician dedupe**: does `POST /api/clinicians` refuse a second clinician with the same NPI? A crash between the vendor create and
    the local record leaves an orphan clinician, and the retry may meet a duplicate (the request marker is committed first).
12. **The production host and the BAA**: production has no baked-in host; it needs `DOSESPOT_PRODUCTION_ENABLED=true` and
    `DOSESPOT_BASE_URL_PRODUCTION`, set only once the ChartWarden / DoseSpot BAA is executed and the wire shapes are confirmed.
13. **A vendor rejection of a rotated key at runtime** still fails the order permanently (a token-mint 4xx is permanent); a guard that
    holds orders and alerts once, as the clearinghouse has (#714), is not built.

**Independent review of slice 4 (what it found and what now stops it):**

- *A sandbox registration could reach `active` on a production deployment* and send real prescriptions to DoseSpot's test
  environment. `DOSESPOT_SANDBOX_ENABLED` (exactly `true`) now gates it: `activate` is refused (409 `DOSESPOT_SANDBOX_NOT_ENABLED`), and
  the resolver, the sign-time gate and the wizard's `dosespotSettled` all call ONE predicate (`registrationIsLive`: active, and the
  environment allowed on this deployment), so an active sandbox row stops transmitting if the flag is later unset and a not-live row
  activates orders locally instead of stalling them in `queued`.
- A claimed order whose registration stops being live, or whose resolver, key ring or credential faults (a corrupt envelope is a 503), goes
  back to `queued` with no retry spent. `addClinician` is never re-POSTed in-call (no idempotency key); the enrolment claim is released only
  after a definitive refusal and only by the attempt that made it, outlasts the worst-case vendor call, and a first-enrol race is a 409.
- *The NPI and name of an enrolled prescriber were typed by whoever enrolled them* (the roster administrator or the operator), so the
  identity DoseSpot was told, and the NPI the roster recorded, had no source. They are now derived from the physician record the roster
  links the member to (M40's NPPES-sourced `external_physician`) and cross-checked against NPPES's public directory (`nppes_provider`, via
  M29's reader seam): NPI-1, active, same surname. The enrolment body is empty; the member must already be on the roster with that link,
  which is how the demo roster is seeded (`db:seed:prescriber-roster`). NPPES with no row refuses in production and proceeds flagged
  (`nppesVerified: false` on the audit row) in sandbox, because the demo's synthetic NPIs are not in the real registry.
- *The link from a member to that record was one administrator's word about another person.* The prescriber now confirms it from their
  own account (`/api/v1/me/dosespot-prescriber-link`, migration 1384), pinned to the link and NPI they were shown, and enrolment on both
  lanes is refused 409 `DOSESPOT_PRACTITIONER_UNCONFIRMED` until a confirmation matches the current link. A re-link or revoke clears it;
  a table CHECK requires the recorded confirmer to be the row's own member, and a trigger refuses a write that sets or changes a
  confirmation unless the transaction's declared actor (`app.user_id`) is that member's user (clearing is open to any actor; the trigger is a
  backstop on the declared actor, not authentication). The row's write-audit record carries the confirmed NPI (public provider data) like
  any column of the table. The demo seed has Dr. Harris confirm his own link.
- Fixed here too: the shared Idempotency-Key middleware stored a plain SHA-256 of every request (a credential in the body was testable
  from the table); it is now an HMAC under a key derived from `BETTER_AUTH_SECRET` (CW-SEC-02), with the legacy form honoured for one TTL.
- Open, not fixed here: `verify` lets a tenant administrator probe candidate clinic keys against the vendor (ADR-0110 open items).

## Operational notes

- Deploy note: a local or CI database that applied an EARLIER copy of migration 1384 (before the confirmer CHECK and the actor trigger) or of
  1385 must be recreated. Both were edited in place because neither had shipped, and the migration runner checksums applied files, so it
  will refuse them. Nothing in any shared environment applied the old copies.

- Enabling a tenant = it (or an operator for it) registers, tests and activates its clinic (sandbox first), then enrols its prescribers
  with DoseSpot; patient sync then populates `dosespot_patient_sync`. `DOSESPOT_TENANT_CONFIGS` is only the fallback for an org with no
  registration row (the demo tenant): the boot log names each such org, and a row takes over the day it exists. A tenant that loses its
  live registration (deactivated, rotated) keeps its queued orders `queued` (the crons skip it) rather than failing them; newly signed
  orders activate locally and its administrators are alerted.
- Degradation alerts (review of slice 4, M3): `m12.dosespot_degraded` / `_recovered` (breaker edges, an org whose config cannot be opened, signed
  orders queued over an hour) are consumed by M36's `dosespot-alerts` and reach the tenant's administrators (seeded `tenant_admins` rules, the
  deactivation alert's rule among them; before, these events had no consumer and the deactivation alert no rule, so nobody was told). The
  "once per episode" memory is a few Valkey keys per (kind, org) (`chartwarden:m12:episode:*`), shared by every replica: a restart does not
  re-alert, and the replica that sees the recovery announces it whichever one raised the alert, after two consecutive clean ticks (a report of
  the fault resets the count, so replicas that disagree do not flap). Each announcement is a short-lived CLAIM (2 minutes, never refreshed by
  other ticks) that is confirmed only after its event has committed: `open` is written after the alert is published and removed after the
  recovery is, so a crash, a failed publish, a failed release or an unreachable store delays an announcement until the claim lapses and never
  drops one. It is at-least-once: a process that dies after its publish committed but before the confirm announces it a second time. The circuit
  breaker's own edges are still paired
  in-process (a restart while a breaker is open leaves that alert without its recovery notice).
- A retry-exhausted transmission (`m12.medication_order.transmission_failed`, owner addition to the review of slice 4) pages the tenant's
  administrators through the same M36 `dosespot-alerts` consumer and a seeded critical `tenant_admins` rule: it was described as "M36
  high-severity" from the start and consumed by nobody, so an order that never reached the pharmacy told no one. The alert says it has NOT
  reached the pharmacy and that the prescriber retransmits it.
- An outcome DoseSpot left unconfirmed (review of slice 4, L-e): a 2xx that is unreadable or carries no prescription id means the prescription
  may already exist there, so `transmitNewRx` neither fails the order nor retries it (a second send could dispense twice). The order is HELD:
  still `queued_for_transmission` / `in_flight`, its transmission row `last_error_class = 'unconfirmed_outcome'` with a detail line, no retry
  spent, skipped by the claim and by the stale-claim drain. `m12.medication_order.transmission_unconfirmed` is published in the same transaction
  and M36's `dosespot-alerts` pages the tenant's administrators once, naming the order, and again as a reminder when the hold is over 24 hours
  old (`held_orders_aged`, through the same episode machinery: ONE reminder per episode, so while any order stays held past 24 hours the episode stays open and a second order that ages meanwhile is covered by it, not by a new reminder; each order still gets its own alert when it is held). The way out is an ADMINISTRATOR's resolution (MEDIUM-1 of the next review):
  `POST /api/v1/medication-orders/:id/resolve-held-transmission` (`prescribing.clinic.admin` + a fresh step-up + a human actor + an
  Idempotency-Key + a reason), offered on the medication-order detail to administrators. The administrator checks the prescriber's DoseSpot
  account and says SENT (entering the DoseSpot prescription id: the order becomes `transmitted`, the `transmitted` event goes out as for a
  worker success and the status poll follows it as normal) or NOT SENT (the order becomes `transmission_failed`, whose only way on is the
  existing retransmit, where the prescriber signs a replacement; it is never put back on the queue). Either is accepted only while the hold
  marker is on the transmission row, under a row lock and a conditional update, so two resolutions, or a resolution racing the recovery drain,
  cannot both win (409 `DOSESPOT_TRANSMISSION_NOT_HELD`); the marker, not `transmission_failed_at`, says an order is held (an earlier retry sets that
  timestamp and the backoff needs it kept); a "sent" id that another order of the organization already carries is refused (409
  `DOSESPOT_PRESCRIPTION_ID_IN_USE`: webhooks bind an order by that id and take the first match), by a per-(org, id) advisory lock taken before the
  order row, and the worker's own success applies the same guard (it holds the order instead of recording a duplicate id); the reason is stored on the transmission row's denylisted `last_error_detail`, and the
  audit entry (`m12.dosespot_order.transmission_resolved`) carries ids and the outcome only. `GET .../transmission` reports `unconfirmed_outcome`
  while held. (The same 2xx-but-no-id ambiguity after the create step used to be a permanent
  refusal; it is now this class, like an enrolment's.) The claim also stamps `transmission_started_at` in its own committed transaction just
  BEFORE the vendor call (and clears it when the order goes back to the queue), so a worker that dies, or whose settle fails, after the call began
  leaves a stale claim the recovery drain HOLDS (same marker, same event) instead of re-queueing; a stale claim without the stamp never reached
  the vendor and is released and re-sent as before. The hold is therefore committed either by the settle or, at the latest, by the next drain.
  That stamp is also the FENCE (H3 of the following review): one conditional update moves the order's `updated_at` from the claim's value to the
  call's, only while the order is still that worker's claim, so a worker whose claim was drained and taken over while it was busy with an
  earlier order of its batch makes no call (it used to stamp and send with the same key: a double send), and the stale-claim clock runs from the
  call, not the claim. A hold the drain set while the original call was still running is cleared by that call's late success, and a late
  unconfirmed outcome does not announce a held order a second time.
  The fence covered only the vendor call, so (MEDIUM-1 of the next review) every write the worker makes after its claim is conditional on the
  claim still being its own too: the settle locks the ORDER row with the `updated_at` the claim wrote, and after the fence the TRANSMISSION row
  carrying the nonce the fence wrote (`call_token`, a uuid, migration 1386; it first was the stamp's own time, which two cycles on an equal clock
  could share: review of d333d1d9d..HEAD). `updated_at` cannot be the token after the fence: it is shared with a coverage save, allowed in every
  status, and a correction's version bump, and as the token it made such a write during the call orphan a prescription DoseSpot had accepted
  (review of 436fd3c1c..). A
  worker that lost its claim writes nothing and is counted `skipped` (and says so, ids and the kind of what it discarded only, for a failure, an outage and an unconfirmed outcome as well as a success; the cron tick's warning carries the count) (it used to requeue or exhaust the new owner's claim and clear its stamp when its
  payload build failed after a takeover, so the owner's success matched nothing and the prescription went out again). The order row is locked
  before the transmission row, as in the administrator's resolution, so a late failure racing a resolution cannot deadlock, and a late outage
  after a drain hold clears the stale hold marker. The adapter sends a prescription as soon as `onCreated` returns, and `onCreated` used to update the
  transmission row by id alone, so a worker that had lost the order (an administrator resolved it NOT SENT) still sent it; it now answers only while the
  worker owns the call and throws otherwise, which stops the send (the created prescription stays at DoseSpot as an unsent draft). `onCreated` runs only
  when a call creates the prescription, so a retry handed a PERSISTED created id (the create skipped) was still unchecked: the adapter now also calls
  `beforeSend` just before the send on every path and the worker re-checks ownership there, so a resolved order is not sent from a resume either. What
  remains is a send already in flight, whose success is then recorded nowhere (a warning with ids only). A late DEFINITIVE
  failure after a drain hold is deliberately NOT kept held: it is the call's own answer to what the hold was waiting for, so it is settled as an ordinary
  failure (retryable: requeued, one retry spent, the persisted created id re-sent, the marker replaced; permanent: the order fails and the
  administrators are told), and an administrator mid-resolution is then refused with 409 DOSESPOT_TRANSMISSION_NOT_HELD.
- A replacement order was never sent (found in the review of d333d1d9d..HEAD, outside the reviewed range): the D8 key was sha256(prescriber, patient,
  drug, strength, sig), unique per organization, and the sign-time enqueue reused an existing row on a conflict without asking whose it was. A retransmit by
  the authoring prescriber (the standing rule allows it) mints a replacement with exactly the same content, so it found the FAILED order's row (or the
  "resolved not sent" one's), was queued with none of its own, and sat queued forever: the worker finds transmissions by order id and skips an order
  with none, and the age alert needs a transmission row too, so nothing said so. The same held for any second order with identical content, a refill
  mint included. The order id is now part of the key (a retransmit is its own prescription, so DoseSpot's own dedupe, if it exists, cannot fold it
  into the failed attempt; a double-sign of the SAME order still shares one row), and the enqueue refuses, loudly, a row under its key that is
  another order's. After a "not sent" resolution that was a mistake the retransmit therefore duplicates the prescription, as the CW-AC-23 gap already
  says. Orders already stuck queued with no row (demo data) are not repaired by this change: reseed them. Two things now keep a leftover orphan from hiding
  or hurting (review of 18d8778fe..HEAD): the claim only considers orders that HAVE a transmission row (it chose its batch before reading rows, so a
  batch of orphans older than a real order filled it and the real order was never reached), and the queued-age alert also finds a queued order with no
  row at all, aged by the order's own `updated_at`.
- A created-but-unsent prescription survives a change of replica (LOW of the following review): the adapter used to remember a created
  `addCodedPrescription` id only in its own process memory, so a retry on another replica re-ran the create (a second prescription). The adapter now
  reports the id (`onCreated`) before the send and accepts it back (`createdPrescriptionId`); the worker persists it on the transmission row's
  `dosespot_prescription_id` and hands it to the next attempt, so a retry re-runs only the send. The ORDER still carries an id only once it is
  really sent (webhooks bind by it). If persisting fails the send is not attempted and the order spends a retry as a generic failure (bounded at five; it is
  not classified as an outage, which would loop without bound while the persist keeps failing); a create whose answer had no id is
  still held as unconfirmed (there is nothing to persist).
- A tenant with an outage longer than ~31 minutes of real failed attempts sees orders land in `transmission_failed`; the existing
  `retransmit` route mints the corrected order. Breaker-open ticks do not count.
- Live proof: `test:m12:crons-transmit:live` and `test:m12:crons-housekeeping:live` (CI job "M12 DoseSpot crons"), run against a
  throwaway Postgres 18 with `max_locks_per_transaction=4096`.
