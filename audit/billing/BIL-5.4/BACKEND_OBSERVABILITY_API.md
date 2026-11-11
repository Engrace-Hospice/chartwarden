# Backend observability API

## Tenant

`GET /api/v1/remittance/claimmd-operational-health?providerEntityId=<uuid>`

Requires `remittance.read`. TypeBox, OpenAPI, and generated client contracts are included. Counts are exact for authorized provider stages.

## Platform

`GET /api/v1/ops/claimmd/observability`

Requires the established platform billing permission and ABAC plus a platform role. It is read-only and returns safe bounded evidence. The response explicitly marks unavailable heartbeat and budget facts.
