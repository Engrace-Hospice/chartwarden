# ADR-0058 — Global message search is a per-tenant HMAC blind-token index (whole-word and prefix only), re-checked against current access at query time

- **Status:** **Proposed** — **a design review is a hard precondition to acceptance**; the product owner chose option B (D3) knowing
  it leaks token frequency. The review is by the **security architect and the privacy officer** and gates **both building WP 2.7b
  and enabling it in production** (D10, decided 2026-10-11 by the product owner). Do not implement WP 2.7b, and do not mark this
  Accepted, until the review in "Design review requirement" has passed and its record is linked here. In-conversation search (WP 2.7a, option A) does not depend on this ADR.
- **Date:** 2026-10-11
- **Phase:** Messaging Hub Phase 2 (WP 2.7b). Needed before Phase 2 work on global search starts.
- **Extends:** [ADR-0038](ADR-0038-app-layer-envelope-encryption.md) (app-layer envelope encryption) and
  [ADR-0045](ADR-0045-platform-kek-custody.md) (KEK custody) for key derivation; plan `02` §6.
- **Related:** ADR-0055 (draft: redaction and revisions - what is indexed and when it is removed),
  [ADR-0010](ADR-0010-tenancy-rls-invariants.md), [ADR-0011](ADR-0011-ownership-inversion-rls-bypass.md),
  [ADR-0051](ADR-0051-legal-hold-is-an-overlay-not-a-retention-class-flip.md) (derived data is not the record).

> **Number check.** Intended ordinal ADR-0058; re-check at promotion (last on `main` at drafting: ADR-0053).

## Context

- Message bodies are envelope-encrypted per tenant: `message.body_cipher` (`packages/db/src/schema/messaging/messages.ts`), AES-256-GCM,
  tenant DEK HKDF-derived from a master KEK and the org id (`packages/messaging/src/crypto/body-crypto.ts`,
  `DEK_INFO_PREFIX = "wardenx-message-dek:"`). A normal database index would hold plaintext or be useless.
- A second key model exists: the `TenantKeyProvider` seam (`packages/saas-tenant-platform/src/seams/tenant-key-provider.ts`) returns a
  versioned `TenantDek` and a destroyed ring is the cryptographic shred. **Which model protects message bodies in production was not
  confirmed in Phase 0** (the messaging code derives its own DEK from `MESSAGING_ENCRYPTION_KEY`). Key derivation below must follow
  whichever the review confirms.
- Plan `02` §6 compares A (decrypt-and-filter over an authorised candidate set), B (per-tenant encrypted blind-token index),
  C (plaintext `tsvector` under RLS). D3 (2026-10-11): global search is required; option B; A ships first for in-conversation search.
- The plan already fixes the shape: HMAC key per tenant derived from the DEK hierarchy and rotated with it; word plus prefix
  tokens, no raw trigram of short strings; padding/bucketing; no server-side phrase or proximity ranking; entries deleted on
  redaction and tenant erasure; resumable rebuild from ciphertext; candidates re-filtered by current access; read audit per result
  page; known limit whole-word and prefix only. This ADR turns that into a decision and states the leakage honestly.
- Tenant erasure is crypto-erase of the DEK (`packages/messaging/src/destruction`,
  `apps/backend/src/modules/36-messaging/erasers/messaging-eraser.ts`); the index must be erased with it or it survives the shred.
- Read-audit lesson (repo CLAUDE.md): a read config without `resourceIdParam` leaves no trail; search results need a live assertion.

## Decision

1. **Scope.** The index covers the **head body of each non-deleted, non-redacted message** only (not revisions, not drafts, not
   attachments). Indexing runs in a worker driven by `m36.message.sent.v1` / `m36.message.revised.v1` outbox events and is therefore
   eventually consistent; the UI states that new messages may take seconds to appear. The index is derived data, never the record.
2. **Keys.** `K_search(org, v) = HKDF-SHA256(root, salt = "", info = "wardenx-message-search:" || orgId || ":v" || v)` with `root` the
   same root the review confirms for message bodies (tenant DEK/KEK per above), and a label distinct from the encryption label so the
   two keys are domain-separated. `v` is stored on every index row. Rotation: new version, rebuild under it, query both during the
   overlap, then delete the old version's rows. Destroying the tenant key makes the index unusable by construction; the eraser also
   deletes the rows.
