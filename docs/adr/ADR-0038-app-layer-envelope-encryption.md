# ADR-0038 — Field encryption is application-layer AES-256-GCM envelope encryption, not pgcrypto

- **Status:** **Accepted** — ratifies the as-built state (2026-08-14, architecture-corpus
  remediation AR-04; see `audit/ARCHITECTURE_DOC_REMEDIATION_PLAN.md`). Highest compliance weight
  of the divergence set — auditors and BAAs cite the encryption mechanism.
- **Date:** 2026-08-14
- **Phase:** post-build divergence record.
- **Supersedes (wording):** `WARDENX_ARCHITECTURE_v0_11.md`'s pgcrypto envelope-encryption
  sections and `WARDENX_SECURITY_HARDENING_v0_2.md` §4.2 where it names pgcrypto as the
  field-encryption mechanism.
- **Related:** [ADR-0034](ADR-0034-2fa-secret-at-rest-encryption.md) (the first shipped instance
  of the pattern: pure AES-256-GCM seal/open over M1's encrypted columns).

## Context

The corpus describes sensitive-field encryption as **pgcrypto** (`pgp_sym_encrypt` in SQL). What
was actually built:

- `pgcrypto` **is installed** (`0001_foundation_rls_roles_partitioning.sql:14`) but is used for
  **`gen_random_uuid()` only** — there are zero `pgp_sym_encrypt`/`encrypt(` calls across all
  migrations, and the DB stack is explicitly "pgvector + pgcrypto only" (ARCH-027) for extensions.
- Real encryption is **application-layer AES-256-GCM**, envelope-style, in `node:crypto`:
  - `packages/messaging/src/crypto/body-crypto.ts` — per-tenant DEKs derived via
    **HKDF-SHA256** from a KEK with an org-scoped info string; at-rest format
    `version ‖ nonce(12) ‖ ciphertext ‖ tag(16)`.
  - `packages/auth/src/identity/two-factor-crypto.ts` — TOTP secret + backup codes (ADR-0034).
  - M22 documents: per-document DEKs whose destruction ("shred the DEK") is the crypto-erase
    mechanism behind destruction certificates; M34 tenant shred uses the same property.
  - The `kekUnwrap` **port** (`34-saas-tenant-platform/seam-registration.ts`) is the injection
    point for the KEK provider; where no provider is bound the dependent path **fails closed**
    (refuses to write plaintext) rather than silently downgrading — e.g. M33's drilldown export.

## Decision

1. **Sensitive-field and blob encryption is application-layer AES-256-GCM with envelope key
   management** (KEK → per-tenant/per-object DEK, HKDF-derived or wrapped), performed in the app
   process via `node:crypto`. Postgres stores ciphertext (`bytea`/encrypted columns) and never
   sees key material.
2. **pgcrypto is not a field-encryption mechanism here** and must not become one: SQL-layer
   encryption would put plaintext and keys through the DB session (visible to logs,
   `pg_stat_statements`, and any superuser), defeat crypto-erase-by-DEK-shred (the basis of M22
   destruction certificates and M34 tenant shred), and bypass the fail-closed `kekUnwrap` port
   discipline.
3. **Key-management is a port.** KEK custody (KMS/HSM) binds behind `kekUnwrap`; unbound paths
   fail closed. Binding a production KMS is integration work, not a mechanism change.

## Consequences

- Compliance answers (HIPAA §164.312(a)(2)(iv), BAA security exhibits) must describe app-layer
  AES-256-GCM envelope encryption; documents saying "pgcrypto" are wrong and now say so.
- Searching/indexing encrypted fields requires app-side design (blind indexes or scoped
  plaintext-adjacent columns) — a known cost of keeping plaintext out of the DB, accepted.
- Removing the `pgcrypto` extension is *not* implied (UUID generation uses it); only its
  encryption functions are out of bounds.
