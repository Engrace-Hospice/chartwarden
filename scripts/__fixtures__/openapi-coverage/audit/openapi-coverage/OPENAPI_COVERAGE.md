# WardenX — OpenAPI Enrichment Coverage

> **Generated** (`bun run openapi:coverage`). Do not hand-edit — `arch:openapi-coverage`
> (in `arch:fitness`) keeps this in sync with source and enforces the ratchet.

`openapi:check` proves openapi.json was regenerated and that no enrichment targets a dead route. It does NOT prove a route carries a request contract — an unenriched route is still emitted, with no `requestBody` and a bare `200: OK`, and the generated client then types its body as `never`. This report is the coverage half.

**Totals:** 0/1 routes enriched (0%) · **1/1 mutating routes carry no request-body schema** · 0/0 GETs carry no response schema

`Deficit` = routes with no enrichment entry; it is the ratcheted number (see `baseline.json`). `Mut. no body` is the sharpest signal — a POST that validates a TypeBox body in its handler but publishes none is a contract that lies by omission.

| Module | Routes | Enriched | Deficit | Mutating | Mut. no body | GET | GET no resp |
|---|--:|--:|--:|--:|--:|--:|--:|
| 33-reporting | 1 | 0 (0%) | 1 | 1 | 1 | 0 | 0 |
