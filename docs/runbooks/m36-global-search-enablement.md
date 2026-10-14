# Runbook: enabling M36 global search in production (ADR-0058 / WP 2.7b)

Global search ships **inert**. This is the operator sequence that turns it on for one tenant. It is ordered; every stage has a check and a
rollback. The design and the reasons are in [ADR-0058](../adr/ADR-0058-messaging-global-search-blind-token-index.md); the body-key side is
[m36-body-key-ring.md](./m36-body-key-ring.md). **Nothing here is done by merging code.** Each stage is an operator action on production.

**Gate zero: the ADR-0058 design review.** Read [the review record](../reviews/ADR-0058-design-review-2026-10-13.md). Its conditions are
preconditions of Stage 6 below. The review is an AI desk review pending human sign-off; do not treat the platform flag as attested until a
named security architect and privacy officer have signed it and the measured leakage experiment has passed.

## What gates a tenant

| Gate | Where it is enforced | Who sets it |
|---|---|---|
| `REDIS_URL` (Valkey) so the search limiter is cluster-wide | `buildGlobalSearchRateLimit`: no shared store means no limiter, the route 503s and the checklist reports `RATE_LIMIT_INACTIVE` | deployment env |
| No legacy-envelope body (`message`, `message_revision`) for the tenant | checklist `LEGACY_BODIES_PRESENT` (409 on the switch) | WP 2.13 backfill |
| `messaging.global_search_escrow_attested` (platform row, org NULL) | checklist `ESCROW_NOT_ATTESTED` | ops, only after a real drill |
| `messaging.global_search_platform_enabled` (platform row, org NULL) | checklist `PLATFORM_FLAG_OFF`; **re-read on every query and every index write**, so it is also the kill switch | ops, only after the leakage review |
| Tenant switch `PUT /api/v1/messaging/global-search/settings {enabled:true}` | needs `messaging.global_search.manage` plus fresh step-up `messaging.global_search.configure`; 409 with the failing checks | org admin |
| Index `ready` | query path stays closed until reconcile reports zero drift; progress is `rebuild` on `GET .../settings` | automatic (`messaging.search_maintenance` worker) |

A tenant-scoped `feature_flag` row can **never** satisfy the platform or escrow checks; both read the `organization_id IS NULL` row only.

## Stage 1: Valkey and `REDIS_URL`

1. Provision Valkey (the compose service `valkey`, or the managed equivalent). Not Redis: the repo targets Valkey 8.
2. Set `REDIS_URL` in the production env. The same variable feeds the rate-limit store, BullMQ workers (including
   `messaging.search_maintenance`), presence/typing and the idempotency replay guard.
3. Restart the api and worker.

Check: boot log shows no "configure REDIS_URL" warnings for the M29/M31/M36 workers; `GET /api/v1/messaging/global-search/settings` as an org
admin shows `checklist.rateLimitActive: true`. If it is `false`, the store fell back to in-memory: stop, do not continue.
Rollback: unset `REDIS_URL` (search then refuses; other features degrade to per-replica limits as before).

## Stage 2: platform key provider (ring seal scheme)

Search tags derive from the tenant DEK ring, so the platform key path must work before anything is indexed.

1. Confirm `M34_TENANT_KEK` and `DATABASE_PLATFORM_URL` are set and every active tenant has a provisioned, non-destroyed row in
   `tenant_key_ring` (see Stage 2 of the key-ring runbook; a tenant without one cannot send once sealing is on).
2. Re-run `bun run db:provision-roles` (the platform login needs its grants) **before** deploying a build that sets the scheme.
3. Set `M36_BODY_SEAL_SCHEME=ring` and restart. The boot validates the value and refuses an unusable ring.

Check: boot line `M36 message bodies: ...` is `ring_only` or `legacy_rows_key_present`; `bun run check:boot:platform` is green.
Rollback: set `M36_BODY_SEAL_SCHEME=legacy`. Ring rows already written stay readable. **Never roll the build back below WP 2.13 after this.**

## Stage 3: key escrow and a real restore drill

This is a physical, dual-control procedure. **The environment flag in Stage 4 is a self-attestation; it proves nothing.** The record is the evidence.

