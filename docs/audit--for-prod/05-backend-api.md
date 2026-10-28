# 05 — Backend API

The backend uses Fastify route registrars, TypeBox/OpenAPI enrichment, typed error envelopes,
permission/ABAC middleware, request context, RLS, seams, and outbox consumers. Architecture gates
passed route reachability, ABAC registration/composition, verified-header use, context producers,
queue ownership, outbox bindings, and error-envelope policy.

The generated OpenAPI report covered every registered route at the audited checkout. Nine GETs lack
response schemas; several are binary/download/metrics endpoints where a JSON schema is inappropriate,
while patient caregivers/amendments and list-style endpoints warrant contract completion. The one
body-read mutation without a request schema is the raw signed-webhook class and was not automatically
classified as vulnerable.

## Confirmed issue

The most consequential API/business defect is cross-module rather than missing middleware:
M5 creates inclusive-overlapping payer intervals and M23 reads only Medicare FFS at endpoints.
`CW-QA-0001` was reproduced with the real seam and database role.

## Unverified API properties

- Exhaustive horizontal/vertical authorization for all endpoints was not runtime-tested.
- Rate-limit effectiveness, cancellation, timeouts, and retry behavior were inspected selectively,
  not load/fault tested.
- OpenAPI enrichment proves declared contracts, not that every response obeys them at runtime.
- External callbacks and vendors were not contacted.

No flat error-envelope or unreachable-registrar finding was retained because the corresponding
fitness gates passed and no counterexample was reproduced.
