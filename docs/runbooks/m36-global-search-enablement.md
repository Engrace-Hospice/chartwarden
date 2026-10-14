# Runbook: enabling M36 global search in production (ADR-0058 / WP 2.7b)

Global search ships **inert**. This is the operator sequence that turns it on for one tenant. It is ordered; every stage has a check and a
rollback. The design and the reasons are in [ADR-0058](../adr/ADR-0058-messaging-global-search-blind-token-index.md); the body-key side is
[m36-body-key-ring.md](./m36-body-key-ring.md). **Nothing here is done by merging code.** Each stage is an operator action on production.

**Gate zero: the ADR-0058 design review.** Read [the review record](../reviews/ADR-0058-design-review-2026-10-13.md). Its conditions are
preconditions of Stage 6 below. The review is an AI desk review pending human sign-off; do not set the leakage-attested flag until a
named security architect and privacy officer have signed it and the measured leakage experiment has passed.

**What changed on 2026-10-13 (product-owner decisions, ADR-0058 amendment).** Patient and contact **names are never indexed**, and tags are
**keyed per channel**. Operationally: migration 1096 empties the token table and marks every index state `stale`, so a tenant that was already ON
rebuilds from the start (queries answer 503 `GLOBAL_SEARCH_INDEX_NOT_READY` until `ready`); see Stage 6c.

## What gates a tenant

| Gate | Where it is enforced | Who sets it |
|---|---|---|
| `REDIS_URL` (Valkey) so the search limiter is cluster-wide | `buildGlobalSearchRateLimit`: no shared store means no limiter, the route 503s and the checklist reports `RATE_LIMIT_INACTIVE` | deployment env |
| No legacy-envelope body (`message`, `message_revision`) for the tenant | checklist `LEGACY_BODIES_PRESENT` (409 on the switch) | WP 2.13 backfill |
| `messaging.global_search_escrow_attested` (platform row, org NULL) | checklist `ESCROW_NOT_ATTESTED` | ops, only after a real drill |
| `messaging.global_search_leakage_attested` (platform row, org NULL) | checklist `LEAKAGE_NOT_ATTESTED`; gates the tenant ON only | ops, only after the measured leakage experiment passed and the humans signed |
| `messaging.global_search_platform_enabled` (platform row, org NULL) | checklist `PLATFORM_FLAG_OFF`; **re-read on every query and every index write**, so it is the kill switch | ops, to turn the feature on (after the leakage attestation) and to kill it |
| Tenant switch `PUT /api/v1/messaging/global-search/settings {enabled:true}` | needs `messaging.global_search.manage` plus fresh step-up `messaging.global_search.configure`; 409 with the failing checks | org admin |
| Index `ready` | query path stays closed until reconcile reports zero drift; progress is `rebuild` on `GET .../settings` | automatic (`messaging.search_maintenance` worker) |

A tenant-scoped `feature_flag` row can **never** satisfy the platform, escrow or leakage checks; all read the `organization_id IS NULL` row only.

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

## Stage 6: the leakage attestation, then the platform flag

Two separate platform rows. `messaging.global_search_leakage_attested` is the statement that the leakage review passed (checklist item,
read from the org-NULL row only, fail closed). `messaging.global_search_platform_enabled` is the kill switch and nothing else: it turns the
feature on and off and is re-read on every query and index write.

Preconditions for the leakage-attested flag, all recorded:

1. The design review's human sign-off (security architect and privacy officer), and every condition in the
   [review record](../reviews/ADR-0058-design-review-2026-10-13.md) closed.
2. The measured leakage experiment (ADR "Design review requirement" item 2) run at the sized `T` (and 19) on synthetic hospice notes, with the result and the
   pass criterion in the record, and the person who attested named. The 2026-10-13 re-run (names excluded through the production path, per-channel keys
   measured for the name attack only) is [section 7 of the experiment record](../reviews/ADR-0058-leakage-experiment-2026-10-13.md); the vocabulary attacks
   against per-channel keys and a production-shaped corpus are still to be run.
3. The HIPAA risk-analysis entry for the new PHI-derived store is filed.
4. Product-owner acceptance of the residual risk.

Then:

1. Set `messaging.global_search_leakage_attested` true (same admin as Stage 5). Set it only after the experiment passed and the humans signed;
   it is a statement of fact. To withdraw it, set it false (new tenant ONs are refused; already-ON tenants are not affected).
