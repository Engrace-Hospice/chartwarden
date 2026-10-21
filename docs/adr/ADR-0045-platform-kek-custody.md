# ADR-0045 — The platform KEK is held by the application, not fetched from a KMS gateway

- **Status:** **Accepted** — ratified 2026-08-26. Closes the production-readiness finding F-045
  (issue #105) and the `kekUnwrap` injection point ADR-0038 §3 left open.
- **Date:** 2026-08-26
- **Phase:** production-readiness audit remediation (2026-08-25 corpus).
- **Extends:** [ADR-0038](ADR-0038-app-layer-envelope-encryption.md) §3 ("key-management is a
  port"). The mechanism is unchanged; this ADR names the port's production binding.
- **Related:** [ADR-0034](ADR-0034-2fa-secret-at-rest-encryption.md) §2 (the same env-held-key
  custody model, for a user-level secret), [ADR-0014](ADR-0014-part2-disclosure-gate.md) (the
  eraser-refusal gate the shred worker honours before the irreversible phase).

## Context

M34 §3.5 stores each tenant's data-encryption key (DEK) **wrapped**, in
`tenant_key_ring.current_dek_kek_wrapped_ciphertext`, under a platform key-encryption key (KEK).
Every consumer of per-tenant envelope encryption resolves that DEK through M34's `TenantKeyProvider`
seam (D5), which composes over a `kekUnwrap` port. ADR-0038 §3 recorded that the port's binding was
"integration work, not a mechanism change" and that unbound paths fail closed.

They did fail closed — permanently, everywhere. Nothing bound the port. The only implementation in
the tree was `M34ProvisionGateway.kekUnwrap`, an HTTP call to an external "tenant provision gateway"
that is **unspecified and undeployed** (issue #115): no service answers `/dek/wrap` or `/dek/unwrap`,
and no document says what would. So `dekForOrg()` refused for every organization in every
deployment, and with it M8's signed HearthNote narrative, M27's `raw_payload_cipher` live pull,
M29's stored HL7 payloads, M31's portal contact ciphers, M39's consent notes, and — most seriously —
M34's own cryptographic shred, which cannot destroy a key that was never minted.

A second, independent break sat one step earlier in the same call. Migration 0052 §5 REVOKES
`wardenx_app`'s SELECT on `tenant_key_ring` and surfaces only the ciphertext-free
`tenant_key_ring_metadata_v` view to it — the §3.10 / M34-F02 control, and a good one: the request
path's credential must never reach key material, so that a SQL-level compromise of that credential
yields no keys. The key provider read the ring through **exactly that credential**
(`withOrgContext` over the org-pooled client), so it returned `42501 permission denied for table
tenant_key_ring` before ever reaching the KEK. Any amount of work on the KEK alone would have left
the chain dead and the diagnosis pointing at the wrong layer.

## Decision

1. **The production `kekUnwrap` binding is a KEK this process holds**
   (`apps/backend/src/bootstrap/tenant-kek.ts`), loaded from `M34_TENANT_KEK` and validated at boot
   by `assertProductionEnv`. Custody matches the three KEKs already in the tree —
   `M24_CREDENTIAL_ENCRYPTION_KEY`, `MESSAGING_ENCRYPTION_KEY`, `TWO_FACTOR_ENCRYPTION_KEY` — i.e.
   the deployment's secret manager, injected as an environment variable.

2. **The DEK is WRAPPED, never derived.** This is the one place the M24/M36 pattern must not be
   copied. Those two HKDF-derive a tenant DEK from `(KEK, orgId)`, which is correct for them and
   would be a silent catastrophe here: a derived DEK is a pure function of an env var, so it is
   always recomputable, and nulling the stored ciphertext would destroy nothing. M34's crypto-erase —
   the mechanism behind every destruction certificate this platform issues, and the control a BAA
   termination clause is written against — depends on the wrapped ciphertext being the **only** copy.
   So the DEK is 32 random bytes, minted once per key ring, and the shred is real.

3. **The wrap and unwrap halves are one adapter.** `mintAndWrapDek` (tenant provisioning and
   `tenant.dek_rotate`) and `unwrap` (the D5 seam) come from the same object, because a DEK wrapped
   under one format or AAD and opened under another is a key nobody can open. When a KEK is
   configured it wins over the provision gateway's `/dek/*` for both halves.

4. **The AAD binds the tenant.** `unwrap` takes an `organizationId` (a widening of the port's shape)
   and mixes it, with the format version and the KEK id, into the AES-256-GCM additional data. A
   wrapped DEK is therefore openable only in the key ring it was minted for. Without this, anyone who
   can WRITE `tenant_key_ring` — the platform credential, or a restored backup — could copy tenant
   B's ciphertext into tenant A's row and read B's PHI through A's request path **while never
   holding the KEK at all**.

5. **KEK rotation is carried by `kekId`, not by the format version byte.** `M34_TENANT_KEK` is
   `<kekId>:<base64 32 bytes>`; `M34_TENANT_KEK_RETIRED` holds prior KEKs, unwrap-only. An unknown
   `kekId` is refused **by name** rather than tried against the configured keys.

6. **The key-ring read runs on the platform credential.** `registerLiveM34Seams` takes a
   `keyRingDb` — `DATABASE_PLATFORM_URL`'s pool, which holds 0052's SELECT grant — and the provider
   reads the ring through a *separate* org-scoped runner over it. The §3.10 control is preserved
   (the request path's credential still cannot read key material); the read stays **org**-scoped, not
   platform-scoped, so it takes no `withPlatformContext` entry and writes no `platform.bypass_invoked`
   audit row — which would otherwise land on every encounter finalize and every message read.
   Unbound, it refuses with a typed reason naming `DATABASE_PLATFORM_URL`, never a bare 42501.

## Consequences

- **The threat model this accepts, stated plainly.** An attacker who obtains the application's
  environment obtains the KEK, and with it every tenant's DEK. That is strictly weaker than an
  HSM/KMS, where the KEK never leaves the module and each unwrap is an auditable call. It is
  *exactly as strong* as the three KEKs already protecting 2FA secrets, message bodies and Medicaid
  trading-partner credentials in this codebase, so it does not lower the platform's floor — and it
  is much stronger than the status quo it replaces, which was no encryption chain at all.
- **Compromise of the database alone still yields nothing.** The KEK is not in Postgres, the wrapped
  DEK is not readable by the request-path credential, and the AAD stops a wrapped DEK being moved
  between tenants.
- **The exit to a KMS/HSM is one binding.** Replace `createPlatformKekAdapter(...)` at the
  composition root with a KMS-backed implementation of the same two methods. No module changes, no
  schema changes, no re-encryption: the stored ciphertext already names its `kekId`, so a KMS key can
  be introduced as the new active KEK while the env-held one is retired into
  `M34_TENANT_KEK_RETIRED` and read-only.
- **A new production secret**, `M34_TENANT_KEK`, fail-closed at boot. Losing it without a retired
  copy makes every tenant's ciphertext permanently unreadable — the same property that makes the
  shred work, pointed the wrong way. Backup and rotation of this value is an operational
  requirement, not a convenience (`docs/architecture/CHARTWARDEN_OPS_RUNBOOK_v0.1.md` §key management).
- **The provision gateway is no longer on the DEK path.** It keeps `/dek/wrap` and `/dek/unwrap` for
  a future KMS-fronted deployment, and is still required for storage prefixes and invitation
  delivery; but the platform's root key operation no longer depends on a service that does not exist.
