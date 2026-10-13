# ADR-0058 — Global message search is a per-tenant HMAC blind-token index (whole-word and prefix only), re-checked against current access at query time

- **Status:** **Proposed**
- **Gate:** a design review by the **security architect and the privacy officer** is a hard precondition to acceptance. It gates **both
  building WP 2.7b and enabling it in production** (D10, decided 2026-10-11 by the product owner, who chose option B (D3) knowing it
  leaks token frequency). Do not implement WP 2.7b, and do not mark this Accepted, until the review in "Design review requirement"
  has passed and its record is linked here. WP 2.7b is additionally **blocked on the two prerequisite work packages** in "Prerequisites"
  (key-ring migration of message bodies; per-route rate limit). In-conversation search (WP 2.7a, option A) does not depend on this ADR.
- **Date:** 2026-10-11 (revised 2026-10-13 after design review feedback; Status unchanged)
- **Phase:** Messaging Hub Phase 2 (WP 2.7b). Needed before Phase 2 work on global search starts.
- **Extends:** [ADR-0038](ADR-0038-app-layer-envelope-encryption.md) (app-layer envelope encryption) and
  [ADR-0045](ADR-0045-platform-kek-custody.md) (KEK custody) for key derivation; plan `02` §6.
- **Related:** [ADR-0055](ADR-0055-message-revisions-and-redaction.md) (redaction and revisions - what is indexed and when it is removed),
  [ADR-0010](ADR-0010-tenancy-rls-invariants.md), [ADR-0011](ADR-0011-ownership-inversion-rls-bypass.md),
  [ADR-0051](ADR-0051-legal-hold-is-an-overlay-not-a-retention-class-flip.md) (derived data is not the record).

> **How to read decisions in this document.** Items marked **User decision** were taken by the user (2026-10-13) and are
> authoritative. Items marked **Proposed default, for security/privacy reviewers to confirm** are this ADR's recommendation, accepted
> provisionally by the user ("go with your recommendations"), and the reviewers may change them.

## Context

- Message bodies are envelope-encrypted per tenant: `message.body_cipher` (`packages/db/src/schema/messaging/messages.ts`), AES-256-GCM,
  and `message_revision.body_cipher` for replaced bodies (ADR-0055). **Today** the tenant DEK is HKDF-derived from the single master
  `MESSAGING_ENCRYPTION_KEY` and the org id (`packages/messaging/src/crypto/body-crypto.ts`: `deriveOrgDek`, line 43;
  `DEK_INFO_PREFIX = "wardenx-message-dek:"`, line 24). The DEK is a pure function of one env var and the org id, so it is always
  recomputable: there is no key row to destroy, and "destroying the tenant DEK" is, in the code's own words, "modelled by forgetting
  the org's derived key". A normal database index would hold plaintext or be useless.
- A second key model exists: the `TenantKeyProvider` seam (`packages/saas-tenant-platform/src/seams/tenant-key-provider.ts`) returns a
  versioned `TenantDek` unwrapped from M34's `tenant_key_ring`, and a destroyed ring is the cryptographic shred (`dekForOrg` raises).
  Nothing under `apps/backend/src/modules/36-messaging` uses it yet.
- Plan `02` §6 compares A (decrypt-and-filter over an authorised candidate set), B (per-tenant encrypted blind-token index),
  C (plaintext `tsvector` under RLS). D3 (2026-10-11): global search is wanted; option B; A ships first for in-conversation search.
- The plan fixes the shape: HMAC key per tenant derived from the DEK hierarchy and rotated with it; word plus prefix tokens, no raw
  trigram of short strings; padding/bucketing; no server-side phrase or proximity ranking; entries deleted on redaction and tenant
  erasure; resumable rebuild from ciphertext; candidates re-filtered by current access; read audit per result page; known limit
  whole-word and prefix only. This ADR turns that into a decision and states the leakage honestly.
- Tenant erasure today overwrites `message.body_cipher` and deletes rows (`packages/messaging/src/destruction`,
  `apps/backend/src/modules/36-messaging/erasers/messaging-eraser.ts`); the index must be erased with it or it survives.
- Read-audit lesson (repo CLAUDE.md): a read config without `resourceIdParam` leaves no trail; search results need a live assertion.
  See "Read audit" for what the hook can and cannot record for a route with no `:id`.

## Prerequisites (new work packages, both gate WP 2.7b)

### P1. Migrate message bodies to the M34 wrapped-DEK ring (User decision: key model option (b))

**User decision (2026-10-13):** WP 2.7b is gated on first migrating `message.body_cipher` **and** `message_revision.body_cipher` from
HKDF-from-`MESSAGING_ENCRYPTION_KEY` to the M34 wrapped-DEK ring (`TenantKeyProvider`), giving a real crypto-shred and real rotation.
The earlier draft's claim that "destroying the tenant key makes the index unusable by construction" is **withdrawn**: under the
current scheme there is no tenant key to destroy (body-crypto.ts:24,43), so it was false. After P1 it becomes true, and only then.