2. Set `messaging.global_search_platform_enabled` true to allow the feature to run. The kill switch is the same row set false
   (`POST /api/v1/platform/feature-flags/:flagKey/kill-switch` is the audited emergency form). It overrides every tenant ON and stops the query
   path and the indexer on the next request.

## Stage 6b: pre-enablement check for excluded identities already in channels (now a checklist item)

Since the F6 follow-up this check is computed: `GET /api/v1/messaging/global-search/settings` reports `checklist.excludedMembersCleared`, and the enable PUT is refused
with `EXCLUDED_MEMBERS_PRESENT` while it is false. The manual SQL below is kept to list WHICH rows to remove (the checklist only says whether any exist).

The member-category gate (`member-category-gate.ts`, review finding F6) refuses NEW `channel_member` writes for an identity holding a
`patient_family`, `external_auditor` or `platform_staff` role. It does not sweep rows written before the gate shipped, nor rows whose
holder was granted an excluded role afterwards. Such a member still reads channel history through the channel-member path. So, per tenant,
before Stage 7 (read-only). These tables are under RLS: run it in `psql` as a role that bypasses RLS (platform operator), or after setting the
tenant GUC `app.org_id` to the organization. Platform-template `role` rows have a NULL organization, and that is where `platform_staff`
roles live, so confirm the role you use can read them (a query that silently skips them gives a false "zero rows"). Set the variable with
`\set org_id '<organization-uuid>'` and the query uses `:'org_id'`:

```sql
SELECT DISTINCT cm.channel_id, cm.user_id, cm.role, cm.source, r.key AS excluded_role, r.category
FROM channel_member cm
JOIN membership m       ON m.user_id = cm.user_id AND m.organization_id = cm.organization_id
JOIN membership_role mr ON mr.membership_id = m.id AND mr.organization_id = m.organization_id
JOIN role r             ON r.id = mr.role_id
WHERE cm.organization_id = :'org_id'
  AND m.status <> 'revoked'
  AND cm.removed_at IS NULL
  AND r.category IN ('patient_family', 'external_auditor', 'platform_staff')
  AND (mr.expires_at IS NULL OR mr.expires_at > now());
```

A disabled role still counts (the gate lets deny win), so the query does not filter on `r.enabled`. Require **zero rows**, or a recorded
removal decision per row (remove the member through the admin screen, or document why the identity stays) before the tenant switch.

Second known gap: neither `addMember` nor the DM path requires the target to hold a membership in the same organization
(`channel_member.user_id` references users only); `assertActiveMessagingUser` does check an active same-org membership on both of those paths,
but the gate itself and the provider and announcement creator rows do not, and the SQL above cannot see a user with no membership in the org.
Tracked as a follow-up in the review record (F6 residual).

## Stage 6c: name exclusion and per-channel keys (operator view)

1. **Deploy order.** Migrate (1096), then deploy. 1096 truncates `message_search_token` and sets every `message_search_index_state` row to `stale` with no
   checkpoint. Search is inert until enabled, so a clean rebuild is the intended path; an environment where it was already ON loses search until the next
   `messaging.search_maintenance` tick(s) finish the sweep (watch `rebuild` on `GET .../settings`).
   **Migrating before the rollout is safe only while the platform flag is absent and the indexer is stopped.** 1096 adds `message_search_token.channel_id NOT
   NULL`; pods still on the old image insert token rows without it and would fail (the indexer's writes error and retry). Do not set the platform flag, and keep
   the indexer/maintenance worker off, until every pod runs the new image.
2. **The name source must be wired.** `apps/backend/src/index.ts` injects M5's `patientNameFragmentsPageForOrg` into the writer, the maintenance worker and the
   query route. Without it the first index write of a tenant and every query fail closed (503 `GLOBAL_SEARCH_UNAVAILABLE`, error name
   `NameExclusionNotConfiguredError` in the logs). A tenant's first tick reads all patient, alias, caregiver and emergency-contact names and stores **keyed
   digests only**. Check (read-only, as an RLS-bypassing role, never print the arrays):

   ```sql
   SELECT organization_id, key_version, status, tag_bits,
          cardinality(excluded_name_digests) AS excluded_tokens,
          cardinality(exclusion_pending) AS pending_reindex, exclusion_synced_at
   FROM message_search_index_state;
   ```

   `excluded_tokens` should be roughly the number of distinct name tokens of the tenant (0 for a tenant with no patients is correct); `exclusion_synced_at` is within
   the last tick. `pending_reindex` is non-zero only for a few minutes after a new patient or contact appears.
3. **New and changed names.** A new patient's name is excluded at the next tick (at most 5 minutes) plus the writers' 1-minute cache; messages already indexed with
   it are rewritten after a further 2-minute delay (targeted, at most 30 s of work per tenant per tick; `pending_reindex` returns to 0). A renamed or removed patient
   leaves the old name excluded. Shrinking the set is a full rebuild (set the state `stale`), an operator decision, not a routine.
4. **What users are told.** A patient's or contact's name cannot be found by search; a name that is also an ordinary word (Grace, Hope, Will, Young) is unsearchable as a
   word; a name nobody recorded in M5 (a nickname, a misspelling) and staff or place names ARE indexed. The static statement belongs in the tenant notice and the search-box
   contract; the query path deliberately returns an ordinary empty result for a name (a distinct response would let users enumerate patient names).
5. **Tag width `T`** is sized per tenant from the stored row count (`clamp(round(log2(rows / 150)), 12, 20)`): a new index uses the tenant's messages x 16, a verified
   build re-measures, and a stored width 2 or more bits off is rebuilt (search closed until `ready`). `tag_bits` is in the query above. A small tenant sitting at 12 is correct.
6. **Channel cap.** A user searches at most their 300 most recently active channels (member channels plus announcements); above that the response carries
   `scanCapped: true`. Head buckets are recorded per `(channel, tag)`; a channel whose every query term is a head bucket is skipped and the response is flagged `scanCapped`.
7. **Rotation.** A new ring version is a rebuild with search closed; when the new version is `ready` its transaction removes every other version's rows and state (verify:
   `SELECT key_version, count(*) FROM message_search_token WHERE organization_id = ... GROUP BY 1` shows one version).

