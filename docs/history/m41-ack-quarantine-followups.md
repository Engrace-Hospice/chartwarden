# M41 acknowledgment quarantine follow-ups (issue #820)

Context: PR #828 made `scope_mismatch` / `vendor_mismatch` rows replayable (migration 1279), made every abandonment an
`m41.claim.ack_abandoned` event, and added a claim-status inquiry for aged `no_receipt` rows. This round (migration **1280**) closes
what could be closed without a vendor sandbox.

## Done

- **Pre-1279 mismatch rows (no stored event).** They were skipped forever. They are now selected by every sweep and closed with the
  explicit resolution `abandoned_no_event` plus an `m41.claim.ack_abandoned` event (ids and codes). No row is rewritten by the migration;
  the sweep does it, so each closure is audited. The quarantine row itself is never deleted.
- **Stranded foreign / unbound rows.**
  - The unbound tick used to skip the held-row sweep entirely (it only failed on waiting work). It now runs the same no-transport sweep, so
    aged, foreign-stream and event-less rows leave audited whatever the binding.
  - `heldQuarantineReport(deps, orgId)` returns counts only (held, own stream, stranded foreign or unbound, event-less, review-only
    `malformed`, oldest). The pull logs `ack.held_stranded` with the count (no ids) so ops can see it.
  - `abandonForeignHeldEvents(deps, orgId)` is the explicit operator call: it closes, now, the org's rows belonging to another vendor's stream
    than the current binding (`abandoned_foreign_vendor`, one audited event each). It does nothing while unbound (that may be a config
    blip; the 45-day age sweep still applies). Org-scoped through `inOrg` plus an explicit filter; idempotent; bounded per call. It has an authenticated route since round 3 (below). Until it is called, foreign rows leave through the audited 45-day age sweep, so `abandoned_foreign_vendor` occurs only on an explicit call.
- **Stedi 276/277.** `packages/x12-837-client/src/clearinghouse/stedi-claim-status.ts` holds a request builder and response parser with
  fixture-style tests. It is **unbound and unverified**.

## Round 3 (migration **1285**, port change)

### Per-reason resolution path (the answer to "a replay path for reasons other than no_receipt")

| reason | automatic | operator |
|---|---|---|
| `no_receipt` | replayed every pull once the submission is settled; past 45 days asked about (claim status) then abandoned | `replay` now; `resolve` |
| `scope_mismatch` | re-checked under the SAME scope each pull; applies only if the situation changed, never re-routed to the other provider entity; else aged out | `replay`; `resolve` |
| `vendor_mismatch` | same, under the SAME vendor stream; a foreign or unbound row is only aged out | `replay`; `abandon-foreign` (closes the rows of another vendor's stream now); `resolve` |
| `malformed` | none exists: nothing valid was kept (a body that failed validation is deliberately never stored) | `resolve` is the only exit (`abandoned_operator`) |

### Operator routes (`routes/ack-quarantine.routes.ts`, all under `/api/v1/billing/commercial/ack-quarantine`)

`GET ?providerEntityId` (read + provider scope; ids, reason, control number, age, `hasEvent`; no payload), `POST /replay`, `POST /:id/resolve`,
`POST /abandon-foreign` (org-wide, so it needs an organization-wide billing scope, else 403). Mutations: `commercial_billing.submit`, provider
scope (404 outside it), a FRESH step-up, no AI actor, `Idempotency-Key`. Handlers use the org-explicit `inOrg` seams. Each closure is the row's
write audit plus one `m41.claim.ack_abandoned` event carrying `operatorUserId`; a row already resolved answers `already_resolved` and publishes nothing.
`abandonForeignHeldEvents` now has its authenticated route and an optional operator id.

### Claim status on the port (vendor-UNVERIFIED)

- `fetchClaimStatus(ctx, controlNumber, inquiry?)`: `ClaimStatusInquiry` carries billing provider, TRANSIENT subscriber (never returned or logged) and
  service dates; the payer is `ctx.payerId`. `AckWorkerDeps.inquiries` is the source of that block (M5 coverage seam in production); **it is not wired in
  `apps/backend/src/index.ts`**, so production still passes none, and Stedi (which refuses without one) reads "unavailable". A port answering null means
  the claim cannot be asked about and no transport call is made.
- Stedi: the request builder and parser from round 2 are now called by `StediTransport.fetchClaimStatus` (POST, platform key, no redirect, 30 s timeout; an NPI
  that differs from the context is refused; 4xx/5xx map through the existing failure table). Tested against injected `fetch` fixtures only. **Nothing here is
  sandbox-verified:** endpoint path, request/response field names and the 277 category-code mapping are as remembered, and `usage: test` is not known to select
  vendor test mode on this endpoint.
- direct-MAC: stays `CH_NOT_WIRED` (no 276 channel at the MAC portal; the repo's only parsers are 999 and 277CA). Contract-tested to refuse even with a full inquiry.

## Still blocked / impossible without Stedi sandbox access

1. Confirming the 276/277 endpoint path, field names and category-code mapping (`STEDI_TRANSPORT_CONTRACT` row `fetchClaimStatus` stays **U**); whether the test key
   reaches vendor test mode there; how a payer "not found" is actually returned.
2. A verified mapping from a 277 to an `AckEvent`: `latest` is always null, so an inquiry reports state but cannot apply an acknowledgment.
3. Production wiring of `inquiries` (subscriber from M5's coverage seam, service dates from the claim) is deliberately left unwired until (1) is done; wiring it
   earlier would send subscriber PHI to an unverified endpoint.
4. Stedi `fetchAcknowledgments` itself is still `CH_NOT_WIRED`, so under a Stedi binding no held answer is produced by the pull today; the replay and routes are proven
   against the in-memory transport.
5. A `malformed` row cannot be replayed by design (it stores no body).
