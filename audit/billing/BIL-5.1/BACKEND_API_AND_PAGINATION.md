# Backend/API and pagination

No cross-module shadow table or central aggregation query was added. React composes bounded pages from the four owner APIs above; permissions, tenant checks and provider ABAC remain in those APIs. The server-derived provider scope is exposed to the shell through the existing authenticated actor-context contract.

M25 `ClaimMdEraReviewQuerySchema` adds optional UUID `locationId`. The route passes it to the M25 review service, whose SQL list predicates include the stage's `locationId` in addition to organization, provider scope, state, dates and cursor. The existing cursor ordering remains `createdAt DESC, id DESC`; the UI resets cursor state whenever query context changes. M25 payer/date/state filters are submitted to the source list, not applied over loaded rows.

The merged worklist uses one cursor per module and a deterministic final sort by source timestamp then namespaced item key. This is independent-source pagination, not a global snapshot cursor. The page caps each request at 30 and labels counts as loaded-page values.

OpenAPI and generated `packages/ui/src/core/api/schema.ts` were regenerated after the M25 query and actor-context contract changes.