Scope of P1 (its own WP, number to be taken in the plan; sized as a data migration, not a code tweak):

1. A new envelope `VERSION` byte in `body-crypto.ts` (today `VERSION = 1`) that also records the DEK key-ring version, so old and new
   envelopes coexist during the migration and decrypt picks the key by envelope version.
2. `dekForOrg` / `dekForOrgVersion` from `TenantKeyProvider` replace `deriveOrgDek` on the write path; the legacy derivation stays
   decrypt-only until the backfill completes, then is removed.
3. A resumable, tenant-scoped re-encryption job over `message` and `message_revision`. `body_sha256` is the hash of the **plaintext**
   and is unchanged by re-encryption (the hash-verify job still passes). **Caveat to resolve in P1:** `wardenx_app` has no UPDATE on
   `message_revision` (ADR-0055), so the job needs an explicitly granted, audited path for re-wrapping revision ciphertext, or a
   copy-and-swap; this must not weaken the append-only guarantee for ordinary code.
4. The messaging eraser becomes a real shred: destroy the ring (M34 `tenant-key-destruction-log`), plus row deletion as today.
5. Rotation of the message DEK becomes possible (the runbook §8.3.3 limitation that `MESSAGING_ENCRYPTION_KEY` is not rotatable no
   longer applies to bodies); update the ops runbook and `02` §6.
6. Live tests: pre- and post-migration envelopes both open; mixed-version rows during backfill; after ring destruction every body and
   revision fails to open; rotation re-encrypts under the new version; revision rows migrate.

Doing P1 before launch is far cheaper than after (there is no production search to re-key). P1 is also the only way the claims in
"Keys" and the eraser verification below are true.

### P2. A per-route rate limit mechanism (Proposed default, for security/privacy reviewers to confirm)

Verified against the code: the repo has **only the global SD-055 limiter** (`apps/backend/src/bootstrap/plugins/security.ts`: 600
requests/min for any authenticated caller, 30/min unauthenticated; bucket keyed by `org:<id>` when org-bound, else `user:<id>`, else
IP; Valkey-backed through `rate-limit-store.ts` when `REDIS_URL` is set; **fails open** on a store error). It is one org-wide
bucket across every route, so it neither limits a single user's search probing nor protects the decrypt budget. The 2.7a service says
the same ("No per-route rate limit exists in this repo", `message-search-service-db.ts`). A per-route limit is therefore a prerequisite
for the global search route, because search is an oracle and a decrypt-cost amplifier:

- A route-level `config.rateLimit` (or equivalent preHandler) that reuses `RateLimitStore.increment(key, windowMs)` with keys
  `search:user:<orgId>:<userId>` and `search:org:<orgId>`.
- **Placeholder numbers, to be tuned by the reviewers:** 30 requests/min/user and 300 requests/min/org on the global search route.
- Over limit: `RateLimitedError` (429) with `Retry-After`. Store unavailable: for this route **fail closed** (503), unlike the global
  limiter, because here the limiter is a probing control, not only an availability one. (Proposed default.)
- **Required test:** live (Valkey `valkey/valkey:8`, not Redis): the 31st request in a minute by one user is 429; a second user in the same org
  is unaffected until the org cap; the org cap is shared across replicas (two app instances, one store); a store outage returns 503
  on this route and the limiter on other routes still fails open.

## Decision

1. **Scope.** The index covers the **head body of each non-deleted, non-redacted message** only (not revisions, not drafts, not
   attachments). Indexing runs in a worker driven by `m36.message.sent.v1` / `m36.message.revised.v1` outbox events and is therefore
   eventually consistent; the UI states that new messages may take seconds to appear. The index is derived data, never the record.
   Wire the worker's consumer factory in `apps/backend/src/index.ts` (grep for it; `arch:outbox-bindings` does not prove it is wired).
2. **Keys (after P1).** `K_search(org, v) = HKDF-SHA256(ikm = TenantDek.key, salt = "", info = "wardenx-message-search:" || orgId || ":v" || v)`
   where `TenantDek` is the unwrapped M34 DEK for key-ring version `v` and the info label is distinct from the body-encryption label,
   so the two keys are domain-separated. `v` is stored on every index row. Rotation: a new ring version, rebuild under it, query both
   during the overlap, then delete the old version's rows. **Ring destruction (P1) makes the index unusable** because `K_search` can no
   longer be derived for any version and the tags are indistinguishable from random without it; the eraser still deletes the rows
   (the index is PHI-derived, so it is not left behind on the argument that it is unreadable). If P1 has not shipped, 2.7b does not.
