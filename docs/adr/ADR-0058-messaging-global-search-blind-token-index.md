# ADR-0058 — Global message search is a per-tenant HMAC blind-token index (whole-word and prefix only), re-checked against current access at query time

- **Status:** **Proposed**
- **Gate:** a design review by the **security architect and the privacy officer** is a hard precondition to acceptance. It gates **both
  building WP 2.7b and enabling it in production** (D10, decided 2026-10-11 by the product owner, who chose option B (D3) knowing it
  leaks token frequency). Do not implement WP 2.7b, and do not mark this Accepted, until the review in "Design review requirement"
  has passed and its record is linked here. WP 2.7b is additionally **blocked on the two prerequisite work packages** in "Prerequisites"
  (key-ring migration of message bodies; per-route rate limit). In-conversation search (WP 2.7a, option A) does not depend on this ADR.
- **Date:** 2026-10-11 (revised 2026-10-13 after design review feedback, and again 2026-10-13 to record the open-question decisions; Status unchanged)
- **Phase:** Messaging Hub Phase 2 (WP 2.7b). Needed before Phase 2 work on global search starts.
- **Extends:** [ADR-0038](ADR-0038-app-layer-envelope-encryption.md) (app-layer envelope encryption) and
  [ADR-0045](ADR-0045-platform-kek-custody.md) (KEK custody) for key derivation; plan `02` §6.
- **Related:** [ADR-0055](ADR-0055-message-revisions-and-redaction.md) (redaction and revisions - what is indexed and when it is removed),
  [ADR-0010](ADR-0010-tenancy-rls-invariants.md), [ADR-0011](ADR-0011-ownership-inversion-rls-bypass.md),
  [ADR-0051](ADR-0051-legal-hold-is-an-overlay-not-a-retention-class-flip.md) (derived data is not the record).

