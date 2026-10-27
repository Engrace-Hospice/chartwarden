# 22 — API endpoint inventory

The complete endpoint inventory is the generated OpenAPI artifact under `audit/openapi-coverage/`
and the generated typed client contract. `bun run arch:openapi-coverage` and `client:check` passed at
the baseline; route reachability also passed. This report incorporates that inventory by reference
to avoid manually duplicating a generated route count.

Coverage was complete by the generator's enriched-route definition. Remaining contract exceptions:

- One raw-body mutating webhook path does not publish a normal JSON request schema; signature
  verification requires raw bytes and this was not classified as a defect without a bypass.
- Nine GET routes lack response schemas: amendments lists, HOPE package download, intake page image,
  messaging export download, patient matches, patient amendments/caregivers, records-request cover
  sheet, and metrics. Binary/metrics endpoints need media contracts rather than JSON schemas; the
  ordinary JSON list responses should be completed.

For every endpoint, authentication/authorization comes from route composition, not OpenAPI text.
Architecture checks passed registered ABAC predicates, composed controls, verified header use,
error envelopes, and registrar reachability. Exhaustive runtime BOLA/IDOR testing across the entire
inventory remains blocked and is recorded in report 26.