3. **Tokenisation (server-side, deterministic).** Unicode NFKC, lowercase, split on non-alphanumerics; also split at letter/digit
   boundaries (so "5mg" gives "5" and "mg"; confirm with clinical input); drop tokens shorter than 2 and a small stop-word list;
   drop tokens longer than 64. **Numeric and ID-like tokens are not indexed** (digit-only tokens, and identifier-shaped tokens such
   as MRN-like or long digit/letter strings; free-text identifiers are never indexed), so "5mg" yields only "mg". **Patient names are
   not indexed in v1 (Proposed default, for security/privacy reviewers to confirm):** the earlier per-tenant patient-name flag is
   removed; a name typed in a message is indexed as an ordinary word like any other, and no patient-name lookup feeds the index.
   **English only at launch**, behind a **pluggable tokeniser** interface so other languages and diacritic policies can be added later
   without changing the index shape (D10, decided 2026-10-11 by the product owner). The exact definition of "ID-like" is for the
   reviewer to fix. Each distinct token yields:
   - a **whole-word tag** `HMAC(K, "w\0" || token)`;
   - **prefix tags** `HMAC(K, "p\0" || len || "\0" || prefix)` for prefix lengths 3 to min(len, 12). No prefix shorter than 3, no
     infix/suffix grams, no trigram of short strings, no character positions or word order stored.

   **Golden clinical cases** (the unit suite asserts these exact outputs; `n` counts whole + prefix tags before padding):

   | Input | Tokens | Tags | `n` |
   |---|---|---|---|
   | `morphine` | `morphine` | whole(`morphine`); prefix lengths 3..8: `mor`, `morp`, `morph`, `morphi`, `morphin`, `morphine` | 7 |
   | `5 mg` | `mg` (`5` is digit-only, dropped) | whole(`mg`); no prefix tags (length 2 is under 3) | 1 |
   | `5mg` | `mg` (split at the letter/digit boundary, `5` dropped) | same as `5 mg` | 1 |
   | `MS Contin 15` | `ms`, `contin` (`15` dropped) | whole(`ms`); whole(`contin`) + prefix lengths 3..6: `con`, `cont`, `conti`, `contin` | 6 |
   | `MRN 12345678` | `mrn` (digit-only run dropped) | whole(`mrn`); prefixes `mrn` | 2 |

   Consequences made explicit: a clinician cannot search for a dose ("5 mg" is searchable only as "mg"), and `mg` is a very
   high-frequency token (the most leaked and least useful term). Whether `ms`/`mg` belong on the stop-word list is a reviewer call.
4. **Truncation and padding (leakage control, not a security proof).** Each tag is truncated to `T` bits (initial `T = 32`; tuned so a
   typical tenant has many distinct words per tag value). Collisions are intentional: they become false positives that step 8.5
   removes after decryption. **Padding:** for a message with `n` real tags (whole + prefix), the stored set is padded to
   `N = max(16, 2^ceil(log2 n))` rows, i.e. `dummies = N - n`. Each dummy is a uniformly random `T`-bit value from a CSPRNG, **not**
   derived from the message id, the key or the content, and is **re-randomised on every per-message replace and every rebuild**, so a
   rebuild does not reproduce (and an observer cannot link) a prior dummy set. Rows carry only
   `(organization_id, key_version, tag, message_id)`. Row order is not meaningful and `channel_id` is not duplicated into the index.
5. **Table.** `message_search_token` (working name), three-column rule (org column, RLS on `app.org_id`, FORCE, PHI write-audit
   trigger), index on `(organization_id, key_version, tag)`, FK on `message_id` index-covered. It is classified as PHI-derived for
   backup, erasure and DR purposes. `wardenx_app` may INSERT and DELETE; no UPDATE. **The write-audit trigger records only the message
   id** (and operation, org, actor), never the `tag` column, so the audit trail does not become a second copy of the index.
6. **Deletion, including the hook.** The removal hook is in the **same transaction** as the state change that makes a message
   ineligible, not only the `sent`/`revised` events:
   - **delete** (`status` to `deleted`): the delete path deletes the message's rows in the same transaction as the tombstone update;
   - **redact** (ADR-0055 item 7): the redaction request path deletes the rows in the same transaction as the request is recorded
     (see item 7 below for pending redactions);
   - **edit**: delete the old tags and insert the new in the same transaction as the revision write;
   - **retention destruction** of a message deletes its rows; **tenant erasure and ring destruction** delete all rows.

   An outbox-driven deleter is only the repair path (idempotent re-run), never the primary mechanism.
   **Legal hold (analogy to ADR-0051, not an application of it):** ADR-0051 decides that a hold is an overlay on the record and that
   derived data is not the record. By analogy, a legal hold does **not** keep index rows: the index is derived and can be rebuilt from
   the retained cipher when the hold lifts. A message that is **held and redacted** (ADR-0055 item 9 allows masking under hold) stays
   **out of the index**: hold preserves the cipher, never discoverability. The messaging hold/retention ADR (plan `02` §8) may refine
   this; it cannot make a masked message searchable.
7. **Redaction states.** *User decision:* a **pending** redaction (requested, before the ADR-0055 72-hour countersign and before it is
   final) is **hidden from search immediately**; the index rows are deleted at request time and are not restored if the redaction
   later lapses non-final unless the redaction record is explicitly withdrawn, in which case the repair path re-indexes. Note:
   ADR-0055 has not shipped redaction and its marker is undecided (a `redacted` `message_status` value or a nullable
   `redacted_at`/`redaction_id`; today `message_status` is `sent | edited | deleted`). The step 8.5 check below must read whichever
   marker WP 5.x lands; this ADR does not choose it.
