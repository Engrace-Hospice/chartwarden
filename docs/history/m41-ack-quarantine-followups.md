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
    blip; the 45-day age sweep still applies). Org-scoped through `inOrg` plus an explicit filter; idempotent; bounded per call. There is
    deliberately no HTTP route yet: exported for an operator script or a later admin route.
- **Stedi 276/277.** `packages/x12-837-client/src/clearinghouse/stedi-claim-status.ts` holds a request builder and response parser with
  fixture-style tests. It is **unbound and unverified**.

## Still blocked (why #820 stays open, narrowed)

1. **Stedi 276/277 is not sandbox-verified** (STEDI_TRANSPORT_CONTRACT row `fetchClaimStatus` is U). The endpoint path, field names and the
   277 category-code mapping in `stedi-claim-status.ts` come from the published shape as remembered, not from an observed answer. Until a
   sandbox run confirms them, `StediTransport.fetchClaimStatus` keeps answering stable `CH_NOT_WIRED` (never `not_found`).
2. **The port cannot carry the inquiry.** A 276 needs subscriber, payer and service dates; `fetchClaimStatus(ctx, controlNumber)` supplies
   none. Wiring needs a port change (a context-supplied inquiry source) as well as the sandbox run. The parser never returns `not_found` and
   always returns `latest: null`, so even when wired it reports a state and applies no acknowledgment until a verified ack mapping exists.
3. The direct-MAC transport is untouched (still `CH_NOT_WIRED`).
