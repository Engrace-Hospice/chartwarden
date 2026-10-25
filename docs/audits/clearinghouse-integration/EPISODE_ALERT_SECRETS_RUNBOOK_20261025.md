# Episode Alert secrets and configuration runbook (issue #762)

**Date:** 2026-10-25 · **Status:** what the code reads today and what the adapters will need. Read from
`packages/x12-837-client/src/clearinghouse/episode-alert-transport.ts` and `packages/x12-837-client/src/dde/provider-registry.ts` on 2026-10-25. No
credential exists yet and none belongs in this repository, a ticket or a chat; a person handles the real value
([onboarding runbook](./EPISODE_ALERT_ONBOARDING_RUNBOOK_20261025.md)).

## Names the code reads today

| Name | Read by | Meaning | Secret? |
|---|---|---|---|
| `EPISODE_ALERT_API_KEY` | `createEpisodeAlertTransportFromEnv` | The platform API credential, sent in the `Authorization` header (scheme UNVERIFIED, a placeholder until the trial docs name it). Required; the factory throws when blank | Yes |
| `EPISODE_ALERT_BASE_URL` | `createEpisodeAlertTransportFromEnv` | The vendor API root from the signup docs. Required, never defaulted; must be `https://` with no query or fragment | No, but keep it with the key |
| `DDE_PROVIDER` | `bindDdeProvider` / `parseDdeProvider` | `manual` (or unset or blank), `in_memory` (refused when `NODE_ENV=production`) or `episode_alert` | No |

Verified in the source:

- **Nothing in `apps/` reads these yet.** A search of `apps/` for `EPISODE_ALERT`, `DDE_PROVIDER`,
  `createEpisodeAlertTransportFromEnv` and `bindDdeProvider` finds nothing; they are exported from `packages/x12-837-client`
  only. Wiring is #760. Setting the variables today has no effect.
- **`DDE_PROVIDER=episode_alert` cannot be set yet.** There is no Episode Alert `DdeAccessProvider` adapter (#759), so the
  registry throws at boot ("no adapter is registered for it in this build"). That is the fail-closed design. Leave
  `DDE_PROVIDER` unset.
- **`CLEARINGHOUSE_VENDOR=episode_alert` is not bindable,** by design: the transport is eligibility-only and the setting would
  route claim submission through it (`transport-registry.ts` leaves it out). A separate eligibility-vendor setting is
  #760's job; do not invent one here.
- **The adapter has no test mode.** `usage: "test"` is refused unless built with `allowTestUsage` (conformance tests only), so a
  trial key calls the real service: synthetic data only until the BAA is signed.
- **Platform-held, not per tenant** (ADR-0103 D2). Per-operator DDE IDs are a separate matter (D4) and are not ChartWarden
  secrets; if the vendor needs any, that is a design change to decide after the vendor answers.

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
style of `STEDI_API_KEY=replace-with-...`; add the `EPISODE_ALERT_*` placeholder lines in the PR that wires them (#760), not
before.

## Procedure for the platform operator

1. Receive the key through the vendor's account page, never by email or chat. If it arrives in the clear anywhere, treat it as
   exposed and have the vendor reissue it.
2. Write `EPISODE_ALERT_API_KEY` and `EPISODE_ALERT_BASE_URL` into the encrypted production secret store and the inventory. For
   local work a developer uses the trial key only in an untracked `.env`, with synthetic data.
3. Confirm the application sees them without printing them. The Episode Alert tests assert the key is not in the URL or any
   result (`episode-alert.test.ts`); the platform must not log it either.
4. Keep `DDE_PROVIDER` unset until #759 ships and ADR-0103 is ratified.

## Rotation

Proposed: every 90 days and on suspicion, or the vendor contract cadence if shorter. Ask the vendor (EA 13) whether two keys can
be valid at once. If so: issue the new key, deploy it, confirm a call, then revoke the old one. If not, schedule a short window
and expect eligibility calls to fail during it (the adapter answers a degraded code, never a guess). Record the date in the
inventory.

## Leak response

Revoke at the vendor first, reissue, update the store, then search repository history and logs for the old value. The vendor sees
the beneficiary identifiers we send, so also review the vendor's access log for calls we did not make and tell the compliance
officer.