8. **Query path** (all steps server-side, in one request):
   1. Authenticate; derive tenant from the session; per-route rate limit (P2).
   2. Tokenise the query the same way; build tags (whole-word for complete words, prefix tags for a trailing partial word of >= 3
      characters); reject queries with no indexable token with a message explaining the limit.
   3. **Coarse SQL prefilter** (see "Access control"): candidate `message_id`s by tag, `key_version` in the live versions, joined to
      `message` with `status <> 'deleted'`, restricted to channels where the user has an active `channel_member` row
      (`removed_at IS NULL`) **or** the channel is an `announcement` (org-wide, no membership row), ordered by recency, capped.
      **Multi-word queries are an AND-intersection in SQL:** with `k` distinct query tags,
      `... WHERE tag = ANY($tags) GROUP BY message_id HAVING count(DISTINCT tag) = $k`; the cap applies after the intersection.
   4. **Authoritative access check at channel granularity** (not per message): collect the distinct `channel_id`s of the candidates and
      pass them once through `effectivelyVisibleChannels` (the same function behind `canViewChannelFor`), then drop every candidate in
      a channel it does not return.
   5. Decrypt only the survivors, **within the decrypt budget** below. For each: re-verify on the **current decrypted row**
      (`status NOT IN ('deleted')`, the redaction marker per decision 7 is absent, the message is still the head body that was
      indexed), then verify the actual token/prefix matches against the plaintext (drops truncation collisions and dummies). Produce
      the page. Ranking is by recency; phrase/proximity ranking, if any, happens client-side after decrypt.
      **User decision:** a deleted or redacted message may remain in the index for a window of seconds after the state change if the
      hook in decision 6 has not yet committed for some reason, and that is acceptable **because** this step re-verifies on the current
      row regardless of the index. The index deletion is defence in depth, not the only control.
   6. Write the read audit (see "Read audit").
9. **Result bounds, under-fill and cursor.**
   - **Candidate cap** `CANDIDATE_CAP = 500` per request (initial, reviewer to tune), recency order, after the AND-intersection.
   - **Decrypt budget** `DECRYPT_BUDGET = 200` bodies and a wall-clock budget `DECRYPT_TIMEOUT_MS = 3000` per request, inside a
     `statement_timeout` of 5000 ms (matching 2.7a, which uses 5000 ms and `SEARCH_MAX_SCAN_PER_REQUEST = 5000` body opens for option A).
     On budget exhaustion the request returns what it has with `scanCapped: true`; it never extends the budget.
   - **Under-fill:** access filtering, step 8.5 and collisions can leave a page short of `limit` (default 20, max 50, as 2.7a). The
     response then carries a `nextCursor` whenever more candidates remain beyond the last one examined, plus `scanCapped`, so the UI
     offers "load more" instead of showing a silently truncated page. A short page with no `nextCursor` is the true end.
   - **Cursor:** a keyset on `(created_at, message_id)` of the last **examined** candidate (the same `message-cursor` codec as 2.7a).
     It **never encodes a tag, a token, a query hash or any value derived from the query**; the client re-sends `q` and the server
     re-derives the tags on every page. A leaked cursor therefore reveals a timestamp and a message id the holder could already read.
10. **Operational leakage hygiene.** Tags are always bound parameters; database statement logging, `pg_stat_statements` parameter
    capture, `auto_explain` and slow-query logs must not record them. **Owner and control:** the platform/DBA role (owner named in
    the ops runbook, `docs/architecture/WARDENX_OPS_RUNBOOK_v0.1.md`, as a new checklist item "search tags are not logged") owns the
    setting, and it is verified two ways: (a) a **runbook item** run at each environment change and each CNPG upgrade (ADR-0050):
    `SHOW log_statement`, `log_min_duration_statement` (set high or `-1` for the app role), `auto_explain.log_parameter_max_length`
    (`0`) and `pg_stat_statements.track_utility`/parameter behaviour; (b) a **live test** that runs a search with a sentinel token,
    then asserts the sentinel's tag bytes appear in no `pg_stat_statements` row, in no Postgres server log captured from the private
    container, and in no application log line. No tag or token in application logs, traces or error reports (the request logger already
    strips the query string from `req.url`, `bootstrap/plugins/logger.ts`). Search responses are not cached.
11. **Rebuild.** `messaging.search_rebuild` job: resumable cursor over messages ordered by `(created_at, id)`, checkpoint row per
    `(org, key_version)`, per-message idempotent replace (delete tags for the message, insert, with freshly drawn dummies),
    tenant-scoped via `withOrgContext`, runs at low priority, reports progress. "Reproduces identical results" is an acceptance test
    (identical **result sets**; dummies differ by design). A held-and-redacted or pending-redaction message is skipped by the rebuild.
12. **UI contract.** The search box says it matches whole words and word beginnings of at least 3 characters, not arbitrary
    substrings, and that archived conversations are marked.
