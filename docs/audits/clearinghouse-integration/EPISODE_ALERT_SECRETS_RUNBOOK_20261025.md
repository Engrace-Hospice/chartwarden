# Episode Alert secrets and configuration runbook (issue #762)

**Date:** 2026-10-25 · **Safety update:** 2026-11-18 · **Status:** configuration names and activation limits. Read from
`packages/x12-837-client/src/clearinghouse/episode-alert-transport.ts`, `packages/x12-837-client/src/dde/episode-alert-dde-provider.ts`
and the registries on 2026-11-18. No credential belongs in this repository, a ticket or a chat; a person handles any real value
([onboarding runbook](./EPISODE_ALERT_ONBOARDING_RUNBOOK_20261025.md)).

## Names the code reads today

| Name | Read by | Meaning | Secret? |
|---|---|---|---|
| `EPISODE_ALERT_API_KEY` | `createEpisodeAlertTransportFromEnv` | Intended platform API credential; the factory currently refuses before reading it because the wire and destination are unverified | Yes |
| `EPISODE_ALERT_BASE_URL` | `createEpisodeAlertTransportFromEnv` | Intended vendor API root; HTTPS URL syntax is checked by the adapter, but no origin is approved | No, but keep it with the key |
| `EPISODE_ALERT_DDE_API_KEY` | `createEpisodeAlertDdeProviderFromEnv` | Intended platform DDE API credential; the factory refuses before reading it because the wire and destination are unverified | Yes |
| `EPISODE_ALERT_DDE_BASE_URL` | `createEpisodeAlertDdeProviderFromEnv` | Intended DDE API root; HTTPS URL syntax is checked, but no origin is approved | No, but keep it with the key |
| `DDE_PROVIDER` | `bindDdeProvider` / `parseDdeProvider` | `manual` (or unset or blank), `in_memory` (refused when `NODE_ENV=production`) or `episode_alert` | No |

Verified in the source:

- **Nothing in `apps/` consumes the Episode Alert eligibility registry or binds the DDE provider.** M23 HETS remains
  `M23_HETS_TRANSPORT`. The package-level `ELIGIBILITY_VENDOR` registry is a seam only; setting it does not route application
  calls today.
- **The DDE adapter is a fail-closed skeleton.** `DDE_PROVIDER=episode_alert` cannot bind through the application; the package
  factory throws while the wire or exact destination is unverified. Leave `DDE_PROVIDER` unset/manual.
- **`CLEARINGHOUSE_VENDOR=episode_alert` is not bindable,** by design: the transport is eligibility-only and the setting would
  route claim submission through it (`transport-registry.ts` leaves it out). The package-level `ELIGIBILITY_VENDOR` setting
  exists, but no backend consumer binds it and its production factory currently refuses the unverified adapter.
- **There is no verified Episode Alert sandbox.** Test usage is refused unless a local `LocalFakeHttpClient` is injected by a
  test; it returns scripted in-memory responses and cannot open a socket. `allowTestUsage` and environment variables cannot
  enable vendor calls. A trial account must not be treated as a sandbox.
- **The current code seam expects a platform credential** under proposed ADR-0103 D2; it does not prove this model is allowed
  by Episode Alert or appropriate for customer isolation. Per-operator DDE identity is separate (D4) and must not be shared.

## Account and authorization decision is still open

ADR-0103 D2's platform-held credential is a proposed architecture choice, not a confirmed Episode Alert account arrangement.
Before any future activation, compare a tenant-owned account, vendor-isolated partner subaccounts, and a shared platform
credential. Prefer tenant ownership or demonstrably isolated subaccounts. A shared credential requires written vendor and legal
authorization plus independently enforced tenant, provider-entity, and acting-operator scope; billing NPI alone does not prove
isolation. Do not create new secret names, storage, or account bindings before the architecture and vendor contract are settled.

Eligibility credentials do not establish HETS authorization: CMS's validation effective 2026-05-11 requires a current HETS
enrollment relationship for each submitted NPI and the third-party vendor. This is separate from DDE identity and hospice
institutional claims/ERA enrollment.

See [`EPISODE_ALERT_ARCHITECTURE_AND_EVIDENCE_20261118.md`](./EPISODE_ALERT_ARCHITECTURE_AND_EVIDENCE_20261118.md) for evidence,
current CMS Oregon HH+H J6 routing sources, and capability blockers. Public BAA/pricing pages are not executed customer or partner
agreements.

## What the adapters may need beyond today

Unknown until the vendor replies; do not create these names now. Ask for them in the questions document: a webhook signing
secret (EA 6), a trial or sandbox base URL (EA 5), per-operator DDE credentials or enrollment tokens (EA 8). Each one found
goes into the table above in the same change that makes the code read it, with the name taken from that code.

## Where the values live

ChartWarden's rule is that no credential lives in source or in plain env files in production; secrets sit in the secret manager
and are read at boot (`CHARTWARDEN_INTEGRATIONS_v0_1.md` section 3.4). The operations runbook (`CHARTWARDEN_OPS_RUNBOOK_v0.1.md`
section 8.1) describes the store as SOPS-encrypted env files with an inventory at `infra/secrets/inventory.yaml`. **That
directory is not in this repository** (checked 2026-10-25), so the platform operator keeps the real files wherever production
secrets live today and adds the inventory row (section 8.1 now lists these names). `.env.example` takes placeholders only, in the
style of `STEDI_API_KEY=replace-with-...`; the `EPISODE_ALERT_*` and `DDE_PROVIDER` placeholder lines were added in the #760 follow-up PR
(commented out, no values).

## Procedure for the platform operator

1. Do not receive, inspect or place a real key as part of adapter development. The vendor account owner handles it through the
   approved channel; an exposed key must be revoked/reissued.
2. Do not place Episode Alert values in production configuration until the wire, approved origin, vendor authorization,
   contractual conditions and activation plan have been reviewed. The current factory intentionally refuses to bind.
3. Local work uses only `LocalFakeHttpClient` and synthetic fixtures; never place a vendor key in `.env`, a test process or a
   test artifact. The tests assert that synthetic key/MBI values do not enter results.
4. Keep `DDE_PROVIDER` unset/manual and do not bind `ELIGIBILITY_VENDOR=episode_alert` into the backend. Manual DDE and the
   existing M23 HETS path remain the operational baseline.

## Rotation

Proposed: every 90 days and on suspicion, or the vendor contract cadence if shorter. Ask the vendor (EA 13) whether two keys can
be valid at once. After the integration is separately approved for activation, plan rotation to issue the new key, verify it
through the approved safe procedure, then revoke the old one. Until then, do not deploy or test a vendor key through ChartWarden;
the current adapter is intentionally unbound. Record any future rotation date in the inventory.

## Leak response

For an approved active integration, revoke at the vendor first, reissue, update the store, then search repository history and
logs for the old value. Once an authorized integration is active, the vendor may receive beneficiary identifiers; review vendor
access logs for calls not initiated by ChartWarden and tell the compliance officer. The current adapter has not been activated.