3. **Tokenisation (server-side, deterministic).** Unicode NFKC, lowercase, split on non-alphanumerics; also split at letter/digit
   boundaries (so "5mg" gives "5" and "mg"; confirm with clinical input); drop tokens shorter than 2 and a small stop-word list;
   drop tokens longer than 64. **Numeric and ID-like tokens are not indexed** (digit-only tokens, and identifier-shaped tokens such
   as MRN-like or long digit/letter strings; free-text identifiers are never indexed), so "5mg" yields only "mg". **Patient names
   are indexable only behind a per-tenant flag** (default off). **English only at launch**, behind a **pluggable tokeniser**
   interface so other languages and diacritic policies can be added later without changing the index shape (D10, decided
   2026-10-11 by the product owner). The exact definition of "ID-like" is for the reviewer to fix. Each distinct token yields:
   - a **whole-word tag** `HMAC(K, "w\0" || token)`;
   - **prefix tags** `HMAC(K, "p\0" || len || "\0" || prefix)` for prefix lengths 3 to min(len, 12). No prefix shorter than 3, no
     infix/suffix grams, no trigram of short strings, no character positions or word order stored.
4. **Truncation and padding (leakage control, not a security proof).** Each tag is truncated to `T` bits (initial `T = 32`; tuned so a
   typical tenant has many distinct words per tag value). Collisions are intentional: they become false positives that step 7
   removes after decryption. Each message's tag set is padded with random dummy tags to the next size bucket (powers of two) so the
   number of rows per message does not reveal the word count. Rows carry only `(organization_id, key_version, tag, message_id)`.
   Row order is not meaningful and `channel_id` is not duplicated into the index (it is available via `message_id`).
5. **Table.** `message_search_token` (working name), three-column rule (org column, RLS on `app.org_id`, FORCE, PHI write-audit
   trigger), index on `(organization_id, key_version, tag)`, FK on `message_id` index-covered. It is classified as PHI-derived for
   backup, erasure and DR purposes. `wardenx_app` may INSERT and DELETE (delete on edit/redaction/delete); no UPDATE.
6. **Deletion.** On edit: delete the old tags and insert the new (same transaction as the revision, or an idempotent event).
   On redaction (ADR-0055): delete the message's tags immediately so masked content is not discoverable. On delete/tombstone: delete.
   On tenant erasure and key destruction: delete all. A legal hold does **not** keep index rows (the index is not the record).
   Retention destruction of a message deletes its rows.
7. **Query path** (all steps server-side, in one request):
   1. Authenticate; derive tenant from the session; rate-limit per user.
   2. Tokenise the query the same way; build tags (whole-word for complete words, prefix tags for a trailing partial word of >= 3
      characters); reject queries with no indexable token with a message explaining the limit.
   3. Select candidate `message_id`s by tag, **restricted in SQL to channels the user is currently a member of or otherwise
      authorised for** (the same visibility rule as `channel_visibility` ABAC), capped (initial 500) with recency order.
   4. **Re-check access per candidate with the authoritative path** (current membership, patient access ABAC, channel not
      archived/blocked), because index time and query time differ.
   5. Decrypt only the survivors; verify the actual token/prefix match against the plaintext (drops truncation collisions and
      dummies); produce the page. Ranking is by recency; phrase/proximity ranking, if any, happens client-side after decrypt.
   6. Write one read-audit event per result page with `resourceIdParam` set, result ids and count, and **no query text** (store
      neither the query nor its tags in audit or logs).
8. **Operational leakage hygiene.** Tags are always bound parameters; database statement logging, `pg_stat_statements` parameter
   capture, `auto_explain` and slow-query logs must not record them (verify configuration in the Docker stack and in the CNPG
   platform, ADR-0050). No tag or token in application logs, traces or error reports. Search responses are not cached.
9. **Rebuild.** `messaging.search_rebuild` job: resumable cursor over messages ordered by `(created_at, id)`, checkpoint row per
   `(org, key_version)`, per-message idempotent replace (delete tags for the message, insert), tenant-scoped via `withOrgContext`, runs
   at low priority, reports progress. "Reproduces identical results" is an acceptance test (modulo dummies).
10. **UI contract.** The search box says it matches whole words and word beginnings of at least 3 characters, not arbitrary substrings.
11. **Fail-closed.** If key derivation fails or the key version is unknown, search returns an error; it never falls back to a
    plaintext scan of other tenants or to option C.

### Leakage analysis (to be completed by the design reviewer)

| Adversary | Learns | Mitigation here | Residual |
|---|---|---|---|
| Database snapshot / backup thief without keys | tag histogram per tenant; which messages share tags; padded row counts per message | HMAC under per-tenant key; truncation + dummies; no positions/order; per-tenant keys so no cross-tenant joining | Frequency analysis against known hospice vocabulary can plausibly recover very common words; co-occurrence graphs; classic searchable-encryption leakage-abuse attacks apply |
| Database operator who can observe live queries | access pattern: which messages match which (unknown) query | bound parameters, no statement/parameter logging, no result caching | Repeated or correlated queries let them cluster queries; with auxiliary data, recover query words |
| Application compromise (code execution with KEK) | everything: bodies and keys | none new - already game over for bodies | Index adds no capability beyond bodies |
| Authorised insider using the UI to probe | whether a word occurs in channels they may already read | results restricted to current access; rate limit; read audit | Probing within permitted scope reveals only permitted content |
| Cross-tenant | nothing | distinct keys per tenant; RLS; cross-tenant collision test | Compromised KEK defeats all tenants |

