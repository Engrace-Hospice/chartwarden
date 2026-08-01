# WardenX — OpenAPI Enrichment Coverage

> **Generated** (`bun run openapi:coverage`). Do not hand-edit — `arch:openapi-coverage`
> (in `arch:fitness`) keeps this in sync with source and enforces the ratchet.

`openapi:check` proves openapi.json was regenerated and that no enrichment targets a dead route. It does NOT prove a route carries a request contract — an unenriched route is still emitted, with no `requestBody` and a bare `200: OK`, and the generated client then types its body as `never`. This report is the coverage half.

**Totals:** 517/995 routes enriched (52%) · **330/574 mutating routes carry no request-body schema** · 228/395 GETs carry no response schema

`Deficit` = routes with no enrichment entry; it is the ratcheted number (see `baseline.json`). `Mut. no body` is the sharpest signal — a POST that validates a TypeBox body in its handler but publishes none is a contract that lies by omission.

| Module | Routes | Enriched | Deficit | Mutating | Mut. no body | GET | GET no resp |
|---|--:|--:|--:|--:|--:|--:|--:|
| 02-identity | 14 | 10 (71%) | 4 | 9 | 3 | 3 | 0 |
| 03-authorization | 17 | 9 (53%) | 8 | 9 | 2 | 6 | 4 |
| 04-audit | 4 | 1 (25%) | 3 | 0 | 0 | 4 | 3 |
| 05-patient | 14 | 13 (93%) | 1 | 5 | 1 | 9 | 0 |
| 06-admission | 46 | 6 (13%) | 40 | 34 | 34 | 12 | 6 |
| 07-care-plan | 19 | 3 (16%) | 16 | 13 | 13 | 6 | 3 |
| 08-encounters | 31 | 4 (13%) | 27 | 22 | 22 | 8 | 4 |
| 09-assessments | 18 | 6 (33%) | 12 | 7 | 7 | 11 | 5 |
| 10-hope | 20 | 10 (50%) | 10 | 10 | 10 | 10 | 0 |
| 11-orders | 28 | 9 (32%) | 19 | 18 | 18 | 10 | 1 |
| 12-dosespot | 31 | 10 (32%) | 21 | 21 | 21 | 10 | 0 |
| 13-emar | 28 | 10 (36%) | 18 | 18 | 18 | 10 | 0 |
| 14-idg | 26 | 6 (23%) | 20 | 17 | 17 | 6 | 0 |
| 15-discipline-care-plans | 28 | 23 (82%) | 5 | 17 | 2 | 11 | 11 |
| 16-bereavement | 33 | 31 (94%) | 2 | 26 | 0 | 7 | 7 |
| 17-scheduling | 29 | 11 (38%) | 18 | 17 | 17 | 12 | 1 |
| 18-evv | 25 | 7 (28%) | 18 | 15 | 15 | 10 | 3 |
| 19-oncall | 38 | 31 (82%) | 7 | 26 | 2 | 12 | 12 |
| 20-field-safety | 30 | 25 (83%) | 5 | 17 | 0 | 12 | 12 |
| 21-supplies | 37 | 31 (84%) | 6 | 24 | 0 | 12 | 12 |
| 22-documents | 35 | 6 (17%) | 29 | 19 | 19 | 15 | 9 |
| 23-billing-medicare | 43 | 43 (100%) | 0 | 17 | 4 | 24 | 22 |
| 24-billing-medicaid | 39 | 39 (100%) | 0 | 20 | 4 | 17 | 0 |
| 25-remittance | 31 | 18 (58%) | 13 | 18 | 5 | 13 | 8 |
| 26-cap | 27 | 19 (70%) | 8 | 12 | 2 | 15 | 8 |
| 27-cost-report | 45 | 11 (24%) | 34 | 28 | 18 | 16 | 16 |
| 30-quality | 60 | 57 (95%) | 3 | 36 | 3 | 24 | 0 |
| 32-ai-platform | 32 | 32 (100%) | 0 | 11 | 0 | 17 | 17 |
| 33-reporting | 42 | 4 (10%) | 38 | 22 | 21 | 20 | 20 |
| 34-saas-tenant-platform | 48 | 9 (19%) | 39 | 30 | 27 | 17 | 17 |
| 36-messaging | 22 | 4 (18%) | 18 | 13 | 12 | 6 | 3 |
| 38-terminology | 8 | 1 (13%) | 7 | 1 | 1 | 6 | 5 |
| 39-consent | 27 | 17 (63%) | 10 | 13 | 3 | 13 | 9 |
| 40-mdm | 14 | 1 (7%) | 13 | 8 | 8 | 6 | 5 |
| bootstrap | 6 | 0 (0%) | 6 | 1 | 1 | 5 | 5 |
