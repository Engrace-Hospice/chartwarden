# WardenX — OpenAPI Enrichment Coverage

> **Generated** (`bun run openapi:coverage`). Do not hand-edit — `arch:openapi-coverage`
> (in `arch:fitness`) keeps this in sync with source and enforces the ratchet.

`openapi:check` proves openapi.json was regenerated and that no enrichment targets a dead route. It does NOT prove a route carries a request contract — an unenriched route is still emitted, with no `requestBody` and a bare `200: OK`, and the generated client then types its body as `never`. This report is the coverage half.

**Totals:** 0/1 routes enriched (0%) · **0/1 mutating routes read a body they publish none for** · 0/0 GETs carry no response schema

`Deficit` = routes with no enrichment entry; it is the ratcheted number (see `baseline.json`). `Mut. unpublished body` counts a POST/PUT/PATCH whose HANDLER READS a payload and whose contract publishes none — `client:gen` then types that body `never`, so the generated client cannot express the call. It used to count every mutating route with no body schema, which could never honestly reach 0 (an action POST correctly publishes none) and made shipping an empty `{}` schema the cheapest way to move it — 25 routes did exactly that. The reverse direction — a published body no handler reads, which returns 200 and discards the payload — is enforced by `arch:request-body-contract`, not counted here.

| Module | Routes | Enriched | Deficit | Mutating | Mut. unpublished body | GET | GET no resp |
|---|--:|--:|--:|--:|--:|--:|--:|
| 33-reporting | 1 | 0 (0%) | 1 | 1 | 0 | 0 | 0 |
