# Payer route resolution

## Existing source finding

`apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-context.ts` previously selected `CLEARINGHOUSE_PAYER_ID || macJurisdiction`. The MAC credential is tenant/provider scoped, but a MAC code is not proof of a Claim.MD payer identifier. M40's payer directory is canonical X12 payer data and does not encode the provider/MAC/account/environment Claim.MD mapping. M23 has no `location_id` on its claim record, and M1's provider entity is the current billing identity boundary.

## Implemented contract

`CLAIMMD_M23_PAYER_ROUTES` is a JSON array of platform-managed records:

```json
[{"organizationId":"<synthetic-org-uuid>","providerEntityId":"<synthetic-provider-uuid>","macJurisdiction":"<verified-mac-code>","accountReference":"<stable-account-reference>","usage":"test","payerId":"<vendor-confirmed-id-also-present-in-active-M40-payer-directory>","effectiveFrom":"2026-01-01","effectiveTo":"2026-12-31"}]
```

The effective end date may be omitted for an open-ended route. Matching uses the exact organization/provider/MAC/account/usage tuple and current time. Zero matches, expired routes, invalid/blank payer identifiers and overlapping active matches fail closed. Account `usage` is taken from `CLAIMMD_ACCOUNT_USAGE`; a conflicting explicit `CLEARINGHOUSE_USAGE` is rejected.

The route-readiness composition resolves the selected ID through M40's owner-exported active X12 payer-name reader before returning `verified`; unknown/inactive IDs return `CLAIMMD_PAYER_ROUTE_PAYER_NOT_ACTIVE`. The final loader repeats the same M40 lookup during rendering, so readiness is not the sole guard. No route identifiers are logged or returned to a tenant.

## Boundaries and precedence

- Claim.MD: scoped route configuration only. A set `CLEARINGHOUSE_PAYER_ID` is a boot/runtime configuration error and cannot override scoped routes.
- Other configured vendors: existing `CLEARINGHOUSE_PAYER_ID` behavior remains unchanged.
- Vendor unset: existing legacy MAC portal path remains unchanged.
- Route check happens in worker rendering and again inside `transportUpload` immediately before transport invocation; a stale queued job cannot rely only on an earlier UI result.
- Route check also blocks the authenticated submit endpoint before it enqueues.

No route was backfilled from a MAC jurisdiction, global override or tenant EDI receiver profile. Route values must be obtained from authorized Claim.MD/payer configuration owners. Effective-dated configuration changes are deployment-configuration history; an audited tenant-facing route-edit API is not introduced.

## Limitations

The route does not include location because M23 claim rows do not currently persist location identity. If future claim-domain modeling establishes location-specific routing, extend the tuple and immutable submission evidence after defining location-to-provider cardinality. No live route was verified in this task.
