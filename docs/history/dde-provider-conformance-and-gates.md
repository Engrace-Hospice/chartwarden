# DDE access provider: conformance, live proof and gates (#763, ADR-0103, parent #755)

Audit of what proves the DDE work queue and the `DdeAccessProvider` port, done when #763 was closed out. Nothing here needed vendor documents; what does need them is listed under "Known limits".

## What proves it today

| Concern | Proof |
|---|---|
| `DdeAccessProvider` conformance (cases D1 to D14: scope isolation, idempotency by operator, `usage: "test"` reaching only test mode, cursor paging, no MBI in any result) | `packages/x12-837-client/src/dde/conformance.ts`, run against the in-memory reference in `dde.test.ts`; `dde-mutants.test.ts` breaks the reference on purpose and requires a case to catch each mutant |
| Read/tracking port (eligibility through `ClearinghouseTransport`, `ELIGIBILITY_VENDOR` binding) | shared clearinghouse conformance run against `EpisodeAlertTransport` (capability `eligibility`) in `clearinghouse/episode-alert.test.ts`, plus `eligibility-vendor-registry.test.ts` |
| Queue persistence, RLS, work queue lifecycle, provider send, in-doubt marker, daily change ingest | six live suites as `chartwarden_app` through the real routes and the real catalog-validating publisher: `test:m23:dde-queue:live`, `-queue-hardening`, `-queue-scope`, `-provider-identity-aging`, `-queue-provider`, `-daily-change`; each has a `package.json` script and a `ci.yml` row (`arch:live-suites` checks both directions) |
| Cross-tenant | the queue, hardening and daily-change suites assert another org cannot read, close or move this org's items; RLS is enabled and FORCEd on both tables |
| Gates | `arch:fitness` (outbox bindings, manifest mirror, tenancy, live suites, ABAC) green; no DDE-specific gate was missing |

## Known limits

- The Episode Alert DDE write adapter (#759) is a skeleton whose wire answers "unverified"; `bindDdeProvider` refuses to bind it. The shared DDE conformance suite must be run against it, as a second adapter, the day its wire is verified.
- Episode Alert claim status and remits stay `CH_NOT_WIRED` (#758) until a trial account validates the fields.
- The eligibility adapter yields a Part A active/inactive answer only; the hospice section of the DDE drawer says so rather than inventing data.
- Every vendor field is unverified until a trial account proves it (DoseSpot precedent, `m12-dosespot-adapter.md`). ADR-0103 stays Proposed until the first real adapter passes conformance.
