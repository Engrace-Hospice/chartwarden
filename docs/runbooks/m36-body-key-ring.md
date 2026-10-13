# Runbook: M36 message bodies on the M34 wrapped-DEK ring (WP 2.13 / ADR-0058 P1)

Today every `message.body_cipher`, `message_revision.body_cipher`, draft and scheduled body is sealed under a key that is a pure
function of `MESSAGING_ENCRYPTION_KEY` and the org id (HKDF). That key cannot be rotated and destroying a tenant "key"
destroys nothing. WP 2.13 moves bodies onto the tenant's random, wrapped, destroyable DEK in `tenant_key_ring` (M34). This
runbook is the operator side. The design and its guarantees are in ADR-0058 section P1 and in the headers of
`apps/backend/src/modules/36-messaging/jobs/body-backfill.ts` and `body-key-ring.ts`.

**Stage order is the safety property. Do not reorder, and do not skip the checks between stages.**

## What is in the code

| Piece | Where | Default |
|---|---|---|
| Envelope v2 (`2 ‖ verLen ‖ ringVersion ‖ nonce ‖ ct ‖ tag`, AAD binds org + version) | `packages/messaging/src/crypto/body-crypto.ts` | n/a |
| Reads open either scheme (first byte picks the key) | `MessageBodyCipher.open` | always on |
| New writes seal on the ring | `M36_BODY_SEAL_SCHEME=ring` | **`legacy`** (off) |
| Per-row scheme marker | generated column `body_envelope_version` (0 erased, 1 legacy, 2 ring), migration 1089 | n/a |
| Ring DEK cache | `body-key-ring.ts`, TTL 60 s, `invalidateMessageBodyKeys(orgId)` | n/a |
| Backfill | `bun run m36:body-backfill -- --org <uuid>` (`scripts/m36-body-backfill.ts`) | refused in production without the drill flag |
| Boot check | boot log line `M36 message bodies: <state>`; production fails closed on legacy rows + unusable key | on |
| Standing signal | `m36.hash_verify.run` audit context carries `legacyBodies` per tenant, nightly | on |

## Stage 1: ship the reader (this release)

Deploy with `M36_BODY_SEAL_SCHEME` unset. Behaviour is unchanged for writes; reads can already open ring envelopes. Migration
1089 rewrites `message` and `message_revision` once (generated column), which takes an ACCESS EXCLUSIVE lock: fine while the
tables are small (demo data), check row counts first otherwise. After deploy, re-run `bun run db:provision-roles` so the platform
login gets the column grant on `body_envelope_version`; until then the boot count logs "unavailable" and continues.

Verify: boot log shows `M36 message bodies: legacy_rows_key_present (...)` or `ring_only`; `check:boot:platform` is green.

**Do not roll the application back to a build older than this one once any ring row exists**: the older build cannot open them.

## Stage 2: new writes on the ring

Preconditions: stage 1 has soaked (at least one nightly `hash_verify` clean); every tenant that writes has a provisioned,
not-destroyed key ring (`m34` provisioning); the platform KEK (`M34_TENANT_KEK`) and `DATABASE_PLATFORM_URL` are set (the ring is read
through the platform login).

Set `M36_BODY_SEAL_SCHEME=ring` and restart. Rollback is setting it back to `legacy` (ring rows already written stay
readable; the reader stays deployed).

## Stage 3: backfill (ONE TENANT AT A TIME)

**Precondition, ADR-0058 P1: the escrow restore drill has passed and is on record.** Checklist (all must be true, each recorded):

1. `MESSAGING_ENCRYPTION_KEY` is escrowed Shamir 2-of-3 across three distinct natural persons (security officer, CTO, break-glass
   vault under dual control by someone else), in a different failure domain from the SOPS age-key envelopes.
2. `M34_TENANT_KEK` (and its retired entries) is escrowed the same way; `tenant_key_ring` is in the backup set.
3. Drill: reconstruct each key from two shares in a clean environment, decrypt a sampled production-shaped body **and** revision
   from a copy, confirm `sha256(plaintext) == body_sha256`; unwrap a sampled tenant DEK from a restored `tenant_key_ring` row
   and decrypt a sampled ring body. Record date, custodians, key versions.