13. **Fail-closed.** If key derivation fails, the ring is destroyed, the key version is unknown, the authority check cannot run, or the
    rate-limit store is down, search returns an error; it never falls back to a plaintext scan, to a prefilter-only result, or to option C.

## Access control

**Invariant: the SQL prefilter is a superset of authority; authority is the only decider.** The SQL in step 8.3 is a coarse prefilter
for cost (it bounds the candidate set by active membership). It is never the access decision. The authoritative decision is
`effectivelyVisibleChannels(orgId, userId, candidates, part2Gate, warn)` in `messaging-route-service-db.ts` (~lines 177-243), which
`canViewChannelFor` (~731-778) calls for one channel and which this path calls once for the candidate channel set. That function
applies, beyond membership: the active-messaging-user check (`isActiveMessagingUser`: active org membership and active user),
`announcement` is org-wide, the **Part 2 gate** for `care_team` channels (`part2Gate.allowedUserIds`), and the **current care-team
roster** (`CareTeamProvider.careTeamMembers`) for automatically synced members (`memberSource = 'auto'`); a failing clinical/consent
seam is a denial, logged with ids only. The prefilter must therefore never be narrower than membership-or-announcement and must never
be treated as sufficient. Consequences for the build:

- `effectivelyVisibleChannels` is module-private today; 2.7b exposes a service method (for example `visibleChannelIds(orgId, userId,
  channelIds)`) that runs the same code, rather than re-implementing the rules in SQL.
- Concurrency and seam cost are bounded by the existing worker pool of 8 per patient; candidate channels are deduplicated first.
- **Test (required, live and unit):** (1) a spy/fake `part2Gate` and `CareTeamProvider` proving no result row is returned for a channel
  the authority denies even though the SQL prefilter selected it; (2) a structural test that fails if the search path returns any
  row without passing through the authority function; (3) the prefilter-superset property: for each state in the table below where
  authority allows, the prefilter includes the channel.

**Pre-join history (what the code does).** `channel_member` has `joined_at` and `removed_at` and no history-window column. A
re-added member gets `joined_at` reset (`messaging-route-service-db.ts` ~505), but **no read path filters messages by `joined_at`**
(grep of `apps/backend/src/modules/36-messaging` and `packages/messaging/src`: `joinedAt` is used only for ordering). So today a
current member sees the channel's whole history, including messages sent before they joined, and search will match it too. Plan `02`
§4 says membership history reuses `channel_member.removed_at` "unless Phase 0 finds a gap". Search adds no new rule. **Open (privacy
officer):** is whole-history visibility for a new member intended for care-team and DM channels? If not, the fix is a read-path rule
for all of messaging, not a search-only rule; search follows whatever the history read path does.

**Archived channels (Proposed default, for security/privacy reviewers to confirm).** Global search includes archived channels for
users who are **current members** (or any active user for an archived `announcement`), read-only, with each result marked
`archived: true`. The code today: `canViewChannelFor` does not consider archive state (reads are allowed, writes get 410 via
`assertMessageChannelAccess(..., writable)`), whereas **WP 2.7a refuses an archived channel with 410 `CHANNEL_ARCHIVED`** in
`message-search-service-db.ts`. The two intentionally differ until 2.7a is aligned: 2.7a is a "search within this conversation" UI that
hid search on archived channels; global search surfaces them. Aligning 2.7a is a separate, small change and is listed in the
Migration section.

### Channel state by user state

Every row maps to a live test in the new suite `test:m36:global-search:live` (real `wardenx_app` role, private `pgvector/pgvector:pg18`).
"Results" means the message can appear; "zero" means no candidate from that channel survives step 8.4.

