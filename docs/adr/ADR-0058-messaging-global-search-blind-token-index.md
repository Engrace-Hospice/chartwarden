# ADR-0058 — Global message search is a per-tenant HMAC blind-token index (whole-word and prefix only), re-checked against current access at query time

- **Status:** **Accepted** (2026-10-13, by the user's decision in conversation: "turn ADR-0058 to accepted").
- **Review record:** [ADR-0058-design-review-2026-10-13.md](../reviews/ADR-0058-design-review-2026-10-13.md) records a security-architect review and a
  privacy-officer review, **both performed by AI agents as desk reviews, not by humans, and unsigned**. Disposition of both: **approved with
  conditions, design only; nothing approved for production enablement.** They changed one parameter (prefix tag lengths to 3, 5, 8, 12) and
  found stale amendment text and several gaps (record F1 to F12). The **measured leakage experiment has not been run**, the HIPAA risk-analysis
  entry is a draft with no owner, and human adoption and the product owner's residual-risk acceptance are pending, so the design review
  requirement below is **not satisfied**. Acceptance was granted by the user (product owner) before any review. D10 (decided 2026-10-11 by the
  product owner, who chose option B (D3) knowing it leaks token frequency) is unchanged.
- **Product-owner design decisions of 2026-10-13 (after the leakage experiment), built on `feat/m36-phase2-closeout`:** (1) **patient and
  contact names are excluded from the index**, because the experiment recovered a patient's surname bucket from the patient's own channel for
  about 93% of patients at any `T`; (2) **tags are keyed per channel** (`K_ch = HKDF(K_search, version, T, channel)`), so the same word is an
  unrelated tag in every channel. Both are **Accepted by decision**; they do **not** satisfy the design review requirement (the human sign-off,
  the leakage test on a production-shaped corpus, the HIPAA entry and residual-risk acceptance are still pending, and the vocabulary attacks of
  the experiment were NOT re-run against per-channel keys). They supersede the "names indexed in v1" default and the single-key text of
  decisions 2 to 5, 8 and 11 below; the full text is [Amendment 2026-10-13: name exclusion and per-channel keys](#amendment-2026-10-13-name-exclusion-and-per-channel-keys-product-owner-decision-built-review-requirement-not-satisfied).
- **What acceptance does not do:** it does not set `messaging.global_search_escrow_attested` or the rate-limit attestation (`globalSearchRateLimitActive`),
  which are statements of fact about the escrow drill and the limiter and are set only when true (the escrow drill is in
  `docs/runbooks/m36-body-key-ring.md`). The tenant switch still refuses ON until its go-live checklist passes. WP 2.7b was additionally
  **blocked on the two prerequisite work packages** in "Prerequisites" (WP 2.13 key-ring migration of message bodies; WP 2.14 per-route
  rate limit). In-conversation search (WP 2.7a, option A) does not depend on this ADR.
- **Date:** 2026-10-11 (revised 2026-10-13 after design review feedback, and again 2026-10-13 to record the open-question decisions; Status: Accepted since 2026-10-13, see line 3)
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
> changes Status: the Status is **Accepted** (by the user's decision, line 3), but the review in "Design review requirement" has **not
> yet been satisfied** (AI desk reviews only; human adoption, the measured leakage experiment, the HIPAA risk-analysis entry and the
> product owner's residual-risk acceptance are pending), and **no tenant may be enabled in production until it is**.

### Decisions taken 2026-10-13 (summary; the text below is authoritative)

| # | Topic | Decision | Where |
|---|---|---|---|
| 1 | Pre-join history | **User decision:** a member may find messages sent before they joined. For workforce members search is exactly as strict as the history read path, no stricter, no looser (the three excluded role categories are deliberately stricter, row 13). The privacy officer is informed, not asked; the consequences are listed in "Pre-join history". | Access control; row 14 |
| 2 | Flag owner | **M36** owns `messaging.global_search_enabled`; default OFF; org-admin only, step-up, audited; go-live checklist; OFF purges tokens; an ops-owned platform kill switch overrides ON. | Enablement and kill switches |
| 3 | Tokenizer and caps | Exact initial values (NFKC, diacritic folding, min token 3, max 40, ID-like rule, stop words, `T = 19`, cap 500, budget 200 / 3 s, padding floor 16, limits 30/300 fail-closed). Tunable by config, each to be re-validated by measurement. | Decision 3, 4, 9; "Parameter values and the T arithmetic" |
| 4 | Key escrow | `MESSAGING_ENCRYPTION_KEY` is escrowed (Shamir 2-of-3, three custodian roles, separate failure domain) and a restore drill passes before the P1 backfill; retirement only after backfill verification. Global search stays off everywhere until escrow is confirmed. | P1 |
| 5 | Role categories | `patient_family`, `external_auditor`, `platform_staff` never hold `messaging.read`; the route also requires a workforce-category allow-list (six categories; `external_collaborator`, `volunteer`, `temporary_special` are off it by default); live test plus a static ratchet. | Access control; row 13 |
| 6 | Patient and contact names | **Product-owner decision (after the experiment):** tokens equal to a name part of a patient, caregiver or emergency contact are never indexed (whole-word and prefix tags) and never matched; a keyed-digest set per tenant, grow-only, kept current by the maintenance tick. | Amendment 2026-10-13 (name exclusion) |
| 7 | Tag keys | **Product-owner decision:** `K_ch = HKDF(K_search, version, T, channel_id)`; `channel_id` added to the token row and index; a query derives tags for the caller's member channels plus announcement channels only (at most 300, most recently active). | Amendment 2026-10-13 (per-channel keys) |

**Remaining genuinely open** (for the reviewers, see "Open questions"): the leakage analysis itself and confirmation of `T` and the other
parameters (including the heavy-tail candidate bound, the prefix-hierarchy leakage and the within-channel frequency leakage of per-channel keys); the redaction marker (ADR-0055); the
patient-attribution mechanism; archived-channel inclusion (patient-name exclusion is DECIDED, row 6); whether
`external_collaborator`, `volunteer` and `temporary_special` are added to the role-category allow-list (off it by default); how
`patient_family` identities receive roles; and the privacy officer's risk-analysis coverage of the pre-join-history decision.

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

Work-package numbers in the [Messaging Hub plan](../messaging-hub/03-phases-0-to-3.md): **P1 is WP 2.13**, **P2 is WP 2.14**. "P1" and "P2" below are this ADR's labels (not Phase 1 or Phase 2).

### P1. Migrate message bodies to the M34 wrapped-DEK ring (User decision: key model option (b))

**User decision (2026-10-13):** WP 2.7b is gated on first migrating `message.body_cipher` **and** `message_revision.body_cipher` from
HKDF-from-`MESSAGING_ENCRYPTION_KEY` to the M34 wrapped-DEK ring (`TenantKeyProvider`), giving a real crypto-shred and real rotation.
The earlier draft's claim that "destroying the tenant key makes the index unusable by construction" is **withdrawn**: under the
current scheme there is no tenant key to destroy (body-crypto.ts:24,43), so it was false. After P1 it becomes true, and only then,
**with one qualification:** while backups that contain legacy-wrapped ciphertext still exist (they are readable with
`MESSAGING_ENCRYPTION_KEY` alone), tenant erasure and ring destruction do **not** shred those copies. The crypto-shred is complete
for a tenant only once those backups have aged out or been re-wrapped (see the retirement conditions below).

Scope of P1 (WP 2.13, its own WP; sized as a data migration, not a code tweak):

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

**Status of P1 (WP 2.13, implemented on branch `feat/m36-wp213-body-key-ring`; this ADR is Accepted by the user's decision, with the design review requirement not satisfied):** items 1, 2, 3 and 6 are built and proved live (envelope `VERSION` byte 2 recording the ring version; reads open both schemes; new writes seal on the ring behind `M36_BODY_SEAL_SCHEME=ring`, default `legacy`; the resumable, tenant-scoped, hash-checked backfill with the revision re-seal through the audited definer function `m36_reseal_message_revision`, migration 1089; both-scheme and mixed-version live tests, revisions migrate, `body_sha256` unchanged, `hash_verify` clean). Item 4 is satisfied by M34's existing four-phase shred (module erasers, then `m34_destroy_tenant_key_ring`): after it every ring-sealed body fails to open (live test); legacy-sealed rows and their backups are not shredded until backfilled and aged out. Item 5 is **partly** done: a new DEK version seals new bodies and old ring bodies stay readable by their recorded version (live test); re-sealing existing ring rows to a newer version is NOT built, and the ops runbook section 8.3.3 and `02` section 6 are not yet edited (the operator side is `docs/runbooks/m36-body-key-ring.md`). Escrow: the restore drill is an operational precondition and is not automated; the backfill refuses to run in a production environment unless `M36_BODY_BACKFILL_ESCROW_DRILL_CONFIRMED=true`. The legacy derivation and `MESSAGING_ENCRYPTION_KEY` are untouched; retirement is a later, separately gated step.

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
  (`hipaa_security_officer`), the CTO, and a break-glass vault. Any two reconstruct the key; no single role can. **Independence
  requirements (the split is worth nothing without them):** the three holders are **three distinct natural persons**, and the
  security officer and the CTO are never the same person; the vault is opened only under **dual control by someone other than the
  two named officers**, so neither officer can open it alone and thereby hold two shares; **a restore re-drill is run on every
  custodian change and at least annually.** The escrow lives in
  a **different failure domain** from the primary (different site and different custodians from the SOPS age-key envelopes in
  runbook §8.4, which it must not share a single point of loss with). It extends the runbook §8.3.3 practice of keeping
  `M34_TENANT_KEK` in the sealed off-site envelope; the runbook gets a matching checklist line (a P1 deliverable).
- The **key version** (the `MESSAGING_ENCRYPTION_KEY` generation and the envelope `VERSION` byte it serves) is recorded with the
  escrow record, so the right copy is restored for the right ciphertext.
- **Restore drill before the backfill starts (P1 precondition, recorded):** reconstruct the key from two shares in a clean
  environment, decrypt a sampled, production-shaped message body and revision (a copy, never the live rows), and confirm the
  plaintext matches `body_sha256`. No backfill starts without a passing drill on record.
- **No rotation during the backfill window.** The legacy derivation is a pure function of the key and the org id, so rotating it
  mid-migration would strand the un-migrated rows. **Exception: a suspected or confirmed compromise of `MESSAGING_ENCRYPTION_KEY`**
  triggers an **expedited backfill** (priority and resources raised, the incident process of the runbook applies, the key
  retained read-only until the backfill and retirement conditions are met) rather than waiting out the window.
- **P1 moves the single point of loss, so the same standard applies to `M34_TENANT_KEK` and the `tenant_key_ring` rows (P1
  precondition).** After the backfill every message body is only as recoverable as the KEK that wraps the tenant DEKs. ADR-0045 §1
  holds `M34_TENANT_KEK` the same way (the deployment's secret manager, injected as an environment variable), and runbook §8.3.3
  already says that losing it without a retired copy is unrecoverable and that it belongs in the sealed off-site envelope beside
  `SOPS_AGE_KEY`. Nothing here changes that custody. P1 adds, as a precondition of enabling search: the Shamir 2-of-3 escrow and the
  independence requirements above for `M34_TENANT_KEK` (and its retired entries, ADR-0045 §5), a recorded restore drill that
  unwraps a sampled production-shaped tenant DEK from a restored `tenant_key_ring` row and decrypts a sampled message, and backup
  and restore coverage of `tenant_key_ring` itself.
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
2. **Keys (after P1).** `K_search(org, v) = HKDF-SHA256(ikm = TenantDek.key, salt = "", info = "wardenx-message-search:" || orgId || ":" || ringVersionLabel)`
   where `TenantDek` is the unwrapped M34 DEK for key-ring version `v` and the info label is distinct from the body-encryption label,
   so the two keys are domain-separated. `v` is stored on every index row. Rotation: a new ring version, rebuild under it, query both
   during the overlap, then delete the old version's rows (as built: only the active version is live, and the old version's rows and state are
   removed in the same transaction that marks the new version `ready`, security review M1). **Per-channel keys (product-owner decision
   2026-10-13):** the key that tags a message is `K_ch = HKDF-SHA256(ikm = K_search, salt = "", info = "wardenx-message-search-channel:" || version || ":t" || T || ":" || channel_id)`
   (`deriveChannelKey`; the version label and `T` are bound into the info, security review L3, so a rebuild at another `T` or under another ring
   version yields unrelated tags). The same word therefore has a different tag in every channel. **Ring destruction (P1) makes the index unusable** because `K_search` can no
   longer be derived for any version and the tags are indistinguishable from random without it; the eraser still deletes the rows
   (the index is PHI-derived, so it is not left behind on the argument that it is unreadable). If P1 has not shipped, 2.7b does not.
3. **Tokenisation (server-side, deterministic). Decided 2026-10-13 (user, delegated to the lead engineer's judgement); initial values,
   tunable by config, each re-validated by the leakage review with a measurement.** The pipeline, in this order (the query is tokenised
   by the identical code):
   0. **Chunk and filter ID-like first, on the NFKC form before lowercasing** (case is part of the ID-like test, rule (b) below):
      split on whitespace and drop every ID-like chunk. Then, for the surviving chunks:
   1. **Normalise:** Unicode NFKC, then lowercase with the locale-independent `String.prototype.toLowerCase` (never a locale-aware
      call, so "I" does not become dotless-i on a Turkish server).
   2. **Fold diacritics (English launch tokenizer):** NFD, strip combining marks (`\p{M}`), recompose. "café" and "cafe" are one token.
      The folding is part of the pluggable tokeniser, so other languages can choose differently without changing the index shape.
   3. **Split each remaining chunk on non-letters** (`\P{L}`): digits and punctuation are separators, so no indexed token ever
      contains a digit. (The ID-like definition is below; it ran in step 0.)
   4. **Length bounds:** tokens shorter than **3** are dropped (minimum indexed token length 3); tokens longer than **40** are
      **dropped, not truncated** (a truncated 40-character stem would be a stable fingerprint of a long identifier-like string).
   5. **Stop words:** drop the stop-word list below.

   **"ID-like" (Decided; reviewers confirm).** A chunk is ID-like, and is not indexed at all, if any of these hold: (a) it matches a
   UUID, an email address, a URL (`scheme://` or `www.`), a phone-number shape (7 or more digits once separators are removed), or an
   MRN-like shape (an alphabetic prefix of 2-4 letters directly followed by 5 or more digits, or any run of 6 or more digits); (b) it
   is 20 or more characters drawn only from `[a-f0-9]` (hex) **and contains at least one digit**, or is 20 or more characters of the
   base32 or base64/base64url alphabet **and contains at least one digit, or mixes upper and lower case, or contains `_`, `-`, `+`,
   `/` or `=`** (so a long letter-only word such as `esophagogastroduodenoscopy`, 26 letters, is **not** ID-like and is indexed; the
   40-character maximum then applies to letter-only strings, which keeps the cap meaningful); (c) it
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

   **Patient and contact names are NOT indexed (product-owner decision 2026-10-13, superseding the earlier "names are ordinary words in v1"
   default):** a token equal to a name part of a patient (legal first / middle / last, every alias), of a linked caregiver or of an
   emergency contact gets **no whole-word tag and no prefix tag**, and never matches a query. There is still no per-tenant name flag: the
   exclusion is unconditional. Mechanism, change handling and the query-side rule are in the amendment below; the measured reason is the
   channel-linked name recovery of about 93%.
   **English only at launch**, behind a **pluggable tokeniser** interface so other languages and diacritic policies can be added later
   without changing the index shape (D10, decided 2026-10-11 by the product owner). Each distinct token yields:
   - a **whole-word tag** `HMAC(K, "w\0" || token)`;
   - **prefix tags** `HMAC(K, "p\0" || len || "\0" || prefix)` at the **sparse lengths 3, 5, 8 and 12 only** (a word shorter than a listed length contributes only the lengths
     up to its own length; no prefix tag beyond 12 characters; decided in the 2026-10-13 AI desk review, pending human sign-off,
     see [ADR-0058-design-review-2026-10-13.md](../reviews/ADR-0058-design-review-2026-10-13.md)). No prefix shorter than 3, no
     infix/suffix grams, no trigram of short strings, no character positions or word order stored. The **minimum query prefix
     length is 3**, equal to the minimum prefix tag length.

   **Golden clinical cases** (the unit suite asserts these exact outputs; `n` counts whole + prefix tags before padding):

   | Input | Tokens | Tags | `n` |
   |---|---|---|---|
   | `morphine` | `morphine` | whole(`morphine`); prefix lengths 3, 5, 8: `mor`, `morph`, `morphine` | 4 |
   | `5 mg` | none (`5` has no letters; `mg` is under 3 characters) | none | 0 |
   | `5mg` | none (one transition, so `5` is a separator; `mg` is under 3 characters) | none | 0 |
   | `MS Contin 15` | `contin` (`ms` under 3 characters; `15` has no letters) | whole(`contin`) + prefix lengths 3, 5: `con`, `conti` | 3 |
   | `MRN 12345678` | `mrn` (`12345678` is ID-like: 6 or more digits, dropped) | whole(`mrn`); prefix `mrn` | 2 |
   | `Café` and `cafe` | `cafe` | same tags for both spellings: whole(`cafe`) + prefix `caf` (length 4 is not a prefix length) | 2 |
   | `hba1c` | none (two transitions: ID-like) | none | 0 |
   | `not eating` | `not`, `eating` (neither is a stop word) | whole(`not`), prefix `not`; whole(`eating`) + prefixes `eat`, `eatin` | 2 + 3 = 5 |

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
   power of two that covers the typical short clinical message (a single long word is now 4 tags at most plus its whole-word tag; the floor still covers typical short messages), so most short messages
   are indistinguishable by row count. Each dummy is a uniformly random `T`-bit value from a CSPRNG, **not**
   derived from the message id, the key or the content, and is **re-randomised on every per-message replace and every rebuild**, so a
   rebuild does not reproduce (and an observer cannot link) a prior dummy set. Rows carry
   `(organization_id, key_version, channel_id, tag, message_id)` (**`channel_id` is now stored**, product-owner decision 2026-10-13: it is what
   lets the key differ per channel and lets a query probe only the caller's channels; it is the plaintext `message.channel_id`, so it adds no
   information a snapshot reader did not already have by joining `message_id`). Row order is not meaningful. **`T` sizing (security review
   H2):** `T = clamp(round(log2(totalRows / 150)), 12, 20)` where `totalRows` is the number of stored token rows (real and dummy) of the
   (organization, key version); a new index is sized on the tenant's live messages x the padding floor (16), the real count is measured after
   each verified build, and a stored `T` that the rule would change by 2 or more bits (4x the rows) is rebuilt (one bit is rounding; no flapping).
5. **Table.** `message_search_token` (working name), three-column rule (org column, RLS on `app.org_id`, FORCE, PHI write-audit
   trigger), index on `(organization_id, key_version, channel_id, tag, message_id)` (migration 1096), FK on `message_id` index-covered. It is classified as PHI-derived for
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
   2. Tokenise the query the same way; build tags (whole-word for complete words, a prefix tag for a trailing partial word of >= 3
      characters, at the largest prefix-tag length in {3, 5, 8, 12} that does not exceed the typed length: 4 characters query the
      3-tag, 9 to 11 the 8-tag, 12 or more the 12-tag; step 5 below makes the result exact); reject queries with no indexable token with a message explaining the limit.
   2a. **Per-channel tags (product-owner decision 2026-10-13).** First select the caller's searchable channels: active `channel_member` rows
      plus announcement channels, most recently active first, **at most `MAX_QUERY_CHANNELS = 300`**. Above 300 the 300 most recently active
      are searched and the response carries `scanCapped: true` (never silent; it reveals only that a bound was reached, not a count: the same
      class as the accepted `scanCapped` threshold oracle). Then derive `K_ch` and the term tags for **each** of those channels only. A
      channel the caller is not a member of is never given a tag, so a probe cannot reach it, and the membership-or-announcement SQL join
      still applies as before.
   3. **Coarse SQL prefilter** (see "Access control"): candidate `message_id`s by `(channel_id, tag)`, `key_version` in the live versions, joined to
      `message` with `status <> 'deleted'`, restricted to channels where the user has an active `channel_member` row
      (`removed_at IS NULL`) **or** the channel is an `announcement` (org-wide, no membership row), ordered by recency, capped.
      **Multi-word queries are an AND-intersection in SQL:** with `k` distinct query tags,
      `... JOIN q ON (key_version, channel_id, tag) GROUP BY message_id HAVING count(DISTINCT tag) = $k` (`k` per channel: two terms can collide at `T` bits in one channel); the cap applies after the intersection.
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
    Since 2026-10-13 every pass first re-reads the tenant's patient/contact names (grow-only keyed digests), ends by rewriting the
    already-indexed messages that carry a newly excluded name, and a verified `ready` removes the other key versions' rows and re-checks `T`
    against the real row count (amendment at the end).
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
| Prefix tag lengths | **sparse set {3, 5, 8, 12}** (a word shorter than a length contributes only lengths <= its own; none beyond 12). **Decided in the 2026-10-13 AI desk review (pending human sign-off; [ADR-0058-design-review-2026-10-13.md](../reviews/ADR-0058-design-review-2026-10-13.md))**, replacing the earlier initial "every length 3 to min(len, 12)". | A dense chain gives each word a cluster of 2 to 11 tags in the same messages (cluster size reveals length, shared prefixes reveal where words diverge); the sparse set cuts the chain to at most 5 tags per word. Cost: a typed prefix of 4, 6, 7 or 9 to 11 characters uses the next-shorter tag, so its candidate set is wider and the post-decrypt check (step 8.5) does the exact filtering. See the prefix-hierarchy row in the leakage table. |
| Head-bucket refusal | `HEAD_BUCKET_ROWS = 5,000` rows **per (channel, tag)**, at most 2,000 pairs recorded, `MAX_PAGES_PER_QUERY = 5` | Bounds the heavy-tail case; a bucket is channel-local since 2026-10-13 (see the amendment). |
| Channels per query | `MAX_QUERY_CHANNELS = 300`, most recently active first | Every searched channel costs one tag per term; above it the response says the scan was capped. |
| Stop words | the 101-word English list in decision 3; negations and clinical words stay indexed | Cuts the highest-frequency function words; `not` is kept because "not eating" is a clinical query. |
| ID-like | decision 3 (digits, UUID/email/URL/phone/MRN shapes, 20+ hex/base32/base64, two or more letter-digit transitions) | Over-inclusive on purpose: a miss is cheaper than a leaked identifier. |
| HMAC tag width `T` | **19 bits as the unknown-tenant default; per tenant `T = clamp(round(log2(totalRows / 150)), 12, 20)`** (security review H2, built 2026-10-13) | See the arithmetic below; **the most leakage-relevant knob, reviewers must confirm.** A unit test recomputes the table below and the rule. |
| Padding | `N = max(16, 2^ceil(log2 n))`, `N = 16` when `n = 0`, dummies random per replace and rebuild | Hides message length within a power-of-two band. |
| `CANDIDATE_CAP` | 500 | Bounds SQL work per page; the cursor continues past it. |
| `DECRYPT_BUDGET` / `DECRYPT_TIMEOUT_MS` | 200 bodies / 3000 ms, inside a 5000 ms `statement_timeout` | Unchanged; consistent with the cap (the cap limits SQL, the budget limits decrypt, the cursor reconciles them). |
| Rate limits | 30/min/user, 300/min/org, fail-closed (503) on store outage | See P2. |

**Per-channel keys change what a bucket is (2026-10-13).** The table below is the arithmetic for ONE key space (a global key, the superseded
scheme, and the per-tenant row count it assumed). With per-channel keys every channel has its own `2^T` buckets, so the rows per bucket an
observer sees inside a channel are `channel rows / 2^T`, **far fewer than the table's 153** for all but the very largest channels (a
channel with 2,000 rows has 0.5 rows per bucket at `T = 12`, 0.004 at `T = 19`). Masking inside a channel is therefore **weaker** than the
table suggests, while the cross-channel aggregation the table's reference tenant exposed (one word's frequency over all 5 x 10^6 messages)
no longer exists. The rule `T = clamp(round(log2(totalRows / 150)), 12, 20)` is kept as decided; whether a per-channel rule would be better
(smaller `T` costs little now, because a query's false candidates are confined to the channels it probes) is a reviewer question. The
table is retained, recomputed by the unit suite, as the reference-tenant arithmetic.

**Why T matters.** `T` sets the number of buckets `B = 2^T`. A bucket's row count is all an observer of a database snapshot sees, so a
tag that is alone in its bucket reveals its exact frequency, and a tag that shares its bucket with others reveals only the sum.
Collisions also create false candidates for the query path. Both effects scale with `D / B`, where `D` is the number of distinct tag
values in the tenant.

**Assumed reference tenant (the arithmetic is only as good as these, and the reviewers should re-run it on real tenant statistics):**
5 x 10^6 messages; 10^5 distinct indexed tokens. **Recomputed 2026-10-13 for the sparse prefix set {3, 5, 8, 12}** (the earlier dense
chain gave `D = 4 x 10^5` and `n = 24`, padded to 32). Prefix tags are now kept at four lengths only. The earlier assumption was 3 x 10^5
distinct prefix tags over lengths 3 to 12; spreading that over the lengths with a plausible profile (few distinct 3-letter prefixes,
most at 5 to 8, fewer at 12) leaves about 10^5 distinct prefix tags at the four kept lengths, so `D = 10^5` whole-word + `10^5` prefix =
**`D = 2 x 10^5`**. Real tags per message: the dense `n = 24` corresponds to about 4.4 indexed tokens at about 5.5 tags each; at the
sparse set a token averages about 3.3 tags (whole + lengths 3 and 5, and 8 or 12 for longer words), so **`n` is about 14.5 and pads
to `N = 16`** (the floor), 5 x 10^6 x 16 = **8 x 10^7 rows** (7.25 x 10^7 real, 7.5 x 10^6 dummy). Like the earlier table this applies
the padding rule to the mean `n`; the mean of `N` over a skewed message-length distribution is higher (a message of 17 or more real tags
pads to 32), so 8 x 10^7 is a lower bound on rows; **all of these are assumptions to be replaced by measurement** (the 10^5 prefix
tags, the 4.4 tokens per message and the token-length profile are not measured).

| `T` | Buckets `B = 2^T` | Tags per bucket `D/B` | Share of tags that share a bucket `1 - e^(-D/B)` | Rows per bucket `8e7 / B` |
|---|---|---|---|---|
| 32 (earlier draft) | 4.29 x 10^9 | 4.7 x 10^-5 | 0.005% | 0.02 |
| 24 | 1.68 x 10^7 | 0.012 | 1.2% | 4.8 |
| 20 | 1.05 x 10^6 | 0.19 | 17% | 76 |
| **19 (chosen)** | **5.24 x 10^5** | **0.38** | **32%** | **153 (138 real + 14 dummy)** |
| 18 | 2.62 x 10^5 | 0.76 | 53% | 305 |
| 17 | 1.31 x 10^5 | 1.53 | 78% | 610 |
| 16 | 6.55 x 10^4 | 3.05 | 95% | 1221 |

(Before the sparse set the same table read `D = 4 x 10^5`, `1.6 x 10^8` rows: T = 19 gave 0.76 tags per bucket, 53% sharing and 305 rows
per bucket. The sparse set halves `D`, so at the same `T` fewer tags share a bucket, that is **less masking**, and halves the rows per
bucket. T = 18 now reproduces the old T = 19 masking figures (0.76, 53%, 305 rows). `T = 19` is kept as the default, the more
conservative choice for masking; the per-tenant sizing rule `T = clamp(round(log2(D_org / 0.75)), 12, 20)` now yields 18 for this
reference tenant and is unchanged. Whether to default to 18 is a reviewer decision.)

- **`T = 32` masks nothing.** At 4.7 x 10^-5 tags per bucket every tag is alone in its bucket, so the stored value is a bijection of
  the tag and the frequency histogram is exact. The earlier draft's "many distinct words per tag value" was wrong at this size.
- **False-candidate rate for a single-word query** with `m` true matches is about `bucket rows / (m + bucket rows)`. At `T = 19`,
  a rare word (`m = 50`) yields about 50 + 153 = 203 candidates, of which about 75% are false and are dropped after decryption
  (step 8.5); a common word (`m = 500`) yields about 653 candidates, 23% false, cut to 500 by recency and continued through the cursor.
  At `T = 18` the same rare word yields about 355 candidates (86% false), still under the cap; `T = 17` yields about 660 (92% false),
  above it; at `T = 32` it yields about 50.02 (0.04% false) and no masking. **Typed-prefix queries are wider than these single-tag
  figures:** a typed prefix of 4, 6, 7 or 9 to 11 characters queries the next-shorter prefix tag (3, 5, 5, 8), whose message set is a
  superset of the typed prefix's matches, so it carries extra true-tag candidates that the post-decrypt check removes (a 4-letter
  typed prefix is answered by the 3-letter tag, the widest set of the chain). That widening is the price of the sparse set and is not
  in the table; the experiment must measure it.
- **Multi-word queries are close to exact.** A random message holds a given bucket with probability `153 / 5 x 10^6 = 3.1 x 10^-5`;
  for two words the expected false candidates are `5 x 10^6 x (3.1 x 10^-5)^2 = 0.0047` per query.
- **Against the cap, mean case only.** For the **mean** bucket (153 rows), a typical single-word candidate set (203 for `m = 50`) stays under
  `CANDIDATE_CAP = 500` at `T = 19`, and still at `T = 18` (355); `T = 17` is the first `T` that exceeds it (660). This holds **only for
  the mean**: row frequencies are heavy-tailed, so the mean says nothing about a bucket that holds a head tag (next bullet). The
  mean case fits the 200-body decrypt budget only through the cursor (a page examines up to 200 of about 203 to 355 candidates and
  returns `nextCursor` / `scanCapped`), which is the designed behaviour, not a failure.
- **Tail bound: P(candidates > cap).** A rare word that shares a bucket with a head tag inherits that tag's whole message set: a
  tag in 10^6 messages makes about 10^6 candidates, nearly all false, far beyond the 500 cap and the 200-body budget. The
  probability that a given bucket holds at least one tag with at least `h` rows is `1 - e^(-H/B)` with `H` the number of such tags
  (assumed counts, a Zipf-shaped tenant; **to be measured, not trusted**): for about `H = 5,000` head tags of 10^5 or more rows,
  `1 - e^(-5000/524288)` = **0.95%** of buckets, so about 1% of rare-word single-term queries; for about `H = 3 x 10^4` tags of 500
  or more rows (anything that alone can fill the cap), `1 - e^(-3e4/524288)` = **5.6%** (`H` is an assumed count and is independent of the sparse recomputation; fewer prefix lengths may lower it, so treat these as upper figures until measured). At `T = 18` these are 1.9% and 10.8%; at
  `T = 16` they are 7.4% and 36.7%, which is the real price of more masking. So single-term queries on a rare word will hit the
  cap for roughly 1% to 6% of words at `T = 19`, and **those queries are unusable as designed unless the product handles them**.
- **What the product does for such a query (decided, deterministic, never an unbounded decrypt).** The query path never decrypts
  more than `DECRYPT_BUDGET` per request nor chases a cursor chain beyond `MAX_PAGES_PER_QUERY = 5` (at most 1,000 bodies per
  logical query; Decided initial value, tunable). When the candidate set reaches `CANDIDATE_CAP` and the pages examined so far have
  produced fewer than a page of verified results, the response is a fixed **refine-your-query** result: the verified results found
  so far (possibly none), `scanCapped: true`, `refine: true`, and no `nextCursor`; the UI says "too many possible matches, add
  another word". The same deterministic response for the same state, so it is not a new oracle beyond what the candidate count
  already shows the user.
- **Mitigation recorded (initial decision; made channel-scoped 2026-10-13): a head-bucket set and a second-term requirement.** A
  statistics job (run each time a build is verified) records the `(channel_id, tag)` pairs whose row count exceeds `HEAD_BUCKET_ROWS = 5,000`
  (10 x the cap; initial, tunable) per `(organization_id, key_version)`, as `'<channel>:<tag>'` strings (channel ids and bucket numbers only: no
  plaintext and no token list; at most 2,000 pairs, the largest first). With per-channel keys a bucket belongs to one channel, so the tail
  bound above is a per-channel statement and a head bucket needs a very large channel. A **single-term query**
  whose tag falls in a head bucket **of a channel** skips that channel (the response is flagged `scanCapped`; if every searched channel is
  skipped it is the refine-your-query response, with no candidate SQL and no decrypt); a query of
  two or more terms proceeds, because the AND-intersection is close to exact (0.0047 false candidates above), provided at least one
  term is not in a head bucket. Alternatives considered: (a) a per-tenant frequency stop-word list that removes head tags from the
  index entirely (it also removes the strongest frequency signal, but makes common clinical words unsearchable even in combination,
  so it is recorded as a **reviewer option**, not the initial decision); (b) raising `T` (rejected: worse masking trade, above).
- **Acceptance item (leakage experiment and go-live):** **measure `P(candidates > CANDIDATE_CAP)` on a production-shaped corpus**
  for single-term and two-term queries, at the chosen `T`, and compare it with the 1% to 6% estimate above; the go-live checklist
  fails if the measured single-term rate, after the head-bucket refusal, leaves a typical clinical vocabulary query unusable.
- **Dummies** add about 14 +/- 4 rows to every bucket at the default `T = 19` (Poisson: 7.5 x 10^6 dummy rows / 2^19 = 5.24 x 10^5 buckets = 14.3 per bucket, standard deviation sqrt(14.3) = 3.8; the other 138 of the 153 rows per bucket are real), so even a tag alone in its bucket is not read exactly.
- **What `T` cannot do.** A word in 10^6 messages sits in a bucket with about 10^6 rows at any `T`; the head of the frequency
  distribution stays identifiable by rank, and padding does not change that. Truncation protects the long tail (rare words, which
  include names), not the head. This is the known limit of option B (see the leakage table).
- **Sizing across tenants (replaced 2026-10-13, security review H2).** The reference tenant is large. `T` is stored with each
  `(organization_id, key_version)`. It is chosen when the state row is created as `T = clamp(round(log2(totalRows / 150)), 12, 20)` with
  `totalRows` estimated as the tenant's live messages x 16 (the padding floor), which gives 19 for the reference tenant's 8 x 10^7 rows and 16
  for a tenant ten times smaller; the platform default when nothing is known is 19. The earlier rule sized on distinct tags
  (`D_org / 0.75`) and was blind to row growth. **Rebuild trigger (as built):** each time a build is verified `ready`, the real stored row
  count is measured (`refreshIndexStats`) and, if the rule's `T` differs from the stored `T` by **2 or more bits** (the row count is 4x off),
  the index is rebuilt at the rule's `T` (rows deleted, state `building`, search closed until `ready`; one bit is rounding and never
  triggers). The earlier "alert at `D_org / B > 1.5` or 2x growth" text is superseded. There is no overlap rebuild: a tag is the top `T`
  bits, so rows at another `T` cannot be queried.

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
   `packages/db/migrations/1086_m36_message_template.sql`), **plus** [as built, 2026-10-13: no org-admin ABAC predicate; the gate is the tenant-assignable permission plus step-up] **plus** `requireStepUp("messaging.global_search.configure")` on the route.
   **Requirement:** that operation key is registered wherever step-up operation keys are enumerated for tenant tightening (the
   `tenant_step_up_policy_override.operation_key` surface, M2), so it is a named, tightenable operation; an unnamed operation
   resolves to the platform floor (`apps/backend/src/bootstrap/step-up.ts`, `STEP_UP_FLOOR_KEY`), which would work but would not
   be tenant-tightenable. Built: step-up operation keys are free-form lower-case dotted strings (`OPERATION_KEY_PATTERN`), so nothing needs registering.
   Every change is **audit-logged with who, when, old value and new value** (the write-audit trigger on the table; as built, no separate domain event, the trigger is the only audit).
3. **Turning ON requires the go-live checklist**, enforced where code can enforce it and attested where it cannot: (a) the
   **leakage review record is linked in this ADR** and the leakage review requirement is satisfied, attested by ops setting the separate platform flag
   `messaging.global_search_leakage_attested` (org-NULL row only, fail closed; checklist item `LEAKAGE_NOT_ATTESTED`, the fifth checklist
   item; it is a statement of fact set only after the measured experiment passed and the humans signed, and it gates the tenant ON only);
   (b) **P1 is done** for the tenant (no `message` or `message_revision` row on the legacy envelope; checked by the route, which
   refuses with 409 otherwise) **and the key escrow and restore drill are on record**; (c) **P2 is deployed** (the rate limit is
   active); (d) the **index rebuild is complete** for the tenant (checkpoint complete; the query path stays closed until then, as in
   "Migration / rollout"). A tenant ON while any of (a) to (d) is false is refused.
4. **Turning OFF** stops queries **immediately**: the query path reads the flag on every request (no cache, as search responses are
   not cached) and the indexer stops inserting for that tenant. A purge job then **deletes the tenant's token rows**: asynchronous,
   batched, idempotent and resumable, with completion audited. **The query path refuses even if rows linger**, so a slow or failed
   purge never leaves search answering. Turning back ON needs the checklist again and a full rebuild. **While a flag (tenant or
   platform) is OFF, the same-transaction delete and redaction hooks (decision 6) keep running unconditionally**: they never
   consult the flag, so a message deleted or redacted during the OFF period cannot be resurrected into the index. Before querying
   resumes after any OFF-then-ON (tenant or platform), **outbox replay and a reconciliation pass are required**: the indexer
   replays the `m36.message.sent.v1` / `revised.v1` events missed while off, and a reconciliation compares the index's message
   set with the eligible (non-deleted, non-redacted, non-pending-redaction) messages, repairing both missing and stale entries.
   The query path stays closed until reconciliation reports zero drift.
5. **Platform kill switch (ops-owned):** `messaging.global_search_platform_enabled`, a platform-global `feature_flag` key read through
   `FeatureFlagReaderPort`. Search runs for a tenant only if the tenant flag **and** the platform flag are both true; an absent or
   unreadable platform key is OFF (fail-closed). When ops turns it off, queries and indexing stop everywhere at once; token rows are
   **kept** (so a transient incident can be reversed without a rebuild) unless ops runs the same purge. Because a tenant-scoped row
   would win over the platform row, **this key must never be able to override the kill switch from a tenant row**. **Requirement
   (with a test):** the query path **and** the indexer read this one key **directly from the org-NULL platform row** (a dedicated
   read of `feature_flag` where `organization_id IS NULL` and `flag_key` is the key, honouring `kill_switch_active` and the
   value), **not** through the merged `forOrg` map, so a tenant-scoped `feature_flag` row for the same key, written by a seed, a
   migration or plain SQL, can never turn search on when the platform row is off or absent. The test inserts such a tenant row and
   asserts search stays refused. Defence in depth: a follow-up makes M34's `FeatureFlagAdmin` upsert refuse an org-scoped write for
   it, also with a test. This flag is the kill switch plus the feature-on switch and nothing else; the leakage attestation is the
   separate `messaging.global_search_leakage_attested` flag of decision 3(a). By convention ops sets the leakage attestation first
   and only then turns this flag on.
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
currently read it through the history path** (`canViewChannelFor` and `effectivelyVisibleChannels` as they stand). **For workforce
members** search must be neither stricter nor looser than history read (the three excluded role categories are deliberately
stricter, see "Who may call the route"); a member added after messages were sent finds the older messages. The privacy officer
is **informed** of this decision (it is recorded in the design review input), **not asked** to decide it. If a future decision narrows
history visibility, it changes the history read path for all of messaging and search follows it with no search-specific rule; the
verification case `pre-join-history-matches-history-read` pins the equivalence in both directions.

**Consequences of the decision (documented for the privacy officer and the risk analysis; the decision is not reversed here):**

- A **newly added or auto-synced care-team member can search all earlier history**, including content from before they joined the
  channel or the care team. Search makes that history **discoverable** (a word query across every channel they belong to), where
  before it required opening and scrolling each channel.
- A **re-added member also reads the gap while they were removed**, because re-adding resets `joined_at` and no read path
  filters by it: `ensureDmMember` updates the removed row with `joinedAt: new Date()` and clears `removedAt`
  (`apps/backend/src/modules/36-messaging/messaging-route-service-db.ts` line 505), and the admin `addMember` inserts a fresh row
  (same file, ~line 1842). Messages sent between removal and re-adding are therefore visible and searchable.
- The **Part 2 gate is evaluated per channel at the current time** (`part2Gate.allowedUserIds`); there is no per-message consent
  period, so a message sent under an earlier consent state is searchable under the present one.
- A **legal hold does not change visibility** (decision 6: it preserves the cipher, never discoverability).
- **Discovery is audited only as an aggregate plus one attributed read per patient on a result page** ("Read audit"); there is no
  record of which individual messages were surfaced.
- The decision sits next to HIPAA's **minimum-necessary** standard and role-based access (45 CFR 164.502(b) and 164.514(d)).
  The privacy officer is informed of it, and **the HIPAA risk-analysis record required by "Design review requirement" item 3 must
  cover this decision, not only the new derived store.**

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
   from `RoleCategory` in `packages/auth/src/roles/templates.ts` (lines 22-34, twelve values) minus the three excluded ones **and
   minus three more that are off the list by default** (Decided 2026-10-13, the stricter and safer default): the initial allow-list
   is `clinical_staff`, `clinical_leadership`, `operations`, `admin_executive`, `billing_finance`, `compliance_quality`.
   `external_collaborator`, `volunteer` and `temporary_special` are **not** on it unless the reviewers add them. Reason: global search
   turns a member's whole reachable history, across every channel and patient they belong to, into one queryable surface; for
   categories whose access is intentionally narrow, short-lived or external, that cross-patient discovery is a larger step than
   reading one channel at a time. Those users keep `messaging.read` for the channels they belong to; they simply do not get the
   global search route.
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
- **The member picker and every membership write now refuse the three categories (design review F6).** `mention-non-member-service-db.ts`
  line 64 filters the "Add <name>?" **picker**, and `member-category-gate.ts` makes every `channel_member` write path (`addMember`,
  `ensureDmMember` for both DM participants, the care-team roster sync, and the creator rows of provider-opened, announcement and
  department channels) refuse an identity holding an active or disabled (not expired) role of `patient_family`, `external_auditor` or
  `platform_staff`: `addMember`/`openDm` answer 422 `MEMBER_CATEGORY_NOT_ALLOWED`, the roster sync skips such an identity. The deny set is
  `GLOBAL_SEARCH_ROLE_POLICY`'s, one source of truth. No channel kind legitimately holds these categories as a member (families message
  through portal accounts, which are not `channel_member` rows), so the refusal is unconditional. A static ratchet fails when a new
  membership-write path skips the gate. Rows already present before the gate shipped are not removed by it; the route allow-list,
  live test and ratchet above remain the controls for those.

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
| 13 | Any | Identity with role category `patient_family`, `external_auditor` or `platform_staff` | Zero (decided; see "Who may call the route") | the route refuses these categories before any search runs; the member **picker** excludes them (`mention-non-member-service-db.ts` line 64) and the add-member path now refuses them (`MEMBER_CATEGORY_NOT_ALLOWED`); the route allow-list remains the control for rows that pre-date the gate | `non-staff-identities-zero` |
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
| Database snapshot / backup thief without keys | tag histogram per tenant; which messages share tags; padded row counts per message | HMAC under per-tenant key **and, since 2026-10-13, per-channel keys** (the same word is an unrelated tag in every channel, so there is no tenant-wide histogram); truncation + dummies; no positions/order; per-tenant keys so no cross-tenant joining; ring destruction (P1) | Per-channel frequency histograms remain (a channel's rows are visible with its `channel_id`), and within a channel `rows per bucket = channel rows / 2^T` is small, so counts there are barely masked; frequency analysis inside a channel, co-occurrence graphs and classic searchable-encryption leakage-abuse attacks still apply. **The vocabulary attacks of the experiment were measured against a single global key only; their per-channel-key counterpart is NOT measured.** |
| Database operator who can observe live queries | access pattern: which messages match which (unknown) query | bound parameters, no statement/parameter logging, no result caching, per-route rate limit | Repeated or correlated queries let them cluster queries; with auxiliary data, recover query words |
| Application compromise (code execution with KEK) | everything: bodies and keys | none new - already game over for bodies | Index adds no capability beyond bodies |
| Authorised insider using the UI to probe | whether a word occurs in channels they may already read | results restricted to current access; per-user and per-org rate limit (P2); read audit | Probing within permitted scope reveals only permitted content |
| Patient names typed in messages (and the channel-linked name attack: snapshot + the plaintext `message.channel_id` / `channel.subject_id` link) | with names indexed, the patient's surname bucket is the top concentration-lift bucket of the patient's own channel for **about 93% of patients, at any `T`, with or without dummies or prefix sparsity** (experiment 2026-10-13); with the attacker already holding the name, he learns the bucket of a name he knows and can then find every other message mentioning that person | **Product-owner decision 2026-10-13: names are not indexed** (patient legal and alias names, caregiver names, emergency contact names), so there is no name tag to find; per-channel keys additionally remove the cross-channel baseline that the lift attack needs | Measured with the production exclusion path (experiment re-run, amendment below): global key, names excluded, linked recovery **0.0%** (baseline 0.9% to 1.3%); per-channel keys, names indexed, best simple attack (raw in-channel frequency) 3.3% top-1 / 8.1% top-3 against a 0.9% baseline, names excluded 0.0%. **Residuals:** a name is only as complete as M5's data (a nickname nobody recorded, a misspelling, a name typed with a digit, a staff name, a place name, a name spelled by the caller are still indexed); names that are also ordinary words (Grace, Hope, Will, Young) are unsearchable as words; a word that merely shares a 3/5/8/12-character prefix with a name still carries that prefix tag; new names are excluded within one maintenance tick (5 minutes) plus the writer cache (1 minute), and messages already indexed with a just-added name are rewritten after a further 2-minute delay (targeted, bounded), so a window of minutes exists |
| Name-roster enumeration through search (authorised insider probing) | whether a typed word is a patient/contact name of the tenant, if the response differed | the query path is **not** name-aware: a name is an ordinary term that matches nothing (no 422, no dropped term, same SQL, same empty 200, same timing floor as an unknown word) | none beyond the accepted threshold oracles; the honest "names are not searchable" statement is static product text (the tenant notice and the search-box contract), never a per-query signal |
| Prefix-hierarchy attack (database snapshot) | prefix tags form **nested message sets**: set(`mor`) is a superset of set(`morph`), which is a superset of set(`morphine`). With the dense chain every word has a cluster of 2 to 11 tags in the same messages (cluster size gives the exact length under 12; shared prefixes show where words diverge), for every word, not only head words. With the sparse set the chain is at most 5 tags (whole word plus lengths 3, 5, 8, 12): length is learned only to within a band (under 5, 5 to 7, 8 to 11, 12 or more) and fewer shared-prefix divergence points are visible | prefix tags at four lengths only, under one key; truncation to `T` bits and dummies blur only the tail, not the head | **Decided in the 2026-10-13 AI desk review (pending human sign-off; see [the review record](../reviews/ADR-0058-design-review-2026-10-13.md)): sparse prefix lengths {3, 5, 8, 12}**, replacing the earlier initial "keep every length 3 to min(len, 12)". Cost: a typed prefix of 4, 6, 7 or 9 to 11 characters is queried at the next-shorter tag (3, 5, 5, 8) and relies on the post-decrypt check, so it generates more false candidates. The chain is reduced, not removed: it remains a **residual leakage and a reviewer input**, and the leakage experiment must be run for both configurations. Still open as a further option: (b) no prefix tags for head words (identified by the head-bucket statistics), which removes the chain where it is strongest but makes a head word findable only whole |
| Cross-tenant | nothing | distinct keys per tenant; RLS; cross-tenant collision test | Compromised KEK defeats all tenants |
| Cross-channel linking (snapshot) | with a global key: that two channels contain the same word (equal tag), and a word's frequency across the tenant | per-channel keys: a tag in one channel says nothing about the same word in another | the plaintext `channel_id` beside each row, `message_id` joins and padded row counts remain; head-bucket pairs (`channel:tag`) are statistics stored in `message_search_index_state` (scrubbed from audit) |
| Name set at rest | nothing: the exclusion set is stored as 8-byte keyed digests (HMAC under `K_search`), never as names | keyed digests in `message_search_index_state.excluded_name_digests` / `exclusion_pending`, scrubbed from the audit images; destroyed with the tenant's rows and unusable without the ring | the digest count reveals roughly how many distinct name tokens the tenant has; a key-holder can test a candidate name against it (already game over) |

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
at the chosen `T` and the chosen tokenizer parameters (minimum token length, stop words, ID-like rule, caps), which also serves as the **production-enablement leakage test** (D10) and must pass before any tenant is enabled; (3) a record of the HIPAA risk-analysis entry for the new PHI-derived store **and covering the user's pre-join-history decision
(see "Pre-join history": consequences) and the prefix-hierarchy residual leakage**; (4) product-owner acceptance of the
residual risk. The review record is linked from this ADR (see Status); Status was changed to Accepted by the user before items (1) to (4) were satisfied, so they remain outstanding and gate production enablement.

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

- Two prerequisite WPs (P1 = WP 2.13, data migration of all message and revision ciphertext; P2 = WP 2.14, per-route rate limit) before any search code.
- A new PHI-derived table, a worker, a rebuild job, and key-version handling to run and test.
- Search quality is limited: no substring, no fuzzy, no stemming, no phrase; no dose search; eventual consistency; occasional
  short pages after access filtering (handled by the cursor and `scanCapped`, decision 9).
- Every body-handling change (edit, redact, delete, erase, retention) gains an index side effect in the same transaction, and a test.
- Common clinical words are the most leaked; they are also the least useful search terms.
- A tenant-level M36 setting turns global search on or off, with an ops-owned platform kill switch above it (see "Enablement and
  kill switches"); off by default until the leakage test passes and the go-live checklist is satisfied.
- One more precondition for P1: the `MESSAGING_ENCRYPTION_KEY` escrow and a passing restore drill before the backfill starts.

## Migration / rollout

1. **P1 (WP 2.13) and P2 (WP 2.14) first** (each its own WP and PR, with their own live suites). P1 starts only after the key escrow is in place and the
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
    their role was granted `messaging.read`; a workforce identity in an allow-listed category is allowed; an identity whose only
    role is `external_collaborator`, `volunteer` or `temporary_special` is refused for global search (and still reads its own
    channels); a user with both an allowed and an excluded active role
    is refused (`non-staff-identities-zero`). **Static ratchet** (unit): no role template, floor, external-auditor grant list or
    seed `role_permission` for those three categories ever contains `messaging.read`.
  - **Flag and kill switch:** default OFF returns the disabled error; only an org admin with fresh step-up can change the setting
    (no permission, no org-admin, stale step-up each refused); each change writes an audit row with actor, time, old and new;
    turning ON is refused (409) while a legacy-envelope row exists (the rebuild checkpoint is NOT a flip precondition, since the rebuild only runs for an ON tenant; the query path stays closed until the index is ready and reconciled after the last flip); turning OFF makes the
    next query fail, the purge deletes the tenant's token rows, and the query path still refuses when purge is held back (rows
    lingering); the platform flag off overrides tenant ON, and an absent or unreadable platform flag is OFF; an org-scoped write of
    the platform key is refused.
  - **Escrow:** the restore drill record exists before the P1 backfill starts; with legacy rows present and the key missing, boot
    fails closed (`check:boot:platform`); a post-backfill `hash_verify` is clean before the key is retired.
  - **Kill switch source:** insert a tenant-scoped `feature_flag` row for `messaging.global_search_platform_enabled` with the
    platform row off or absent; the query path and the indexer both still refuse (they read the org-NULL row directly, not
    `forOrg`). OFF-then-ON: queries stay refused until outbox replay and reconciliation report zero drift; a message deleted or
    redacted while OFF is absent from the index after turning ON.
  - **Add-member path:** a live test attempts `addMember` for an identity holding each of the three excluded categories and asserts the
    422 `MEMBER_CATEGORY_NOT_ALLOWED` refusal (and that an allowed workforce identity is accepted); the route allow-list test (row 13)
    must pass regardless.
  - **Escrow independence:** the custodian record shows three distinct natural persons and a dual-control vault procedure; a
    re-drill is on record after each custodian change and yearly; the same drill exists for `M34_TENANT_KEK`.
  - **Tail bound:** `P(candidates > CANDIDATE_CAP)` is measured on a production-shaped corpus for single-term and two-term queries;
    a single-term query in a head bucket returns the refine-your-query response without decrypting; no query decrypts more than
    `MAX_PAGES_PER_QUERY x DECRYPT_BUDGET` bodies.
  - **Tokenizer additions:** `esophagogastroduodenoscopy` is indexed; a 20+ character hex string with a digit, a mixed-case
    base64-like string and a UUID are not; a 41-letter word is dropped.
  - **Parameters:** the leakage experiment is run at the chosen `T = 19` and tokenizer parameters; a unit test recomputes the
    "Parameter values and the T arithmetic" table from its stated assumptions so the document and the constants cannot drift; the
    measured false-candidate rate on a synthetic tenant is within the 500 cap for a typical single-word query.
  - **Added 2026-10-13 (product-owner decisions):** unit: `deriveChannelKey` is deterministic and bound to channel, `T` and version; the same
    word has unrelated tags in two channels; an excluded token yields no whole-word or prefix tag; the name digest is keyed and disjoint
    from the tag inputs; the query is not name-aware (a name parses like any word) and an excluded body token never satisfies a query;
    `tagBitsForTotalRows` recomputes the "Parameter values and the T arithmetic" table and the 2-bit rebuild rule. Live (writer suite): the
    same text in two channels stores unrelated tags with the right `channel_id`; a name is never tagged and the state holds digests, not names;
    no name source fails closed with no row written; a new name is added grow-only and only the carrying messages are rewritten, after the
    delay; a new index is 12 bits, a stored width 2+ bits off is rebuilt and 1 bit off is not; `ready` removes the other versions' rows and
    state. Live (query suite): per-channel prefilter, cap and head-pair behaviour, name exclusion end to end, and a name query equals an
    unknown-word query.
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
- **Archived channels** in global search (Proposed default in "Access control"). (Patient-name exclusion is no longer open: decided
  2026-10-13 by the product owner; see the amendment.)
- **Role-category allow-list:** whether `external_collaborator`, `volunteer` and `temporary_special` are added to it (they are off it
  by default), how `patient_family` identities receive roles (not determinable from this repo; the live test and the ratchet cover
  it), (`addMember` now refuses the three excluded categories).
- **Per-channel keys and the T rule (new 2026-10-13):** whether `T = clamp(round(log2(totalRows / 150)), 12, 20)` (decided) is the right rule
  once a bucket is channel-local (the in-channel rows per bucket are small, so a smaller or per-channel `T` would mask more at little query
  cost); the measured vocabulary-attack numbers for per-channel keys (not run); `MAX_QUERY_CHANNELS = 300`.
- **Heavy-tail handling and prefix hierarchy:** whether the initial head-bucket refusal is enough or a per-tenant frequency
  stop-word list is wanted; prefix lengths are decided as `3, 5, 8, 12` (2026-10-13 AI desk review, pending human sign-off); whether head words additionally lose their prefix tags remains open.
- **Privacy-officer input:** the consequences of the pre-join-history decision ("Pre-join history") are covered by the risk-analysis
  record; the decision itself is not open.
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

## Amendment 2026-10-13: the scan-truncation signal is a coarse threshold oracle (accepted)

Corrected 2026-10-13 against the code (`apps/backend/src/modules/36-messaging/global-search/query-service.ts`, header comment and the
`REFINE` / `scanCapped` derivation) per review findings F3 and F4 of [the design review record](../reviews/ADR-0058-design-review-2026-10-13.md).
The earlier text of this amendment described a single-round "more than 500 raw candidates" bit; that is not what the code does.

**What the code does.** The service scans up to `MAX_PAGES_PER_QUERY = 5` rounds of up to `CANDIDATE_CAP = 500` raw candidates and up to
100 channels, continuing **internally** past the caps (it never emits an internal position). Every response field (`results`,
`nextCursor`, `scanned`, `scanCapped`, `refine`) is derived from **visible** rows only: the cursor names the last visible row examined,
never a hidden candidate. `scanCapped` / `refine` is set when a limit (the 5 rounds, or the 100 channels) ends the scan with candidates
still remaining and nothing further visible. So the bit means **"more than about 5 x 500 hidden candidates, or hidden candidates spread
over more than 100 channels"**, not "more than 500 raw candidates". Because the candidates are counted before the authority filter, a
caller with no access to any matching channel can still cause it, so it remains a term-frequency **threshold** (coarser than the
earlier text implied: the threshold is about 2,500 candidates or 100 channels, and 0 and the threshold minus one are indistinguishable),
never a count, channel, row or cursor. It is rate-limited (30/min/user, 300/min/org) and fails closed. It is the same class of leak as
the head-bucket refusal that D3 option B already accepts, and it is preferred over a response that looks complete when it is not. The
alternative (set it only when the page is non-empty) is available to the privacy officer's review. Found by the fresh review of a9a1ef5e5.

**Second membership-independent threshold oracle: the head-bucket REFINE.** *(Re-stated 2026-10-13 for per-channel keys, see the amendment
at the end: the refusal is now per channel, depends on the caller's coarse membership, and a partial skip is flagged `scanCapped`; the text
in this paragraph describes the original single-key behaviour.)* `isHeadBucketQuery` returns `REFINE` **before any authority
work** (query-service.ts, immediately after the active-user check): a single-term query whose tag falls in a recorded head bucket
(`HEAD_BUCKET_ROWS = 5,000` or more rows in that bucket) is refused with `scanCapped: true, refine: true`. It depends only on the term's
bucket frequency in the whole tenant, not on the caller's access, so any messaging user can learn that a typed word (or a word sharing
its bucket) crosses the head-bucket frequency threshold. It is a frequency-threshold oracle of the same class as `scanCapped`, with a
different threshold (a bucket of 5,000 rows) and without even the scan's work. The earlier text of this amendment did not list it. It is
accepted on the same grounds (D3 option B accepts that term frequency leaks), rate-limited and fail-closed, and it is an input to the
leakage experiment and to the HIPAA risk-analysis entry.

**Residual finer oracle: timing.** A scan can run up to five hidden rounds (each a candidate query plus authority evaluation) before it
gives up, so response time varies with the amount of hidden candidate volume below the thresholds above. This is a finer-grained
signal than the `scanCapped` bit, **not removed** by the field derivation, and only bounded by the 30/min/user and 300/min/org
limits, the 3 s decrypt timeout and the 5 s statement timeout, with the limiter failing closed. It is recorded as a residual risk; no
constant-time padding of the scan is implemented.

## Amendment 2026-10-13: timing floor, tenant notice acknowledgement and the computed member check (built; Accepted by decision, review requirement NOT satisfied)

Three blockers from the security review are built on `feat/m36-phase2-closeout`. The Status is unchanged: **Accepted** by the user's decision,
with the "Design review requirement" **not satisfied** (human adoption, the measured leakage experiment, the HIPAA risk-analysis entry and the
product owner's residual-risk acceptance are still pending). No tenant may be enabled in production until it is.

- **F1 - rare-term existence timing oracle: response-time floor.** The candidate scan counts hidden candidates before the authority filter, so
  "no message contains X" returned faster than "a channel I cannot read contains X". `GET /api/v1/messaging/search` now holds EVERY outcome after
  the gates (hits, empty, refine, errors) to a minimum of `SEARCH_RESPONSE_FLOOR_MS` (1500) plus a per-request random jitter below
  `SEARCH_RESPONSE_JITTER_MS` (500) (`global-search/timing-floor.ts`). The floor never shortens a slower request. Both are named constants; the
  env vars `WARDENX_GLOBAL_SEARCH_FLOOR_MS` / `WARDENX_GLOBAL_SEARCH_JITTER_MS` override them for tests only and are ignored when
  `NODE_ENV=production`. **Residual:** a request that needs more than one round, or whose authority calls exceed the floor, still takes longer, so
  hidden volume beyond the one-round bound remains timing-visible (it is the same population as the `scanCapped` threshold oracle above, and is
  bounded by the 30/min/user rate limit). The floor value was sized against the documented one-round cost, NOT yet against a measurement on a
  production-shaped corpus: the leakage experiment must re-validate it.
- **F5 - tenant notice and acknowledgement (review condition 12).** `PUT /api/v1/messaging/global-search/settings` with `enabled: true` now
  requires `acknowledgedNoticeVersion` equal to the server constant `NOTICE_VERSION` (`global-search/notice.ts`, the only place the notice text
  lives). Missing or stale is `409 GLOBAL_SEARCH_NOTICE_NOT_ACKNOWLEDGED` (detail codes `NOTICE_ACK_REQUIRED` / `NOTICE_ACK_STALE`), checked before
  the checklist. The acknowledging user, time and version are stored on `tenant_messaging_search_setting` (migration 1095: `notice_ack_version`,
  `notice_ack_by_user_id`, `notice_ack_at`, all-or-none CHECK) and audited by the table's existing write-audit trigger. OFF needs no acknowledgement and
  leaves the last one on record. `GET` returns `notice {version, text}` and `noticeAcknowledgement`. Changing the text requires bumping the version.
  This builds the screen-side half of condition 12; the written notice to the tenant, BAA/DPA/subprocessor review and data-map entries remain human work.
- **F6 - excluded-category members are a checklist item.** Runbook Stage 6b's SQL is now computed: the sixth checklist item `excludedMembersCleared`
  (failure code `EXCLUDED_MEMBERS_PRESENT`, 409 with the other failing checks) is false while any live `channel_member` (not removed, membership not
  revoked, grant unexpired, disabled role still counting) belongs to an identity holding a role outside the search role gate's allow/off categories.
  It uses the same category set as `member-category-gate.ts` (derived from `GLOBAL_SEARCH_ROLE_POLICY`). The second known gap (a member with no
  membership in the org) is still invisible to it and remains a tracked follow-up.

## Amendment 2026-10-13: name exclusion and per-channel keys (product-owner decision; built; review requirement NOT satisfied)

Status is unchanged: **Accepted** by the user's decision, with the "Design review requirement" **not satisfied**. The product owner decided
two changes after the [leakage experiment](../reviews/ADR-0058-leakage-experiment-2026-10-13.md) showed the channel-linked name attack
succeeding for about 93% of patients regardless of `T`, dummies or prefix sparsity. Both are built on `feat/m36-phase2-closeout`
(migration 1096). **Nothing here is validated by a human review or by a production-shaped measurement.**

### 1. Names are excluded from the index

**What is excluded.** Tokens (output of the production tokenizer, so lower-cased, diacritic-folded, 3 to 40 letters) of: the patient's legal
first, middle and last name; every `patient_name_alias` (preferred, maiden, aka; first, middle, last, full); the first and last name of every
caregiver linked through `patient_caregiver`; every `emergency_contact` name. Merged-away duplicate patients are included. Both the
whole-word tag and every prefix tag of such a token are omitted (`tokenizeForSearch(text, excluded)` drops it before tagging, exactly like a
stop word, so `n` of the padding rule counts only the remaining tags). Staff names, place names and a name nobody recorded are NOT covered.

**Where the names come from.** M5 owns the tables, M36 does not depend on module 5. `patientNameFragmentsPageForOrg(db, org, afterPatientId,
limit)` lives in `apps/backend/src/modules/05-patient/seams/` (the established pattern of `patientIdsPageForOrg`: an org-explicit keyset page, run
under `withOrgContext`, exported from the M5 index and injected into M36 as a locally declared port, `PatientNameSource`, at the composition
root in `apps/backend/src/index.ts`). It returns free-text name fragments only (no patient id). `arch:fitness` boundaries are unchanged.

**How the set is keyed and where it lives.** M36 tokenises each fragment, replaces each token by a **keyed digest**
`nameTokenDigest = first 8 bytes of HMAC-SHA256(K_search, "n\0" || token)` (the input prefix `n\0` is disjoint from the tag inputs `w\0` and
`p\0`) and discards the text in the same call. The durable set is `message_search_index_state.excluded_name_digests text[]` (and the pending
list below); the in-process set is a `Set` of digests with `has(token)` recomputing the HMAC. **No plaintext name is stored, cached or logged by
M36**; both columns are scrubbed from the state table's audit images; the digests die with the tenant's rows and are unusable without the key
ring. Names exist in memory only for the duration of one `sync` page loop.

**When it changes (new or renamed patient).** The maintenance tick (every 5 minutes, per enabled tenant) calls `sync`: it re-reads the names,
and every digest not yet in `excluded_name_digests` is **added to it** (grow-only) and to `exclusion_pending`. From then on every writer
excludes the token (writers cache the digest set for 60 seconds). The messages that were already indexed with the new name are found by a
**targeted reindex, not a rebuild**: once a pending digest is older than twice the cache TTL (so no replica can still index it behind the
pass), `reindexPendingExclusions` computes the name's whole-word tag in every channel that has rows, looks up the messages holding those
`(channel, tag)` pairs (bounded: 5,000 pairs per statement, 30 seconds per tick per tenant, resumable), rewrites only those messages through
the normal writer, and clears the digest from `exclusion_pending`. A crash leaves the digest pending and the next tick repeats it. A renamed or
deleted patient leaves the old name excluded (safe direction; shrinking the set means a full rebuild, an operator action). The first read for a
tenant that has never been synced runs `sync` inline; **if there is no name source configured the writer and the query path fail closed**
(`NameExclusionNotConfiguredError`, 503 on a query), so a boot that forgot to wire M5 cannot index names.

**Query side (no oracle).** The query is deliberately NOT name-aware. A name typed into the search box is an ordinary term: tokenised,
tagged per channel, looked up, and it matches nothing, because no row holds it and `bodyMatchesQueryTerms` ignores an excluded token of the
body. It takes the same SQL, the same cost, the same empty 200 and the same timing floor as any unknown word. A 422 ("not searchable") or a
silently dropped term would let any workforce user enumerate which words are patient names of the tenant (a roster oracle on patients outside
their caseload), so the earlier idea of a dedicated "term not searchable" response was rejected. The honest statement that names are not
searchable is therefore static product text (the tenant notice and the search-box contract), never a per-query signal. A typed prefix that is
only a prefix of a name (`lindq`) proceeds as an ordinary prefix query and cannot match the name (the verification ignores excluded body
tokens). A multi-word query containing a name returns nothing (an AND with an unmatchable term). **In-conversation search (WP 2.7a) is
unaffected**: it decrypts and filters inside one authorised channel and has no index.

**Cost to users.** A message cannot be found by a patient's or contact's name; names that are also ordinary words (Grace, Hope, Will, Young,
Rose) are unsearchable as words for the whole tenant; a name recorded after the fact is excluded within about 5 minutes.

### 2. Per-channel keys

**Derivation.** `K_ch = HKDF-SHA256(ikm = K_search, salt = "", info = "wardenx-message-search-channel:" || version || ":t" || T || ":" ||
channel_id)`. `T` and the ring version label are bound into the info (security review L3). The token row gains `channel_id` (migration 1096;
index `(organization_id, key_version, channel_id, tag, message_id)`; not a foreign key, the composite message FK already pins the message). The
indexer derives the key from the message's `channel_id`; the tag input strings (`w\0token`, `p\0len\0prefix`) and the sparse prefix lengths
are unchanged.

**Query.** `selectQueryChannels` returns the caller's active membership channels plus announcement channels, most recently active first
(`max(message.created_at)` per channel), at most `MAX_QUERY_CHANNELS = 300` (+1 to detect the cap). The service derives one tag per term per
channel (the last term is the prefix tag as before) and the prefilter joins `(key_version, channel_id, tag)`; `k` of the AND-intersection is
per channel. `effectivelyVisibleChannels`, the re-select and the body verification are unchanged. **Above the cap** the 300 most recently active
channels are searched and the response carries `scanCapped: true`, never silent; it reveals only that the caller has more than 300 coarse
channels (their own membership) and is the same bounded-oracle class as `scanCapped` below. **Hidden-channel note:** the channel list is coarse
(membership or announcement) and includes channels the authority later hides (Part 2); they use up cap slots and can set the flag, which reveals
at most that a bound was reached.

**Head buckets are channel-scoped.** `refreshIndexStats` records `'<channel uuid>:<tag>'` pairs with more than 5,000 rows (at most 2,000, the
largest first). For each searched channel, if every term's tag is a head pair of that channel the channel is skipped; if any channel was skipped
the response is flagged `scanCapped: true`; if every searched channel was skipped it is the original `REFINE` (no candidate SQL, no decrypt).
**Oracle re-check:** the original head-bucket refusal depended only on the term's frequency in the whole tenant (membership-independent). The
channel-scoped one depends on the caller's coarse membership: a user can learn that a word is very frequent (over 5,000 rows, i.e. roughly 5,000
messages) in a channel they are a member of, including one the authority would hide from them (Part 2 consent lapsed). It reveals no channel,
count or row, needs a channel of thousands of messages, is rate limited (30/min/user) and fails closed. It is accepted on the same grounds as
the two threshold oracles above; it is a narrower population (a member's own channels) than the original tenant-wide signal. The timing
oracle statement (F1 floor) is unchanged.

**Rebuild and backfill.** Migration 1096 **truncates the token table and resets every state row to `stale`** (no rows can be matched under the
old scheme; search is inert everywhere, so a clean rebuild is acceptable and is documented in the runbook). The next maintenance tick of an
enabled tenant restarts the sweep from the beginning, re-reads the names first, and `ready` is only reached after zero drift. An environment
with search ON and a populated index loses search (503 `GLOBAL_SEARCH_INDEX_NOT_READY`) until the rebuild completes.

### 3. Security-review items built with this change

- **H2 (T sizing):** `T = clamp(round(log2(totalRows / 150)), 12, 20)` from stored rows; computed at state creation from live messages x 16 and
  re-measured after each verified build; a 2-bit difference rebuilds (decision 4 and "Sizing across tenants"). The unit suite recomputes the
  table and the rule. With the unit tenant of the experiment (1.42 x 10^6 stored rows) the rule gives 13.
- **M1 (old-version rows):** when a version is marked `ready`, the same transaction deletes the token rows and state rows of every other key
  version of the organisation (live test).
- **L3:** `T` and the version label are bound into the channel-key info.
- **Not built:** M3 and "Part 2" (they need counsel), and any change to the rate limits or the timing floor.

### 4. Measured (leakage experiment re-run, synthetic corpus, weak evidence)

See [the experiment record](../reviews/ADR-0058-leakage-experiment-2026-10-13.md), section 7. Headline: with the production exclusion path the
channel-linked name recovery is **0.0%** (global key; baseline 0.9% to 1.3%) against **93.0% / 93.4%** with names indexed (`T` = 13 / 19);
under per-channel keys the cross-channel lift attack does not exist and the best simple in-channel attack (raw message frequency) identifies the
surname bucket as top-1 for 3.3% / 2.6% of patients with names indexed (baseline 0.9% / 1.2%; top-3 8.1% / 7.0%) and 0.0% with names excluded.
**Not measured:** every vocabulary attack against per-channel keys, anything on a production-shaped corpus, C4.