> **How to read decisions in this document.** Items marked **User decision** were taken by the user (2026-10-13) and are
> authoritative. Items marked **Proposed default, for security/privacy reviewers to confirm** are this ADR's recommendation, accepted
> provisionally by the user ("go with your recommendations"), and the reviewers may change them. Items marked **Decided 2026-10-13
> (user, delegated to the lead engineer's judgement)** were left to professional judgement by the user ("use best practice"); they are
> decisions, not open questions, but they are **inputs to the design review**: the security architect and privacy officer may still
> amend them, and every numeric parameter among them must be re-validated by the leakage review with a measurement. None of them
> changes Status: this ADR stays **Proposed** until the review in "Design review requirement" has passed.

### Decisions taken 2026-10-13 (summary; the text below is authoritative)

| # | Topic | Decision | Where |
|---|---|---|---|
| 1 | Pre-join history | **User decision:** a member may find messages sent before they joined. Search is exactly as strict as the history read path, no stricter, no looser. The privacy officer is informed, not asked. | Access control; row 14 |
| 2 | Flag owner | **M36** owns `messaging.global_search_enabled`; default OFF; org-admin only, step-up, audited; go-live checklist; OFF purges tokens; an ops-owned platform kill switch overrides ON. | Enablement and kill switches |
| 3 | Tokenizer and caps | Exact initial values (NFKC, diacritic folding, min token 3, max 40, ID-like rule, stop words, `T = 19`, cap 500, budget 200 / 3 s, padding floor 16, limits 30/300 fail-closed). Tunable by config, each to be re-validated by measurement. | Decision 3, 4, 9; "Parameter values and the T arithmetic" |
| 4 | Key escrow | `MESSAGING_ENCRYPTION_KEY` is escrowed (Shamir 2-of-3, three custodian roles, separate failure domain) and a restore drill passes before the P1 backfill; retirement only after backfill verification. Global search stays off everywhere until escrow is confirmed. | P1 |
| 5 | Role categories | `patient_family`, `external_auditor`, `platform_staff` never hold `messaging.read`; the route also requires a workforce-category allow-list; live test plus a static ratchet. | Access control; row 13 |

**Remaining genuinely open** (for the reviewers, see "Open questions"): the leakage analysis itself and confirmation of `T` and the other
parameters; the redaction marker (ADR-0055); the patient-attribution mechanism; archived-channel inclusion; whether known patient-name
tokens are excluded; whether `external_collaborator` belongs on the role-category allow-list.

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
   decrypt-only until the backfill completes and the retirement conditions in "Key escrow until the backfill" below are met, then
   is removed.
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

#### Key escrow until the backfill (Decided 2026-10-13, user, delegated to the lead engineer's judgement)

Until every row is re-wrapped, `MESSAGING_ENCRYPTION_KEY` is the **only** way to read legacy message bodies and revisions, and the
runbook says it is "not rotatable" and that message bodies "are not" recoverable by re-entry
(`docs/architecture/WARDENX_OPS_RUNBOOK_v0.1.md` §8.3.3, lines ~1184-1190; table row ~1017). Losing it before the backfill finishes is
unrecoverable data loss, so the key is escrowed as a **precondition of P1**. This is custody on top of the existing model, not a
replacement for it:

- **Primary custody is unchanged** (ADR-0045 §1: the deployment's secret manager, injected as an environment variable; this repo's
  production secrets are SOPS-encrypted, runbook §8.4). The key is never in the repository in plaintext, in an image, in a CI log or in
  a `.env` file outside the SOPS-encrypted production file. Access to the secret is **two-person controlled and audited** (the secret
  manager's access log is the record).
- **One sealed offline escrow copy**, split **Shamir 2-of-3** between three named custodian **roles**: the security officer
  (`hipaa_security_officer`), the CTO, and a break-glass vault. Any two reconstruct the key; no single role can. The escrow lives in
  a **different failure domain** from the primary (different site and different custodians from the SOPS age-key envelopes in
  runbook §8.4, which it must not share a single point of loss with). It extends the runbook §8.3.3 practice of keeping
  `M34_TENANT_KEK` in the sealed off-site envelope; the runbook gets a matching checklist line (a P1 deliverable).
- The **key version** (the `MESSAGING_ENCRYPTION_KEY` generation and the envelope `VERSION` byte it serves) is recorded with the
  escrow record, so the right copy is restored for the right ciphertext.
- **Restore drill before the backfill starts (P1 precondition, recorded):** reconstruct the key from two shares in a clean
  environment, decrypt a sampled, production-shaped message body and revision (a copy, never the live rows), and confirm the
  plaintext matches `body_sha256`. No backfill starts without a passing drill on record.
- **No rotation during the backfill window.** The legacy derivation is a pure function of the key and the org id, so rotating it
  mid-migration would strand the un-migrated rows.
- **Retirement of the legacy derivation and destruction of the key** happen only after **all** of: (a) the backfill is verified
  complete by count (zero rows still on the legacy envelope version) **and** hash-verify; (b) a **post-backfill `hash_verify` run is
  clean**; (c) backups that contain legacy-wrapped data have aged out of retention or been re-wrapped; then the destruction of the
  primary and every escrow share is **attested** in writing. Until then the key is kept.
- **Boot check stays fail-closed.** `assertProductionEnv` already requires the key to be present and 32 base64 bytes
  (`apps/backend/src/bootstrap/env.ts` ~line 245). P1 adds, for `check:boot:platform` and the boot path: if any `message` or
  `message_revision` row is still on the legacy envelope and the key is missing, boot fails closed rather than starting with
  unreadable history.
- **Global search stays disabled in every tenant until escrow is confirmed** (a record of the drill and the escrow custodians is
  part of the go-live checklist in "Enablement and kill switches").

### P2. A per-route rate limit mechanism (mechanism: Proposed default, for security/privacy reviewers to confirm; limits and fail-closed: Decided 2026-10-13, user, delegated to the lead engineer's judgement)

Verified against the code: the repo has **only the global SD-055 limiter** (`apps/backend/src/bootstrap/plugins/security.ts`: 600
requests/min for any authenticated caller, 30/min unauthenticated; bucket keyed by `org:<id>` when org-bound, else `user:<id>`, else
IP; Valkey-backed through `rate-limit-store.ts` when `REDIS_URL` is set; **fails open** on a store error). It is one org-wide
bucket across every route, so it neither limits a single user's search probing nor protects the decrypt budget. The 2.7a service says
the same ("No per-route rate limit exists in this repo", `message-search-service-db.ts`). A per-route limit is therefore a prerequisite
for the global search route, because search is an oracle and a decrypt-cost amplifier:

- A route-level `config.rateLimit` (or equivalent preHandler) that reuses `RateLimitStore.increment(key, windowMs)` with keys
  `search:user:<orgId>:<userId>` and `search:org:<orgId>`.
- **Decided limits (initial, tunable by config; the leakage review re-validates them):** 30 requests/min/user and 300 requests/min/org
  on the global search route. 30/min/user is one query every two seconds, enough for interactive typing with client-side debounce and
  far below an automated probing rate; 300/min/org is ten fully active searchers.
- Over limit: `RateLimitedError` (429) with `Retry-After`. Store unavailable: for this route **fail closed** (503), unlike the global
  limiter, because here the limiter is a probing control, not only an availability one. **Decided**; the implementation is still a
  P2 deliverable.
- **Required test:** live (Valkey `valkey/valkey:8`, not Redis): the 31st request in a minute by one user is 429; a second user in the same org
  is unaffected until the org cap; the org cap is shared across replicas (two app instances, one store); a store outage returns 503
  on this route and the limiter on other routes still fails open.

## Decision

1. **Scope.** The index covers the **head body of each non-deleted, non-redacted message** only (not revisions, not drafts, not
   attachments). Indexing (inserts only) runs in a worker driven by `m36.message.sent.v1` / `m36.message.revised.v1` outbox events (**indexer work item: emit and catalog both events**; they exist only in the plan today, `02` §9, not in the event catalog or emit sites) and is therefore
   eventually consistent; the UI states that new messages may take seconds to appear. The index is derived data, never the record.
   Wire the worker's consumer factory in `apps/backend/src/index.ts` (grep for it; `arch:outbox-bindings` does not prove it is wired).
2. **Keys (after P1).** `K_search(org, v) = HKDF-SHA256(ikm = TenantDek.key, salt = "", info = "wardenx-message-search:" || orgId || ":v" || v)`
   where `TenantDek` is the unwrapped M34 DEK for key-ring version `v` and the info label is distinct from the body-encryption label,
   so the two keys are domain-separated. `v` is stored on every index row. Rotation: a new ring version, rebuild under it, query both
   during the overlap, then delete the old version's rows. **Ring destruction (P1) makes the index unusable** because `K_search` can no
   longer be derived for any version and the tags are indistinguishable from random without it; the eraser still deletes the rows
   (the index is PHI-derived, so it is not left behind on the argument that it is unreadable). If P1 has not shipped, 2.7b does not.
3. **Tokenisation (server-side, deterministic). Decided 2026-10-13 (user, delegated to the lead engineer's judgement); initial values,
   tunable by config, each re-validated by the leakage review with a measurement.** The pipeline, in this order (the query is tokenised
   by the identical code):
   1. **Normalise:** Unicode NFKC, then lowercase with the locale-independent `String.prototype.toLowerCase` (never a locale-aware
      call, so "I" does not become dotless-i on a Turkish server).
   2. **Fold diacritics (English launch tokenizer):** NFD, strip combining marks (`\p{M}`), recompose. "café" and "cafe" are one token.
      The folding is part of the pluggable tokeniser, so other languages can choose differently without changing the index shape.
   3. **Split into chunks** on whitespace, then drop any chunk that is **ID-like** (definition below). Then **split each remaining chunk
      on non-letters** (`\P{L}`): digits and punctuation are separators, so no indexed token ever contains a digit.
   4. **Length bounds:** tokens shorter than **3** are dropped (minimum indexed token length 3); tokens longer than **40** are
      **dropped, not truncated** (a truncated 40-character stem would be a stable fingerprint of a long identifier-like string).
   5. **Stop words:** drop the stop-word list below.

   **"ID-like" (Decided; reviewers confirm).** A chunk is ID-like, and is not indexed at all, if any of these hold: (a) it matches a
   UUID, an email address, a URL (`scheme://` or `www.`), a phone-number shape (7 or more digits once separators are removed), or an
   MRN-like shape (an alphabetic prefix of 2-4 letters directly followed by 5 or more digits, or any run of 6 or more digits); (b) it
   is 20 or more characters drawn only from `[a-f0-9]` (hex), or from the base32 alphabet, or from the base64/base64url alphabet; (c) it
   has two or more letter-to-digit or digit-to-letter transitions (`a1b2`, `hba1c`, `abc123def`), which is the shape of codes and
   identifiers rather than of dosage or unit text. A chunk with at most **one** transition and fewer than 6 digits (`5mg`, `15mg`,
   `covid19`, `b12`) is not ID-like: its digits are simply separators. The rule is deliberately over-inclusive: an unindexed word is
   a search miss, an indexed identifier is a leak.

   **Stop words (about 100, English; the exact list is a constant in the tokenizer package).** `about after again against all also and
   any are because been before being between both but can could does doing down during each else even ever for from further get got
   had has have her here him his how into its just let like made make many may might more most much must once only other our out
   over own same she should some such than that the their them then there these they this those through too under until upon use
   very via was were what when where which while who whom why will with would yet you your yours` (101 words). Clinical short terms
   such as `mg`, `ms`, `ml` and `iv` are **below the 3-character minimum, so they need no stop-word entry**: they are never indexed.
   **Negations and clinically meaningful words are deliberately not stop words:** `not`, `none`, `never`, `without`, `pain`, `off`,
   `above`, `below` stay indexed (a clinician may well search "not eating" or "without relief"). `no` is 2 characters and is
   therefore never indexed regardless; a query consisting only of `no` is rejected as having no indexable token (a documented
   limitation, not a bug).

   **Patient names are not indexed specially in v1 (Proposed default, for security/privacy reviewers to confirm):** the earlier
   per-tenant patient-name flag is removed (**decided 2026-10-13: the patient-name flag stays dropped for v1**); a name typed in a
   message is indexed as an ordinary word like any other, and no patient-name lookup feeds the index.
   **English only at launch**, behind a **pluggable tokeniser** interface so other languages and diacritic policies can be added later
   without changing the index shape (D10, decided 2026-10-11 by the product owner). Each distinct token yields:
   - a **whole-word tag** `HMAC(K, "w\0" || token)`;
   - **prefix tags** `HMAC(K, "p\0" || len || "\0" || prefix)` for prefix lengths 3 to min(len, 12). No prefix shorter than 3, no
     infix/suffix grams, no trigram of short strings, no character positions or word order stored. The **minimum query prefix
     length is 3**, equal to the minimum prefix tag length.

   **Golden clinical cases** (the unit suite asserts these exact outputs; `n` counts whole + prefix tags before padding):

   | Input | Tokens | Tags | `n` |
   |---|---|---|---|
   | `morphine` | `morphine` | whole(`morphine`); prefix lengths 3..8: `mor`, `morp`, `morph`, `morphi`, `morphin`, `morphine` | 7 |
   | `5 mg` | none (`5` has no letters; `mg` is under 3 characters) | none | 0 |
   | `5mg` | none (one transition, so `5` is a separator; `mg` is under 3 characters) | none | 0 |
   | `MS Contin 15` | `contin` (`ms` under 3 characters; `15` has no letters) | whole(`contin`) + prefix lengths 3..6: `con`, `cont`, `conti`, `contin` | 5 |
   | `MRN 12345678` | `mrn` (`12345678` is ID-like: 6 or more digits, dropped) | whole(`mrn`); prefix `mrn` | 2 |
   | `Café` and `cafe` | `cafe` | same tags for both spellings: whole(`cafe`) + prefixes `caf`, `cafe` | 3 |
   | `hba1c` | none (two transitions: ID-like) | none | 0 |
   | `not eating` | `not`, `eating` (neither is a stop word) | whole(`not`), prefix `not`; whole(`eating`) + prefixes `eat`, `eati`, `eatin`, `eating` | 2 + 5 = 7 |

   Consequences made explicit: a clinician cannot search for a dose ("5 mg" yields nothing searchable), and, because the minimum token
   length is now 3, the very high-frequency `mg`, `ms` and `ml` tokens are not in the index at all, which removes the most-leaked and
   least-useful terms. A message with `n = 0` is still padded (item 4) so that "no indexable content" is not distinguishable.
4. **Truncation and padding (leakage control, not a security proof).** Each tag is truncated to `T` bits. **Decided 2026-10-13
   (user, delegated to the lead engineer's judgement): initial `T = 19`**, derived in "Parameter values and the T arithmetic" below
   (the earlier draft's `T = 32` gives no masking at all: at a realistic tenant size it leaves about one tag per 10,000 buckets).
   **`T` is the single most leakage-relevant knob in this design, and the reviewers must confirm or change it** with the measured
   experiment in "Design review requirement". Collisions are intentional: they become false positives that step 8.5 removes after
   decryption. **Padding:** for a message with `n` real tags (whole + prefix), the stored set is padded to
   `N = max(16, 2^ceil(log2 n))` rows (`N = 16` when `n = 0`), i.e. `dummies = N - n`. Decided: the floor of 16 is the smallest
   power of two that covers the typical short clinical message (a single long word is already 7 to 11 tags), so most short messages
   are indistinguishable by row count. Each dummy is a uniformly random `T`-bit value from a CSPRNG, **not**
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
   - **edit**: the edit path **only deletes** the old tags, in the same transaction as the revision write; the indexer worker inserts the new tags when it handles `m36.message.revised.v1` (decision 1). Between the two the message is simply unfindable by its new words (and by the old ones), which is the safe direction;
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
   - **Candidate cap** `CANDIDATE_CAP = 500` per request (Decided 2026-10-13, initial and tunable; re-validated by the leakage
     review), recency order, after the AND-intersection. The cap bounds SQL work per page; the decrypt budget below bounds decrypt
     work; a page that hits either continues through the cursor, so neither is a recall limit, only a per-request cost bound.
   - **Decrypt budget** (Decided 2026-10-13, as before) `DECRYPT_BUDGET = 200` bodies and a wall-clock budget `DECRYPT_TIMEOUT_MS = 3000` per request, inside a
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
13. **Fail-closed.** If key derivation fails, the ring is destroyed, the key version is unknown, the authority check cannot run, the
    tenant or platform enablement flag cannot be read or is off (see "Enablement and kill switches"), or the
    rate-limit store is down, search returns an error (a seam error inside `effectivelyVisibleChannels` is different: it silently excludes that channel's results and logs a `warn` with ids only, it is not an error response); it never falls back to a plaintext scan, to a prefilter-only result, or to option C.

14. **Enablement.** Global search is off per tenant by default and is switched by an org administrator, with a platform-level kill
    switch above it. See "Enablement and kill switches".

### Parameter values and the T arithmetic (Decided 2026-10-13, user, delegated to the lead engineer's judgement)

All values are **initial, tunable by configuration, and each must be re-validated by the leakage review with a measurement** (the
experiment in "Design review requirement").

| Parameter | Initial value | One-line rationale |
|---|---|---|
| Normalisation | NFKC, `toLowerCase`, then NFD + strip combining marks | Folds compatibility forms and diacritics so "café" and "cafe" are one token; locale-independent. |
| Token split | non-letter (`\P{L}`), after the ID-like chunk filter | Digits never reach the index. |
| Minimum indexed token length | 3 | Equals the minimum prefix length; removes `mg`, `ms`, `ml`, `iv` and `no`, the most-leaked and least-useful terms. |
| Maximum token length | 40, longer tokens dropped (not truncated) | No identifier-like string is fingerprinted by a truncated stem. |
| Minimum query prefix length | 3 | Matches the shortest prefix tag. |
| Prefix tag lengths | 3 to min(len, 12) | As before. |
| Stop words | the 101-word English list in decision 3; negations and clinical words stay indexed | Cuts the highest-frequency function words; `not` is kept because "not eating" is a clinical query. |
| ID-like | decision 3 (digits, UUID/email/URL/phone/MRN shapes, 20+ hex/base32/base64, two or more letter-digit transitions) | Over-inclusive on purpose: a miss is cheaper than a leaked identifier. |
| HMAC tag width `T` | **19 bits** | See the arithmetic below; **the most leakage-relevant knob, reviewers must confirm.** |
| Padding | `N = max(16, 2^ceil(log2 n))`, `N = 16` when `n = 0`, dummies random per replace and rebuild | Hides message length within a power-of-two band. |
| `CANDIDATE_CAP` | 500 | Bounds SQL work per page; the cursor continues past it. |
| `DECRYPT_BUDGET` / `DECRYPT_TIMEOUT_MS` | 200 bodies / 3000 ms, inside a 5000 ms `statement_timeout` | Unchanged; consistent with the cap (the cap limits SQL, the budget limits decrypt, the cursor reconciles them). |
| Rate limits | 30/min/user, 300/min/org, fail-closed (503) on store outage | See P2. |

**Why T matters.** `T` sets the number of buckets `B = 2^T`. A bucket's row count is all an observer of a database snapshot sees, so a
tag that is alone in its bucket reveals its exact frequency, and a tag that shares its bucket with others reveals only the sum.
Collisions also create false candidates for the query path. Both effects scale with `D / B`, where `D` is the number of distinct tag
values in the tenant.

**Assumed reference tenant (the arithmetic is only as good as these, and the reviewers should re-run it on real tenant statistics):**
5 x 10^6 messages; 10^5 distinct indexed tokens, giving about `D = 4 x 10^5` distinct tag values (10^5 whole-word tags plus an
assumed 3 x 10^5 distinct prefix tags, because prefixes are shared between words); an average of `n = 24` real tags per message,
padded to `N = 32` (8 dummies). Total rows `5 x 10^6 x 32 = 1.6 x 10^8` (1.2 x 10^8 real, 4 x 10^7 dummy).

| `T` | Buckets `B = 2^T` | Tags per bucket `D/B` | Share of tags that share a bucket `1 - e^(-D/B)` | Rows per bucket `1.6e8 / B` |
|---|---|---|---|---|
| 32 (earlier draft) | 4.29 x 10^9 | 9.3 x 10^-5 | 0.009% | 0.04 |
| 24 | 1.68 x 10^7 | 0.024 | 2.3% | 9.5 |
| 20 | 1.05 x 10^6 | 0.38 | 32% | 153 |
| **19 (chosen)** | **5.24 x 10^5** | **0.76** | **53%** | **305 (229 real + 76 dummy)** |
| 18 | 2.62 x 10^5 | 1.53 | 78% | 610 |
| 16 | 6.55 x 10^4 | 6.1 | 99.8% | 2441 |

- **`T = 32` masks nothing.** At 9.3 x 10^-5 tags per bucket every tag is alone in its bucket, so the stored value is a bijection of
  the tag and the frequency histogram is exact. The earlier draft's "many distinct words per tag value" was wrong at this size.
- **False-candidate rate for a single-word query** with `m` true matches is about `bucket rows / (m + bucket rows)`. At `T = 19`,
  a rare word (`m = 50`) yields about 50 + 305 = 355 candidates, of which about 86% are false and are dropped after decryption
  (step 8.5); a common word (`m = 500`) yields about 805 candidates, 38% false, cut to 500 by recency and continued through the cursor.
  At `T = 18` the same rare word yields about 660 candidates (92% false), above the 500 cap for the typical word; at `T = 32` it
  yields about 50.04 (0.07% false) and no masking.
- **Multi-word queries are close to exact.** A random message holds a given bucket with probability `305 / 5 x 10^6 = 6.1 x 10^-5`;
  for two words the expected false candidates are `5 x 10^6 x (6.1 x 10^-5)^2 = 0.019` per query.
- **Against the cap.** `T = 19` is the **smallest** `T` for which a typical single-word candidate set (355 for `m = 50`) stays under
  `CANDIDATE_CAP = 500`; `T = 18` already exceeds it. So `T = 19` is the strongest masking that does not break the cap for this
  tenant. It fits the 200-body decrypt budget only through the cursor (a page examines up to 200 of about 355 candidates and
  returns `nextCursor` / `scanCapped`), which is the designed behaviour, not a failure.
- **Dummies** add about 76 +/- 9 rows to every bucket (Poisson), so even a tag alone in its bucket is not read exactly.
- **What `T` cannot do.** A word in 10^6 messages sits in a bucket with about 10^6 rows at any `T`; the head of the frequency
  distribution stays identifiable by rank, and padding does not change that. Truncation protects the long tail (rare words, which
  include names), not the head. This is the known limit of option B (see the leakage table).
- **Sizing across tenants.** The reference tenant is large. `T` is stored with each `(organization_id, key_version)` and chosen at
  (re)build as `T = clamp(round(log2(D_org / 0.75)), 12, 20)`, which gives 19 for `D = 4 x 10^5` and 16 for a tenant ten times
  smaller, keeping `D/B` near 0.75 and rows per bucket in the low hundreds. The platform default when `D_org` is not yet known is 19.
  The sizing rule is a proposal inside this decided value and is among the things the reviewers confirm.

### Enablement and kill switches (Decided 2026-10-13, user, delegated to the lead engineer's judgement)

**What the code has today (checked, not assumed).**

- Tenant messaging configuration lives in **M36-owned, org-scoped `tenant_*` tables**: `tenant_alert_routing_override`
  (`packages/db/src/schema/messaging/tenant-alert-routing-override.ts`, header: "M36 Secure Messaging §3.11 ... Org-scoped
  (organization_id); RLS + the M4 write-audit trigger") and `tenant_notification_template_overlay`. A search of
  `packages/db/src/schema` for a generic tenant-settings store (`tenant_setting`, `tenant_config`, `org_setting`) found none; M34 owns
  `tenant_key_ring` and the platform feature-flag admin seam, not messaging tenant configuration.
- A **platform feature-flag mechanism exists**: the M1 `feature_flag` table, read through `FeatureFlagReaderPort.forOrg(orgId)`
  and written through M34's `FeatureFlagAdmin` seam including an audited `setKillSwitch`
  (`apps/backend/src/bootstrap/feature-flag-store.ts`; consumer precedent `documents.doclens` in
  `apps/backend/src/modules/22-documents/extraction/feature-flag.ts`; an absent key reads as false). **Caveat from that file:** a
  tenant-scoped row wins outright over the platform-global row of the same key, so a kill switch set on the global row does not
  override a tenant row for the same key.
- A **step-up pattern for admin settings exists**: `requireStepUp(opKey)` from `@wardenx/auth`, backed by the server-verified
  `stepUpFreshFor` (`apps/backend/src/bootstrap/step-up.ts`; used by M34 command routes,
  `apps/backend/src/modules/33-reporting/routes/schedules.routes.ts` line 50, `apps/backend/src/modules/40-mdm/routes/mdm-routes.ts`
  line 76 and others). A tenant may tighten, never loosen, the platform floor per operation.

**Decisions.**

1. **Owner: M36.** `messaging.global_search_enabled` is an M36 setting stored in an M36-owned, org-scoped table (working name
   `tenant_messaging_search_setting`, following the `tenant_alert_routing_override` precedent: three-column rule, RLS on `app.org_id`
   with FORCE, M4 write-audit trigger, manifest `ownedTables` in `.ts` and `.cjs`). The index worker and the query path are M36
   code and read it. It is **not** an M34 tenant setting. **Default OFF**; a tenant with no row is OFF.
2. **Who and how it changes.** Only an **org administrator**: a new permission (working name `messaging.global_search.manage`,
   category `admin`, registered in `packages/auth/src/permissions/contributed.ts` and mirrored per the 0600/1086 migration pattern,
   granted by migration to `administrator` and `org_admin` as `messaging.template.manage` was in
   `packages/db/migrations/1086_m36_message_template.sql`), **plus** an org-admin ABAC predicate (reuse an existing one if it fits;
   `arch:abac-predicates` and `arch:abac-composed` apply), **plus** `requireStepUp("messaging.global_search.configure")` on the route.
   Every change is **audit-logged with who, when, old value and new value** (the write-audit trigger on the table and an explicit
   domain event).
3. **Turning ON requires the go-live checklist**, enforced where code can enforce it and attested where it cannot: (a) the
   **leakage review record is linked in this ADR** and the Status has changed, attested by ops turning the platform flag below on;
   (b) **P1 is done** for the tenant (no `message` or `message_revision` row on the legacy envelope; checked by the route, which
   refuses with 409 otherwise) **and the key escrow and restore drill are on record**; (c) **P2 is deployed** (the rate limit is
   active); (d) the **index rebuild is complete** for the tenant (checkpoint complete; the query path stays closed until then, as in
   "Migration / rollout"). A tenant ON while any of (a) to (d) is false is refused.
4. **Turning OFF** stops queries **immediately**: the query path reads the flag on every request (no cache, as search responses are
   not cached) and the indexer stops inserting for that tenant. A purge job then **deletes the tenant's token rows**: asynchronous,
   batched, idempotent and resumable, with completion audited. **The query path refuses even if rows linger**, so a slow or failed
   purge never leaves search answering. Turning back ON needs the checklist again and a full rebuild.
5. **Platform kill switch (ops-owned):** `messaging.global_search_platform_enabled`, a platform-global `feature_flag` key read through
   `FeatureFlagReaderPort`. Search runs for a tenant only if the tenant flag **and** the platform flag are both true; an absent or
   unreadable platform key is OFF (fail-closed). When ops turns it off, queries and indexing stop everywhere at once; token rows are
   **kept** (so a transient incident can be reversed without a rebuild) unless ops runs the same purge. Because a tenant-scoped row
   would win over the platform row, **this key must never be written tenant-scoped**: a follow-up makes M34's `FeatureFlagAdmin`
   upsert refuse an org-scoped write for it, with a test. The platform flag also carries the production-enablement gate: ops does
   not turn it on until the leakage test has passed.
6. **The patient-name flag stays dropped for v1** (see decision 3).

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
§4 says membership history reuses `channel_member.removed_at` "unless Phase 0 finds a gap". Search adds no new rule.

**User decision (2026-10-13): whole-history visibility for a member is intended**, including messages sent before they joined a care-team
or DM channel; it is the existing behaviour of the history read path. Consequently: **a message is findable if and only if the user can
currently read it through the history path** (`canViewChannelFor` and `effectivelyVisibleChannels` as they stand). Search must be
neither stricter nor looser than history read; a member added after messages were sent finds the older messages. The privacy officer
is **informed** of this decision (it is recorded in the design review input), **not asked** to decide it. If a future decision narrows
history visibility, it changes the history read path for all of messaging and search follows it with no search-specific rule; the
verification case `pre-join-history-matches-history-read` pins the equivalence in both directions.

**Archived channels (Proposed default, for security/privacy reviewers to confirm).** Global search includes archived channels for
users who are **current members** (or any active user for an archived `announcement`), read-only, with each result marked
`archived: true`. The code today: `canViewChannelFor` does not consider archive state (reads are allowed, writes get 410 via
`assertMessageChannelAccess(..., writable)`), whereas **WP 2.7a refuses an archived channel with 410 `CHANNEL_ARCHIVED`** in
`message-search-service-db.ts`. The two intentionally differ until 2.7a is aligned: 2.7a is a "search within this conversation" UI that
hid search on archived channels; global search surfaces them. Aligning 2.7a is a separate, small change and is listed in the
Migration section.

### Who may call the route: role categories (Decided 2026-10-13, user, delegated to the lead engineer's judgement)

**Decision (least privilege, default deny).** Identities whose roles are in the categories `patient_family`, `external_auditor` or
`platform_staff` must **never** hold `messaging.read` (or any search-equivalent permission) for global search. Rationale:
`patient_family` are not workforce and use the portal, not staff messaging; `external_auditor` access is two-stage, engagement-scoped and
BAA/second-factor gated (repo `CLAUDE.md`, "Auditor sessions are two-staged"), so any message access for an audit must be an
engagement-scoped route, never the global index; `platform_staff` (category K) are platform operators who must not read tenant PHI
messages (support access goes through the audited break-glass path elsewhere).

**Enforcement.**

1. The global search route requires `messaging.read` **and** a **role-category allow-list** of workforce categories, evaluated from the
   caller's active `membership_role` rows (with the `expires_at` test, as `mention-non-member-service-db.ts` line 64 does): the caller
   must hold at least one active role in the allow-list **and none** in the three excluded categories (deny wins). The list is derived
   from `RoleCategory` in `packages/auth/src/roles/templates.ts` (lines 22-34, twelve values) minus the three: `clinical_staff`,
   `clinical_leadership`, `operations`, `admin_executive`, `billing_finance`, `compliance_quality`, `volunteer`,
   `external_collaborator`, `temporary_special`. (Whether `external_collaborator` belongs on it is left to the reviewers; the
   instruction was to exclude only the three.)
2. **Live test** (`non-staff-identities-zero`, table row 13): an identity holding each of the three categories, **even if a tenant
   mistakenly granted its role `messaging.read`**, is refused by the route.
3. **Static ratchet test** (unit, no database): fails if any of the three categories is ever granted `messaging.read`, in the role
   templates (`ROLE_TEMPLATES` grants and `SYSTEM_LOCKED_FLOORS`), in the external-auditor grant list
   (`EXTERNAL_AUDITOR_PERMISSIONS`), or in any seed or migration `role_permission` insert for a role of those categories.

**What is true today (verified in the code on 2026-10-13).**

- `messaging.read` is declared in `packages/auth/src/permissions/contributed.ts` lines 240-245 (category `clinical`, ABAC
  `channel_visibility`) and mirrored as a catalog row in `packages/db/migrations/0600_permission_mirror_full_catalog.sql` line 510. The
  mirror inserts catalog rows only; it inserts no `role_permission` rows.
- **No role template grants `messaging.*`.** A search of `packages/auth/src/roles/*.ts` for `messaging` returns nothing: neither
  `ROLE_TEMPLATES` (templates.ts, from line ~255) nor `SYSTEM_LOCKED_FLOORS` (lines 206-247) names a messaging key. How the default
  workforce roles come to hold `messaging.read` in a tenant could not be traced to a seed in this repo (the tests grant it
  explicitly, for example `apps/backend/__tests__/messaging-routes.test.ts` lines 52-80); it is a tenant role configuration. Nothing
  structurally stops a tenant from granting it to a role of an excluded category, which is why the allow-list is required rather
  than relying on the absence of a grant.
- **`platform_staff`:** six templates (templates.ts lines 351, 363, 375, 387, 398, 410), whose grants come from
  `PLATFORM_OPS_ROLE_GRANTS` (line 168): `billing_admin.*` and the user-lifecycle keys only. **No `messaging.*` grant.**
- **`external_auditor`:** there is no role template. The role is created on first auditor-link redemption
  (`apps/backend/src/modules/03-authorization/auditor-access-grant.ts` line 134) with `EXTERNAL_AUDITOR_PERMISSIONS =
  ["portal.engagement.read_auditor"]` (line 27), and the grantor refuses a role holding anything beyond that minimum
  (`isMinimum`, lines 80-81, refusals at lines 121 and 146). **No `messaging.read`, and a grant of it is structurally refused.**
- **`patient_family`:** no role template and no role-creation code with this category exist in `apps/backend/src`, `packages/auth/src`
  or `packages/db/src`; the value exists only in the `role_category` enum (`packages/db/migrations/0008_authorization_m3_tables.sql`
  line 4). How family identities receive roles **could not be determined from this repo**, so no grant is found, but absence of a
  grant is not proven; the live test and the ratchet are required for that reason.
- M36 never adds the three categories to channels: `mention-non-member-service-db.ts` line 64 excludes them from the offered members.

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
| 13 | Any | Identity with role category `patient_family`, `external_auditor` or `platform_staff` | Zero (decided; see "Who may call the route") | the route refuses these categories before any search runs; M36 never adds them to channels (`mention-non-member-service-db.ts` line 64 excludes the three categories) | `non-staff-identities-zero` |
| 14 | Any | Member, message sent **before** they joined | Results (**User decision**: findable iff readable through the history path) | no `joined_at` filter on any read path; decided, see "Pre-join history" | `pre-join-history-matches-history-read` |
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
| Patient names typed in messages | with no patient-name flag in v1, a name is indexed like any other word | none specific; ordinary tag protections | Names are the highest-value token for frequency and auxiliary-vocabulary attacks (the adversary can build a name list from outside data). **Proposed default, for security/privacy reviewers to confirm:** the reviewers decide between "index names" (current) and "exclude known patient-name tokens" from the index (at the cost of not finding messages by patient name) |
| Cross-tenant | nothing | distinct keys per tenant; RLS; cross-tenant collision test | Compromised KEK defeats all tenants |

The honest summary: option B trades a reduced blast radius for a database-only compromise (no plaintext copy exists, unlike C) against
known frequency/access-pattern leakage that option A does not have. A qualified reviewer must decide whether that is acceptable for
hospice PHI and whether `T`, bucket sizes and the stop-word list are adequate.

### Design review requirement

Reviewers (D10, decided 2026-10-11 by the product owner): the **security architect and the privacy officer**. The review gates
**building** WP 2.7b (pre-build design review) and **enabling** it in production (a **leakage test** must pass first). Before
acceptance: (1) a written review by the security architect, with searchable-encryption experience, and the privacy officer covering the table above, the
truncation width `T`, padding scheme, prefix lengths, key derivation and rotation, and the logging-hygiene controls, and confirming
or changing each "Proposed default" **and each "Decided 2026-10-13" parameter** in this ADR (the reviewers must in particular confirm
`T`, the single most leakage-relevant knob, and re-run the arithmetic on real tenant statistics; they also see, as inputs, the
user's pre-join-history decision, the escrow arrangement in P1, the flag and kill-switch design and the role-category rule); (2) a
measured experiment on synthetic hospice notes estimating how many top-N words an auxiliary-vocabulary frequency attack recovers
at the chosen `T` and the chosen tokenizer parameters (minimum token length, stop words, ID-like rule, caps), which also serves as the **production-enablement leakage test** (D10) and must pass before any tenant is enabled; (3) a record of the HIPAA risk-analysis entry for the new PHI-derived store; (4) product-owner acceptance of the
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
- A tenant-level M36 setting turns global search on or off, with an ops-owned platform kill switch above it (see "Enablement and
  kill switches"); off by default until the leakage test passes and the go-live checklist is satisfied.
- One more precondition for P1: the `MESSAGING_ENCRYPTION_KEY` escrow and a passing restore drill before the backfill starts.

## Migration / rollout

1. **P1 and P2 first** (each its own WP and PR, with their own live suites). P1 starts only after the key escrow is in place and the
   restore drill has passed (P1, "Key escrow until the backfill"); global search stays off in every tenant until escrow is confirmed.
2. After acceptance: migration for the table (check `arch:migration-numbering` against `main` first; branches collide on the next
   ordinal; manifest `ownedTables` in `.ts` and `.cjs`; mirror in `packages/db` and `packages/types`), key-derivation helper beside
   `body-crypto.ts`, tokenizer package-level pure function with the golden tests.
3. Backfill by the rebuild job per tenant (gated by the tenant `messaging.global_search_enabled` setting and the platform kill
   switch, both default off, see "Enablement and kill switches"); enable the query path only when the checkpoint is complete and
   the go-live checklist is satisfied. The org admin's ON request is refused until it is.
4. Wire the same-transaction deletion hooks (edit, redact, delete, eraser, retention) in the same release as the indexer, never later.
5. Add the eraser extension and DR/backup documentation for the new store.
6. Align WP 2.7a with the archived-channel rule (search read-only in archived channels, results marked) and add `cursor` to its
   `filterOmit`, as small follow-ups; neither blocks 2.7b.

## Verification

- Unit: tokenizer determinism and the **golden cases** in decision 3 (clinical strings, unicode, digits, diacritic folding,
  ID-like chunks, tokens over 40 characters dropped not truncated, stop words, `not` kept, `no` never indexed); tag derivation differs per
  tenant and per key version; no tag for tokens under the minimum length; padding sizes `N = max(16, 2^ceil(log2 n))` and dummy
  re-randomisation across two replaces of the same message; cursor encodes only `(created_at, id)`; AND-intersection SQL returns only
  messages holding all `k` tags.
- Live (real `wardenx_app` role, suite `test:m36:global-search:live`): every row of the "Channel state by user state" table; the
  prefilter-superset and structural "authority always applied" tests; stale-index-row re-verification; cross-tenant token collision
  test (same word, two tenants, tags differ and results never cross); tenant erasure leaves zero index rows **and**, after P1, ring
  destruction makes the bodies and `K_search` underivable; rebuild after truncating the table reproduces identical result sets;
  read-audit assertions in "Read audit" (event lands, `q` and `cursor` omitted, one attributed read per patient, audit failure fails
  the read); query text and tags absent from audit rows, access log and Postgres/`pg_stat_statements` capture; rate-limit test from P2.
  Added 2026-10-13:
  - **Pre-join history:** a user added to a channel **after** messages were sent finds the older message, and the same user, removed,
    finds nothing; the set of messages findable equals the set the history read path returns, in both directions
    (`pre-join-history-matches-history-read`).
  - **Role categories:** identities holding each of `patient_family`, `external_auditor`, `platform_staff` are refused even when
    their role was granted `messaging.read`; a workforce identity is allowed; a user with both an allowed and an excluded active role
    is refused (`non-staff-identities-zero`). **Static ratchet** (unit): no role template, floor, external-auditor grant list or
    seed `role_permission` for those three categories ever contains `messaging.read`.
  - **Flag and kill switch:** default OFF returns the disabled error; only an org admin with fresh step-up can change the setting
    (no permission, no org-admin, stale step-up each refused); each change writes an audit row with actor, time, old and new;
    turning ON is refused (409) while a legacy-envelope row exists or the rebuild checkpoint is incomplete; turning OFF makes the
    next query fail, the purge deletes the tenant's token rows, and the query path still refuses when purge is held back (rows
    lingering); the platform flag off overrides tenant ON, and an absent or unreadable platform flag is OFF; an org-scoped write of
    the platform key is refused.
  - **Escrow:** the restore drill record exists before the P1 backfill starts; with legacy rows present and the key missing, boot
    fails closed (`check:boot:platform`); a post-backfill `hash_verify` is clean before the key is retired.
  - **Parameters:** the leakage experiment is run at the chosen `T = 19` and tokenizer parameters; a unit test recomputes the
    "Parameter values and the T arithmetic" table from its stated assumptions so the document and the constants cannot drift; the
    measured false-candidate rate on a synthetic tenant is within the 500 cap for a typical single-word query.
- Performance: p95 < 1 s on a representative history (target in plan 2.7b), including the decrypt budget behaviour.
- Gates, all green before the PR: `arch:tenancy`, `check-fitness-gaps`, `arch:manifest-mirror`, `arch:migration-numbering`,
  `arch:outbox-bindings` (and a grep of `apps/backend/src/index.ts` for the indexer's consumer factory; green gates do not prove it
  is wired), `arch:abac-predicates` and `arch:abac-composed` (any new predicate or `requireAbac` is registered and composed),
  `arch:queue-names` (rebuild/indexer queues, one owner per name), `arch:live-suites` (the new live suite has a `package.json`
  script **and** a `ci.yml` job row), `test:fk-indexes:live`, `arch:openapi-provenance`/`client:check` for the new route.

## Open questions

What is genuinely still open, all for the reviewers (the items the user answered or delegated are in "Resolved" below):

- **The leakage analysis itself** (the table above and the measured experiment), and the reviewers' confirmation or change of `T`
  (the single most leakage-relevant knob) and of every other "Decided 2026-10-13" parameter, re-validated by measurement. Includes
  re-running the T arithmetic on real tenant statistics and confirming the per-tenant sizing rule.
- **Patient attribution mechanism** (service-emitted per-patient reads versus extending the read-audit hook): reviewers pick.
- **Redaction marker** (ADR-0055): the step 8.5 check reads whatever marker the redaction WP defines; decision 7 depends on it.
- **Archived channels** in global search (Proposed default in "Access control"), and whether known patient-name tokens are excluded
  from the index (Proposed default: not excluded in v1; see the leakage table).
- **Role-category allow-list:** whether `external_collaborator` (and `volunteer`, `temporary_special`) belong on the allow-list, and
  how `patient_family` identities receive roles (not determinable from this repo; the live test and the ratchet cover it).
- **Follow-up work items, not open decisions:** the M34 `FeatureFlagAdmin` guard against a tenant-scoped row for the platform kill
  switch key; the runbook checklist lines for the escrow and for "search tags are not logged".

Resolved (Decided 2026-10-11 by the product owner, D10): reviewers are the security architect and privacy officer; the review gates
both build and production enablement, with a leakage test before enablement; numeric/ID-like tokens and free-text identifiers are
not indexed; English only at launch with a pluggable tokeniser. Resolved (User decisions, 2026-10-13): key model option (b) (P1);
deleted/redacted windows of seconds are acceptable because step 8.5 re-verifies on the current row; a pending redaction is hidden
from search immediately; **pre-join history: a member may find messages from before they joined, search is exactly as strict as the
history read path, and the privacy officer is informed, not asked** ("Access control"). Resolved (Decided 2026-10-13, user, delegated
to the lead engineer's judgement, inputs the reviewers may still amend): **flag owner** is M36 with `messaging.global_search_enabled`
default off, org-admin only, step-up protected, audited, go-live checklist, OFF purges rows and the query path refuses regardless,
plus an ops-owned `messaging.global_search_platform_enabled` kill switch that overrides tenant ON, and the patient-name flag stays
dropped ("Enablement and kill switches"); **tokenizer and cap parameters** with exact initial values and the T arithmetic, rate limits
30/min/user and 300/min/org failing closed ("Parameter values and the T arithmetic", P2); **key escrow** of
`MESSAGING_ENCRYPTION_KEY` before the P1 backfill, with a restore drill and conditioned retirement (P1); **role categories**
`patient_family`, `external_auditor` and `platform_staff` never hold `messaging.read`, enforced by a workforce-category allow-list, a
live test and a static ratchet ("Who may call the route").