## Stage 7: switch one tenant on, then verify the index build

1. An org admin with a fresh step-up: first `GET /api/v1/messaging/global-search/settings`, show `notice.text` to the admin (the written tenant notice of
   whole-history discoverability must already have been sent, review condition 12), then `PUT ... {"enabled":true,"acknowledgedNoticeVersion":"<notice.version>"}`.
   A 409 `GLOBAL_SEARCH_NOTICE_NOT_ACKNOWLEDGED` means the acknowledgement is missing or the notice changed (re-read the GET). A 409
   `GLOBAL_SEARCH_PREREQUISITES_UNMET` lists the failing checks; fix those, do not work around them. Who acknowledged which version and when is stored
   on the setting row (`notice_ack_*`) and is in the audit trail.
   Every search response is held to a fixed minimum duration (about 1.5 to 2 s, ADR-0058 amendment, F1): a search that returns instantly is a bug.
2. Turning ON starts the rebuild: the `messaging.search_maintenance` worker reconciles each enabled tenant on its tick. There is no manual build
   command, and none is needed. It is resumable and safe to leave running.
3. Watch `GET /api/v1/messaging/global-search/settings`: `rebuild` progresses to complete and the index to `ready`. Until then queries are
   refused (the path fails closed), which is correct.
4. Smoke test as a user in that tenant: a known word in a channel they can read returns the message; the same word in a channel they cannot read
   returns nothing; a patient's surname that appears in a message returns nothing (names are excluded) while another word of the same message finds it; 31 queries in a minute return 429; the audit log has the read events and **no query text or tags** (check one row).
5. Enable the next tenant only after the first has run a day with a clean `hash_verify` and no search 5xx.

## Rollback and kill

| Need | Action | Effect |
|---|---|---|
| Stop all search now | platform flag `messaging.global_search_platform_enabled` false (or the kill-switch route) | queries and indexing refuse on the next request; rows stay |
| Stop one tenant | admin `PUT .../settings {"enabled":false}` | query path refuses; purge deletes the tenant's token rows; ON is refused while a purge is in progress |
| Withdraw the escrow claim | escrow flag false | new tenant ONs are refused |
| Withdraw the leakage claim | leakage-attested flag false | new tenant ONs are refused (does not stop running tenants; use the kill switch for that) |
| Roll back sealing | `M36_BODY_SEAL_SCHEME=legacy` | new writes legacy again; ring rows remain readable |

## Do not

- Do not set the escrow, leakage-attested or platform flag to make a checklist pass. They are statements of fact.
- Do not run the backfill without the Stage 3 record, against the shared dev cluster, or with the drill variable in a committed env file.
- Do not rotate or remove `MESSAGING_ENCRYPTION_KEY` or `M34_TENANT_KEK` during the backfill window.
- Do not enable more than one tenant before the first is verified.
