# ADR-0088 — `TENANT_BASE_DOMAIN` is `chartwarden.com` for the real-data environment; the demo stays single-host

- **Status:** **Accepted** — decided by the product owner 2026-10-21. Decision 2 (the demo stays single-host) was
  superseded by the product owner on 2026-11-05; see [the amendment](#amendment-2026-11-05-the-demo-serves-tenant-subdomains-too-supersedes-decision-2) at the end.
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

## Amendment 2026-11-05: the demo serves tenant subdomains too (supersedes decision 2)

**Decision (product owner, 2026-11-05).** The demo turns tenant subdomains on as well: demo tenants are served at
`<slug>.chartwarden.cloud`, alongside the real environment's `<slug>.chartwarden.com`. This supersedes decision 2 ("the demo
environment never sets `TENANT_BASE_DOMAIN`") and the Demo row of the decision table ("single-host"). Decisions 1 and 3 to 6
stand, in particular decision 3: the two environments stay separate deployments with separate databases, secrets and
certificates, and demo data is still reseeded rather than remediated.

- **Switched on, not on by default.** The demo's web image gets its base domain from the repository variable
  `DEMO_TENANT_BASE_DOMAIN` (read by `deploy.yml`), and the demo's backend from the five settings in its production env file
  (`TENANT_BASE_DOMAIN` and the settings that go with it; `deploy/production/.env.tenant.example`). While the variable is
  unset the demo builds and behaves as it did under the original decision 2. Setting it adds no workflow trigger; it is set
  only after the demo's DNS, wildcard certificate and edge are live.
- **Consequences for the demo.** `PASSKEY_RP_ID` changes from `app.chartwarden.cloud` to `chartwarden.cloud` (ADR-0049 D4),
  which invalidates every demo passkey; the demo is reseeded, so users re-enrol. Sessions and the CSRF cookie become
  per host. `app.chartwarden.cloud` becomes the "find my organization" landing, and the demo organization is served at its own
  tenant host.
- **Hosts that exist today keep working.** `app.`, `api.` and `storage.` are reserved names (ADR-0049 D2) with exact vhosts that
  win over the wildcard. The legacy `wardenx.chartwarden.cloud` redirect (the infra rename) is reserved as well, so no
  tenant can be given a slug that the redirect would swallow (migration 1331).
- **Operations.** The demo's Cloudflare, certificate and edge steps are Checklist A of
  [`deploy/production/TENANT_EDGE.md`](../../deploy/production/TENANT_EDGE.md); the real environment's are its Checklist B.
