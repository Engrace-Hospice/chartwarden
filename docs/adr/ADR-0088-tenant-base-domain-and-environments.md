# ADR-0088 — `TENANT_BASE_DOMAIN` is `chartwarden.com` for the real-data environment; the demo stays single-host

- **Status:** **Accepted** — decided by the product owner 2026-10-21.
- **Date:** 2026-10-21
- **Phase:** post-launch platform work (tenant onboarding).
- **Resolves:** the base-domain question ADR-0049 D2 deliberately deferred.
- **Related:** [ADR-0049](ADR-0049-tenant-subdomains.md) (the mechanism; unchanged by this ADR),
  [ADR-0050](ADR-0050-talos-kubernetes-platform.md) (the platform the real environment targets).
- **Plan:** [`docs/TENANT_SUBDOMAINS_PLAN.md`](../TENANT_SUBDOMAINS_PLAN.md)

## Context

ADR-0049 decided how a tenant is served at `<slug>.<TENANT_BASE_DOMAIN>` but deferred which domain, and
required the choice before the first tenant goes live on a subdomain. The candidates then were
`wardenx.com`, `wardenx.app` and `chartwarden.cloud`. The product has since been renamed ChartWarden
(#526), and two environments are planned.

## Decision

| Environment | Domain | Data | Mode |
|---|---|---|---|
| Demo | `chartwarden.cloud` | demo | **single-host** (`TENANT_BASE_DOMAIN` unset): today's behaviour, org-select after sign-in |
| Real | `chartwarden.com` and `*.chartwarden.com` | real PHI | **subdomain mode**: `TENANT_BASE_DOMAIN=chartwarden.com`, `PASSKEY_RP_ID=chartwarden.com` |

1. The real environment's `TENANT_BASE_DOMAIN` is `chartwarden.com`. Hospice tenants live at
   `<slug>.chartwarden.com`. The apex serves marketing or a redirect (ADR-0049 reserved hosts).
2. The demo environment never sets `TENANT_BASE_DOMAIN`. ADR-0049 D2 already makes that the dark,
   unchanged mode; no demo code path changes.
3. Demo and real are separate deployments with separate databases, secrets and certificates. Demo data is
   never migrated to real, and the demo is reseeded rather than remediated.
4. `PASSKEY_RP_ID=chartwarden.com` in the real environment (ADR-0049 D4 already requires it to equal
   `TENANT_BASE_DOMAIN`). The real environment starts with no passkeys, so nothing is invalidated. Changing
   the RP ID later would invalidate every registered passkey, so treat this value as permanent.
5. **Ownership.** quillwardhealth.com owns the ChartWarden software and its IP and operates the real
   environment. It must control DNS for `chartwarden.com` (the wildcard record and the DNS-01 credentials
   in ADR-0049 D2). Confirm that control before Phase 5 of the plan.
6. Reserved hosts (ADR-0049 D2) apply under `chartwarden.com`. The operator console is
   `admin.chartwarden.com`, the object store is `storage.chartwarden.com`, and the tenant picker is
   `app.chartwarden.com`.

## Consequences

- ADR-0049's "base domain deferred" row is closed by this ADR. ADR-0049 is not edited (ADRs are immutable
  once Accepted).
- The real environment needs its own env file, compose or manifests, wildcard certificate and database.
- Existing hosts under `chartwarden.cloud` keep working throughout.