| # | Channel state | User state | Expected | Basis in code | Live test |
|---|---|---|---|---|---|
| 1 | Normal (`care_team`/`dm`/other), not archived | Active member | Results | `channel_member` active + `effectivelyVisibleChannels` | `member-sees-own-channel` |
| 2 | Any | Never a member | Zero | prefilter and authority both exclude | `non-member-zero` |
| 3 | Any | **Removed member** (`removed_at` set after indexing) | Zero | `removed_at IS NULL` in prefilter and in `canViewChannelFor`; the index still holds the rows | `removed-member-zero-after-indexing` |
| 4 | Any | Deactivated / suspended org user | Zero | `isActiveMessagingUser` | `inactive-user-zero` |
| 5 | **Archived** | Current member | Results, marked `archived` (read-only) | proposed default above; 2.7a differs | `archived-member-sees-marked-results` |
| 6 | Archived | Removed member | Zero | as row 3 | `archived-removed-zero` |
| 7 | `care_team`, **Part 2 gated** and user not allowed | Member | Zero | `part2Gate.allowedUserIds` | `part2-denied-zero` |
| 8 | `care_team`, Part 2 seam errors | Member | Zero, `warn` logged with ids only | seam failure is a denial | `part2-seam-error-fails-closed` |
| 9 | `care_team`, patient context | Member allowed by Part 2 | Results, each page attributed to its patients in the audit | see "Read audit" | `care-team-patient-attribution` |
| 10 | `care_team`, **access ended** (patient discharged / user off the care team) | `memberSource = 'auto'` member no longer on the roster | Zero | `CareTeamProvider.careTeamMembers` | `auto-member-off-roster-zero` |
| 11 | `care_team`, access ended | `memberSource = 'manual'` member | Results while the manual membership and Part 2 hold | `candidate.memberSource !== 'auto'` returns true | `manual-member-survives-roster-change` |
| 12 | `announcement` | Any active user, no membership row | Results | org-wide rule | `announcement-org-wide` |
| 13 | Any | Identity with role category `patient_family`, `external_auditor` or `platform_staff` | Zero (expected; see Open questions) | M36 never adds these to channels (`mention-non-member-service-db.ts` excludes the three categories); no M36 code grants them `messaging.read` | `non-staff-identities-zero` |
| 14 | Any | Member, message sent **before** they joined | Results (current history behaviour) | no `joined_at` filter on any read path; open question | `pre-join-history-matches-history-read` |
| 15 | Any | Other tenant | Zero, tags differ | per-tenant key, RLS | `cross-tenant-collision` |
| 16 | Message `deleted` | Anyone | Never | prefilter and step 8.5 | `deleted-never-returned` |
| 17 | Message **redacted** (final) | Anyone | Never | rows deleted; step 8.5 | `redacted-never-returned` |
| 18 | Message redaction **pending** (before countersign) | Anyone | Never, immediately | decision 7 | `pending-redaction-hidden-immediately` |
| 19 | Message deleted/redacted but index row still present (simulated hook failure) | Anyone | Never | step 8.5 re-verifies the current row | `stale-index-row-reverified` |
| 20 | Message held and redacted | Anyone | Never; not in index; rebuild skips it | decision 6 | `held-redacted-not-indexed` |

## Read audit

The 2.7a route declares `auditRead: { resourceKind: "message", list: true, resourceIdParam: "id", listResourceId: true,
patientIdPayloadPath: "patientId", filterOmit: ["q"] }`. The global route has **no `:id`**, so what the hook (`bootstrap/plugins/read-audit.ts`)
can record is different, and the earlier draft's "result ids and count" is not what `auditListRead` writes (it writes `count`,
`filter` and one `patientId` into `context`, and a `resource_id` only when `listResourceId` finds a uuid route param). Verified facts
and the resulting requirements:

1. **Shape.** `GET /api/v1/messaging/search` (route path to be fixed in the WP) declares `auditRead: { resourceKind: "message", list:
   true, filterOmit: ["q", "cursor"] }` and **no** `resourceIdParam` / `listResourceId`. The event is `message.list_viewed` with
   `count` and a `filter` of the query shape. With no `resourceIdParam` the row has no `resource_id`; that is correct for an
   org-wide aggregate and is not the "silent empty resource id" failure (that failure is a *single-resource* config without the param).
2. **`filterOmit`.** `listAuditFilter` copies the whole parsed query and blanks only the omitted keys. So `q` **and `cursor`** must be
   in `filterOmit` (2.7a omits only `q`, which means its audit row records the cursor value; the cursor holds only a timestamp and a
   message id, so that is not a content leak, but the global route omits it so the rule "no cursor in audit" has no exceptions). The
   raw query string never reaches the audit row (the hook uses the parsed query object, not `request.url`) or the access log (the
   request logger strips the query, `logger.ts`). A **log-capture test** asserts the sentinel query text, its tags and its cursor
   appear in neither.
3. **Patient attribution.** A global page spans many patients, but the hook resolves **one** `patientId` (route param, query param,
   or the first matching `patientIdPayloadPath`). A single `patientIdPayloadPath: "patientId"` would attribute the whole page to one
   patient or none, which breaks the 45 CFR 164.528 accounting join. Requirement: each distinct patient whose care-team channel
   contributed a result gets its own attributed read event. **Mechanism (Proposed default, for security/privacy reviewers to confirm):** the search service
   emits, inside the request transaction and before returning, one `auditPhiRead` per distinct patient on the page (at most the page
   size) in addition to the hook's aggregate, so a failure to audit **fails the read** (the hook's own emission is best-effort and
   swallows errors, which is unsuitable as the only record for decrypted PHI). The alternative is extending the hook with a
   multi-patient payload path; the reviewers pick. Result message ids are not stored in the audit row.