4. Only then set `M36_BODY_BACKFILL_ESCROW_DRILL_CONFIRMED=true` **in the shell of the operator running the backfill** (not in the
   deployment's `.env.production`). In `NODE_ENV=production` a real run without it exits 1 before touching a row. A dry run is always allowed.

Run, per tenant:

```
bun run m36:body-backfill -- --org <organization-uuid> --dry-run          # reads, verifies, writes nothing
bun run m36:body-backfill -- --org <organization-uuid> --max-rows 2000    # re-run until "complete": true
```

Safe to stop (Ctrl-C) and re-run: the work list is the rows still on the legacy envelope. Each row is a compare-and-swap on the
ciphertext that was read, so a concurrent edit is never overwritten (`skippedConcurrent`, picked up by the next run). The plaintext
hash is checked before and after; a row whose hash does not match is reported (`hashMismatch`, an `m36.integrity.hash_mismatch`
audit row) and **left alone**: investigate it, do not force it. Every batch writes `m36.body_backfill.batch`, the end writes
`m36.body_backfill.run` with the completion count, and the table audit triggers write one row per re-sealed row.

Revisions are re-sealed through `m36_reseal_message_revision` (migration 1089), the only path that may UPDATE a revision.

Throttle with `--batch`, `--pause-ms`, `--max-rows`, `--deadline-sec`. New legacy rows keep appearing until stage 2 is on, so the
completion count only converges after it. Drafts and scheduled messages are not backfilled (transient: a draft is overwritten, a
scheduled row is sent and deleted); the legacy key must stay until none remain.

After each tenant: run `messaging.hash_verify` for it (or wait for the nightly) and require zero mismatches.

## Rotation

`tenant.dek_rotate` (M34) mints a new DEK version and keeps the old one in `prior_dek_versions`. Bodies record the version that
sealed them, so old rows stay readable and new writes use the new version once the cache expires (60 s). To re-encrypt old rows
under the new version, ring bodies are not re-sealed by the backfill (it only moves legacy rows); a version re-seal is a later,
separate step if policy ever requires dropping the old version.

## Crypto-shred

M34's four-phase shred runs the module erasers (M36 blanks `body_cipher`), then `m34_destroy_tenant_key_ring` zeroes the wrapped
DEK. After that every ring-sealed body of the tenant fails to open (proved live in `m36-body-key-ring.live.test.ts`). The decrypt
cache bounds how long a running process keeps using a destroyed DEK: at most 60 s, or immediately where
`invalidateMessageBodyKeys(orgId)` is called.

**What is not shredded:** a legacy-sealed row, and any backup or dump containing legacy-sealed ciphertext, is readable with
`MESSAGING_ENCRYPTION_KEY` and the org id alone. The shred is complete for a tenant only after the backfill finished for it and
the backups taken before that have aged out of retention or been re-wrapped.

## Retiring the legacy key (NOT part of WP 2.13; a later, separately gated step)

Only after all of: backfill complete by count for every tenant (and no legacy draft or scheduled row); a clean post-backfill
`hash_verify`; backups holding legacy-wrapped data aged out or re-wrapped; then destruction of the primary and every escrow share
attested in writing. Until then `assertProductionEnv` keeps requiring `MESSAGING_ENCRYPTION_KEY`; the boot check in this release
only adds the variant "legacy rows exist and the key is missing: refuse to boot" for the day that requirement is relaxed.

## Things you must not do

- Do not run the backfill against the shared dev Docker cluster or without the escrow record.
- Do not rotate or remove `MESSAGING_ENCRYPTION_KEY` or `M34_TENANT_KEK` during the backfill window (compromise is the one exception: expedite the backfill instead).
- Do not set `M36_BODY_BACKFILL_ESCROW_DRILL_CONFIRMED` in the committed deployment environment.
- Do not roll back to a pre-WP-2.13 build after stage 2.