1. Custodians: three distinct natural persons (security officer, CTO, a break-glass vault under someone else's dual control), Shamir 2-of-3, in
   a different failure domain from the SOPS age-key envelopes. Applies to `MESSAGING_ENCRYPTION_KEY` **and** `M34_TENANT_KEK` (with its retired
   entries); `tenant_key_ring` is in the backup set.
2. Run the drill in a clean environment from a **restored copy**, not production: reconstruct each key from two shares; decrypt a sampled body
   and a sampled revision and check `sha256(plaintext) == body_sha256`; unwrap a sampled tenant DEK from a restored `tenant_key_ring` row and
   decrypt a sampled ring body. Helpers: `bun run m36:restore-drill` and `bun run m36:restore-drill:detect`; the procedure is
   [m36-restore-drill.md](./m36-restore-drill.md).
3. Record: date, the three custodians, key versions, sampled row counts, result, who witnessed. File it where the compliance record lives.
4. Re-drill after every custodian change and yearly (ADR-0058 verification, "Escrow independence").

Do not continue until the record exists.

## Stage 4: backfill the tenant's bodies (WP 2.13)

Follow Stage 3 of [m36-body-key-ring.md](./m36-body-key-ring.md) exactly. Summary for the operator shell, one tenant at a time:

```
export M36_BODY_BACKFILL_ESCROW_DRILL_CONFIRMED=true      # this shell only, only after the Stage 3 record exists
export DATABASE_BODY_BACKFILL_URL=postgres://wardenx_body_backfill_login:...   # operator-held
bun run m36:body-backfill -- --org <organization-uuid> --dry-run
bun run m36:body-backfill -- --org <organization-uuid> --max-rows 2000        # repeat until "complete": true
```

Check, per tenant: `messaging.hash_verify` (or the nightly) reports zero mismatches and `legacyBodies` is 0 in the `m36.hash_verify.run` audit
context. The tenant switch refuses ON (409 `LEGACY_BODIES_PRESENT`) until this is true; that refusal is your safety net, not a substitute.
Drafts and scheduled messages are not backfilled; the legacy key stays until none remain. Never set the drill variable in `.env.production`.

## Stage 5: the escrow attestation flag

Only after Stages 3 and 4 are on record, an authorised platform operator sets the platform-global row (organization NULL) for
`messaging.global_search_escrow_attested` through the M34 platform feature-flag admin (`PUT /api/v1/platform/feature-flags`; take the exact body
and the required platform permission from `docs/api/openapi.json`). It is audited. It is a statement of fact: set it only when the drill record
exists. To withdraw it, set it false.

## Stage 6: the leakage test and the platform flag

`messaging.global_search_platform_enabled` is the ops attestation that the leakage review passed, **and** the kill switch.

Preconditions, all recorded:

1. The design review's human sign-off (security architect and privacy officer), and every condition in the
   [review record](../reviews/ADR-0058-design-review-2026-10-13.md) closed.
2. The measured leakage experiment (ADR "Design review requirement" item 2) run at `T = 19` on synthetic hospice notes, with the result and the
   pass criterion in the record. If it has not been run, the flag stays off. No code enforces this; it is a control by discipline, so name the
   person who attested.
3. The HIPAA risk-analysis entry for the new PHI-derived store is filed.
4. Product-owner acceptance of the residual risk.

Then set the platform row true (same admin as Stage 5). The kill switch is the same row set false
(`POST /api/v1/platform/feature-flags/:flagKey/kill-switch` is the audited emergency form). It overrides every tenant ON and stops the query path
and the indexer on the next request.

## Stage 7: switch one tenant on, then verify the index build

1. An org admin with a fresh step-up: `PUT /api/v1/messaging/global-search/settings {"enabled":true}`. A 409 lists the failing checks; fix those,
   do not work around them.
2. Turning ON starts the rebuild: the `messaging.search_maintenance` worker reconciles each enabled tenant on its tick. There is no manual build
   command, and none is needed. It is resumable and safe to leave running.
3. Watch `GET /api/v1/messaging/global-search/settings`: `rebuild` progresses to complete and the index to `ready`. Until then queries are
   refused (the path fails closed), which is correct.
4. Smoke test as a user in that tenant: a known word in a channel they can read returns the message; the same word in a channel they cannot read
   returns nothing; 31 queries in a minute return 429; the audit log has the read events and **no query text or tags** (check one row).
5. Enable the next tenant only after the first has run a day with a clean `hash_verify` and no search 5xx.

## Rollback and kill

| Need | Action | Effect |
|---|---|---|
| Stop all search now | platform flag `messaging.global_search_platform_enabled` false (or the kill-switch route) | queries and indexing refuse on the next request; rows stay |
| Stop one tenant | admin `PUT .../settings {"enabled":false}` | query path refuses; purge deletes the tenant's token rows; ON is refused while a purge is in progress |
| Withdraw the escrow claim | escrow flag false | new tenant ONs are refused |
| Roll back sealing | `M36_BODY_SEAL_SCHEME=legacy` | new writes legacy again; ring rows remain readable |

## Do not

- Do not set the escrow or platform flag to make a checklist pass. They are statements of fact.
- Do not run the backfill without the Stage 3 record, against the shared dev cluster, or with the drill variable in a committed env file.
- Do not rotate or remove `MESSAGING_ENCRYPTION_KEY` or `M34_TENANT_KEK` during the backfill window.
- Do not enable more than one tenant before the first is verified.