4. **Live assertion** (the repo's standing lesson): a search request produces exactly one `message.list_viewed` row with the right
   `count`, `filter.q = "[omitted]"`, `filter.cursor = "[omitted]"`, plus one attributed read per patient on the page; a search that
   fails the audit write returns an error rather than results.

## Leakage analysis (to be completed by the design reviewer)

| Adversary | Learns | Mitigation here | Residual |
|---|---|---|---|
| Database snapshot / backup thief without keys | tag histogram per tenant; which messages share tags; padded row counts per message | HMAC under per-tenant key; truncation + dummies; no positions/order; per-tenant keys so no cross-tenant joining; ring destruction (P1) | Frequency analysis against known hospice vocabulary can plausibly recover very common words; co-occurrence graphs; classic searchable-encryption leakage-abuse attacks apply |
| Database operator who can observe live queries | access pattern: which messages match which (unknown) query | bound parameters, no statement/parameter logging, no result caching, per-route rate limit | Repeated or correlated queries let them cluster queries; with auxiliary data, recover query words |
| Application compromise (code execution with KEK) | everything: bodies and keys | none new - already game over for bodies | Index adds no capability beyond bodies |
| Authorised insider using the UI to probe | whether a word occurs in channels they may already read | results restricted to current access; per-user and per-org rate limit (P2); read audit | Probing within permitted scope reveals only permitted content |
| Cross-tenant | nothing | distinct keys per tenant; RLS; cross-tenant collision test | Compromised KEK defeats all tenants |

The honest summary: option B trades a reduced blast radius for a database-only compromise (no plaintext copy exists, unlike C) against
known frequency/access-pattern leakage that option A does not have. A qualified reviewer must decide whether that is acceptable for
hospice PHI and whether `T`, bucket sizes and the stop-word list are adequate.

### Design review requirement

Reviewers (D10, decided 2026-10-11 by the product owner): the **security architect and the privacy officer**. The review gates
**building** WP 2.7b (pre-build design review) and **enabling** it in production (a **leakage test** must pass first). Before
acceptance: (1) a written review by the security architect, with searchable-encryption experience, and the privacy officer covering the table above, the
truncation width `T`, padding scheme, prefix lengths, key derivation and rotation, and the logging-hygiene controls, and confirming
or changing each "Proposed default" in this ADR; (2) a
measured experiment on synthetic hospice notes estimating how many top-N words an auxiliary-vocabulary frequency attack recovers
at the chosen `T`, which also serves as the **production-enablement leakage test** (D10) and must pass before any tenant is enabled; (3) a record of the HIPAA risk-analysis entry for the new PHI-derived store; (4) product-owner acceptance of the
residual risk. The review record is linked from this ADR before Status changes.

## Alternatives considered

- **A. Decrypt-and-filter over an authorised candidate set.** No index, always-current ACL, no frequency leakage. Rejected for
  unbounded global search (cost grows with history); adopted for in-conversation search (WP 2.7a). **If the review rejects B, the
  fallback is a bounded multi-channel option A, not "no global search" (Proposed default, for security/privacy reviewers to confirm):**
  global search over only the user's current member channels (plus announcements), with a hard channel cap (initially 50 most
  recently active), the same per-request body-open cap as 2.7a (`SEARCH_MAX_SCAN_PER_REQUEST`, 5000) shared across channels,
  newest-first keyset, the same authority check (`effectivelyVisibleChannels`), audit and rate limit, and an honest UI ("searched
  your 50 most recent conversations"). It needs P2 but not P1.
- **C. Plaintext `tsvector` under RLS.** Best functionality (stemming, phrase, ranking, substring via trigram). Rejected: a second
  plaintext copy of PHI beyond the cipher, wider blast radius, and it survives DEK destruction unless separately shredded.
- **Deterministic encryption of tokens (instead of HMAC).** Same equality leakage, but reversible by key holders and awkward to
  rotate. Rejected for no benefit.
- **Order-preserving or substring-capable SSE schemes (n-gram indices, ORE).** More functionality but materially higher leakage
  (positions/order), and short grams are trivially invertible. Rejected.
- **Client-side search over locally decrypted history.** Strong against server leakage but needs keys in the browser, offline
  copies of PHI on devices, and does not fit server-held tenant DEKs. Rejected for this architecture.
- **External search service (Elasticsearch/Typesense) with encryption at rest.** Plaintext inside the engine, new vendor surface,
  conflicts with ADR-0020 integration governance and the PHI boundary. Rejected.
- **No global search.** Cheapest and safest; not chosen. D3 says global search is wanted (not an unconditional requirement that
  overrides the review): if the review rejects B the answer is the bounded multi-channel A above, and "no global search" is the
  outcome only if the reviewers also reject that.

## Consequences

- Two prerequisite WPs (P1 data migration of all message and revision ciphertext; P2 per-route rate limit) before any search code.
- A new PHI-derived table, a worker, a rebuild job, and key-version handling to run and test.
- Search quality is limited: no substring, no fuzzy, no stemming, no phrase; no dose search; eventual consistency; occasional
  short pages after access filtering (handled by the cursor and `scanCapped`, decision 9).
- Every body-handling change (edit, redact, delete, erase, retention) gains an index side effect in the same transaction, and a test.
- Common clinical words are the most leaked; they are also the least useful search terms.
- A tenant-level setting turns global search on or off (see Open questions); off by default until the leakage test passes.

## Migration / rollout

1. **P1 and P2 first** (each its own WP and PR, with their own live suites).
2. After acceptance: migration for the table (check `arch:migration-numbering` against `main` first; branches collide on the next
   ordinal; manifest `ownedTables` in `.ts` and `.cjs`; mirror in `packages/db` and `packages/types`), key-derivation helper beside
   `body-crypto.ts`, tokenizer package-level pure function with the golden tests.
3. Backfill by the rebuild job per tenant (gated by the tenant search-enable setting); enable the query path only when the
   checkpoint is complete.
4. Wire the same-transaction deletion hooks (edit, redact, delete, eraser, retention) in the same release as the indexer, never later.
5. Add the eraser extension and DR/backup documentation for the new store.
6. Align WP 2.7a with the archived-channel rule (search read-only in archived channels, results marked) and add `cursor` to its
   `filterOmit`, as small follow-ups; neither blocks 2.7b.

## Verification

- Unit: tokenizer determinism and the **golden cases** in decision 3 (clinical strings, unicode, digits); tag derivation differs per
  tenant and per key version; no tag for tokens under the minimum length; padding sizes `N = max(16, 2^ceil(log2 n))` and dummy
  re-randomisation across two replaces of the same message; cursor encodes only `(created_at, id)`; AND-intersection SQL returns only
  messages holding all `k` tags.
- Live (real `wardenx_app` role, suite `test:m36:global-search:live`): every row of the "Channel state by user state" table; the
  prefilter-superset and structural "authority always applied" tests; stale-index-row re-verification; cross-tenant token collision
  test (same word, two tenants, tags differ and results never cross); tenant erasure leaves zero index rows **and**, after P1, ring
  destruction makes the bodies and `K_search` underivable; rebuild after truncating the table reproduces identical result sets;
  read-audit assertions in "Read audit" (event lands, `q` and `cursor` omitted, one attributed read per patient, audit failure fails
  the read); query text and tags absent from audit rows, access log and Postgres/`pg_stat_statements` capture; rate-limit test from P2.
- Performance: p95 < 1 s on a representative history (target in plan 2.7b), including the decrypt budget behaviour.
- Gates, all green before the PR: `arch:tenancy`, `check-fitness-gaps`, `arch:manifest-mirror`, `arch:migration-numbering`,
  `arch:outbox-bindings` (and a grep of `apps/backend/src/index.ts` for the indexer's consumer factory; green gates do not prove it
  is wired), `arch:abac-predicates` and `arch:abac-composed` (any new predicate or `requireAbac` is registered and composed),
  `arch:queue-names` (rebuild/indexer queues, one owner per name), `arch:live-suites` (the new live suite has a `package.json`
  script **and** a `ci.yml` job row), `test:fk-indexes:live`, `arch:openapi-provenance`/`client:check` for the new route.

## Open questions

- **Key model: decided by the user (2026-10-13), option (b)** — see P1. Still to confirm in production: where the current
  `MESSAGING_ENCRYPTION_KEY` is escrowed (runbook §8.4), because it must remain available until the P1 backfill completes and the
  legacy derivation is removed.
- Truncation width `T`, padding floor, candidate cap, decrypt budget, stop-word list (including whether `mg`/`ms` belong on it),
  minimum prefix length (3?) and maximum token length: reviewer to fix.
- Remaining reviewer-fixed details: what counts as "ID-like", and diacritic handling for the future tokeniser.
- **Tenant search-enable setting (Proposed default, for security/privacy reviewers to confirm).** The two earlier questions (a
  patient-name flag and "should hold-bearing tenants disable global search") are merged into **one** per-tenant setting,
  `messaging.global_search_enabled`, default off. The owning module is proposed as **M36** (a messaging tenant setting with the
  messaging tenant configuration), switched by an org administrator, audited; the index worker and query path both check it, and
  turning it off stops queries immediately and deletes the tenant's rows. Open: confirm M36 (versus M34 tenant settings) as owner. The patient-name flag is dropped for v1.
- Pre-join history (see "Access control"): is whole-history visibility for a newly added member intended? Privacy officer decides; the
  fix, if any, belongs in the history read path, not in search.
- Role categories `patient_family`, `external_auditor`, `platform_staff` (table row 13): the expectation is zero results, but I could
  not find the permission grants for `messaging.read` per role category in the messaging code; the live test must prove it and the
  reviewers should confirm the intended grants.
- Patient attribution mechanism (service-emitted per-patient reads versus extending the read-audit hook): reviewers pick.
- Redaction marker (ADR-0055): the step 8.5 check reads whatever marker the redaction WP defines; decision 7 depends on it.
- Rate-limit numbers (30/min/user, 300/min/org) are placeholders; fail-closed on store outage for this route is a proposal.

Resolved (Decided 2026-10-11 by the product owner, D10): reviewers are the security architect and privacy officer; the review gates
both build and production enablement, with a leakage test before enablement; numeric/ID-like tokens and free-text identifiers are
not indexed; English only at launch with a pluggable tokeniser. Resolved (User decisions, 2026-10-13): key model option (b) (P1);
deleted/redacted windows of seconds are acceptable because step 8.5 re-verifies on the current row; a pending redaction is hidden
from search immediately.