The honest summary: option B trades a reduced blast radius for a database-only compromise (no plaintext copy exists, unlike C) against
known frequency/access-pattern leakage that option A does not have. A qualified reviewer must decide whether that is acceptable for
hospice PHI and whether `T`, bucket sizes and the stop-word list are adequate.

### Design review requirement

Reviewers (D10, decided 2026-10-11 by the product owner): the **security architect and the privacy officer**. The review gates
**building** WP 2.7b (pre-build design review) and **enabling** it in production (a **leakage test** must pass first). Before
acceptance: (1) a written review by the security architect, with searchable-encryption experience, and the privacy officer covering the table above, the
truncation width `T`, padding scheme, prefix lengths, key derivation and rotation, and the logging-hygiene controls; (2) a
measured experiment on synthetic hospice notes estimating how many top-N words an auxiliary-vocabulary frequency attack recovers
at the chosen `T`, which also serves as the **production-enablement leakage test** (D10) and must pass before any tenant is enabled; (3) a record of the HIPAA risk-analysis entry for the new PHI-derived store; (4) product-owner acceptance of the
residual risk. The review record is linked from this ADR before Status changes.

## Alternatives considered

- **A. Decrypt-and-filter over an authorised candidate set.** No index, always-current ACL, no frequency leakage. Rejected for global
  search (cost grows with history); adopted for in-conversation search (WP 2.7a) and as the fallback if the review rejects B.
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
- **No global search.** Cheapest and safest; rejected by decision D3 (required).

## Consequences

- A new PHI-derived table, a worker, a rebuild job, and key-version handling to run and test.
- Search quality is limited: no substring, no fuzzy, no stemming, no phrase; eventual consistency; occasional empty-looking pages
  after access filtering (the candidate cap means access-filtered results can under-fill - define "load more").
- Every body-handling change (edit, redact, delete, erase, retention) gains an index side effect that must be tested.
- Common clinical words are the most leaked; they are also the least useful search terms.

## Migration / rollout

1. After acceptance: migration for the table (check `arch:migration-numbering` against `main`; manifest `ownedTables` in `.ts` and
   `.cjs`; mirror in `packages/db`), key-derivation helper beside `body-crypto.ts`, tokenizer package-level pure function with tests.
2. Backfill by the rebuild job per tenant (feature-flagged per tenant); enable query path only when the checkpoint is complete.
3. Wire deletion hooks (edit, redact, delete, eraser) in the same release as the indexer, never later.
4. Add the eraser extension and DR/backup documentation for the new store.

## Verification

- Unit: tokenizer determinism and golden cases (clinical strings, unicode, digits); tag derivation differs per tenant and per
  key version; no tag for tokens under the minimum length; padding bucket sizes.
- Live (real `wardenx_app` role): user who lost channel access gets zero results from the index (membership removed after
  indexing); cross-tenant token collision test (same word, two tenants, tags differ and results never cross); redacted/deleted
  message is not returned and its rows are gone; tenant erasure leaves zero index rows; rebuild after truncating the table
  reproduces identical results; read-audit event lands with `resourceIdParam`; query text absent from audit and logs (assert on log
  capture).
- Performance: p95 < 1 s on a representative history (target in plan 2.7b).
- Gates: `arch:tenancy`, `check-fitness-gaps`, `arch:manifest-mirror`, `arch:queue-names` (rebuild/indexer queues), `arch:live-suites`,
  `test:fk-indexes:live`.

## Open questions

- Which key model protects message bodies in production (HKDF-from-`MESSAGING_ENCRYPTION_KEY` vs the versioned `TenantKeyProvider`)?
  This decides the derivation root and rotation story.
- Truncation width `T`, padding buckets, stop-word list, minimum prefix length (3?) and maximum token length: reviewer to fix.
- Remaining reviewer-fixed details: what counts as "ID-like", and diacritic handling for the future tokeniser.
- Should hold-bearing tenants be able to disable global search entirely (per-tenant flag, default off)?

Resolved (Decided 2026-10-11 by the product owner, D10): reviewers are the security architect and privacy officer; the review gates
both build and production enablement, with a leakage test before enablement; numeric/ID-like tokens and free-text identifiers are
not indexed; patient names are indexable behind a tenant flag; English only at launch with a pluggable tokeniser.
