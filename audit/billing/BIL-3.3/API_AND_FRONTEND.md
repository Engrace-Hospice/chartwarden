# API and frontend

The existing tenant-scoped `GET /api/v1/remittance/claimmd-era/:id/matching` response now carries the financial projection and up to 200 durable financial-review decisions. No new inbox or raw central-inbox endpoint was added.

The decision endpoint accepts only item type/index, disposition, expected version and reason; source identity, tenant/provider, actor, status, balance and posting authorization are server-derived. Dispositions: `note`, `follow_up`, `reviewed`, `reopened`, `completed`.

The existing `claimmd-era-review.tsx` detail displays financial totals, claim payment state, adjustment scope/group/reason, exceptions, balance and review history. Controls are permission-aware and completion is disabled when server projection reports blocking conditions. Service-line matching remains explicitly unavailable without original transmitted-line evidence. There is no posting control.

OpenAPI and generated client are updated from the TypeBox contract.
