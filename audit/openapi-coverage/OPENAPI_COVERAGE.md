# WardenX — OpenAPI Enrichment Coverage

> **Generated** (`bun run openapi:coverage`). Do not hand-edit — `arch:openapi-coverage`
> (in `arch:fitness`) keeps this in sync with source and enforces the ratchet.

`openapi:check` proves openapi.json was regenerated and that no enrichment targets a dead route. It does NOT prove a route carries a request contract — an unenriched route is still emitted, with no `requestBody` and a bare `200: OK`, and the generated client then types its body as `never`. This report is the coverage half.

**Totals:** 1127/1133 routes enriched (99%) · **104/647 mutating routes carry no request-body schema** · 62/458 GETs carry no response schema

`Deficit` = routes with no enrichment entry; it is the ratcheted number (see `baseline.json`). `Mut. no body` is the sharpest signal — a POST that validates a TypeBox body in its handler but publishes none is a contract that lies by omission.

| Module | Routes | Enriched | Deficit | Mutating | Mut. no body | GET | GET no resp |
|---|--:|--:|--:|--:|--:|--:|--:|
| 02-identity | 14 | 14 (100%) | 0 | 9 | 0 | 3 | 0 |
| 03-authorization | 17 | 17 (100%) | 0 | 9 | 2 | 6 | 0 |
| 04-audit | 4 | 4 (100%) | 0 | 0 | 0 | 4 | 0 |
| 05-patient | 14 | 14 (100%) | 0 | 5 | 1 | 9 | 0 |
| 06-admission | 46 | 46 (100%) | 0 | 34 | 0 | 12 | 0 |
| 07-care-plan | 19 | 19 (100%) | 0 | 13 | 0 | 6 | 0 |
| 08-encounters | 31 | 31 (100%) | 0 | 22 | 1 | 8 | 0 |
| 09-assessments | 18 | 18 (100%) | 0 | 7 | 0 | 11 | 0 |
| 10-hope | 20 | 20 (100%) | 0 | 10 | 0 | 10 | 0 |
| 11-orders | 28 | 28 (100%) | 0 | 18 | 2 | 10 | 0 |
| 12-dosespot | 31 | 31 (100%) | 0 | 21 | 2 | 10 | 0 |
| 13-emar | 28 | 28 (100%) | 0 | 18 | 1 | 10 | 0 |
| 14-idg | 26 | 26 (100%) | 0 | 17 | 2 | 6 | 0 |
| 15-discipline-care-plans | 28 | 28 (100%) | 0 | 17 | 2 | 11 | 2 |
| 16-bereavement | 33 | 33 (100%) | 0 | 26 | 0 | 7 | 0 |
| 17-scheduling | 29 | 29 (100%) | 0 | 17 | 1 | 12 | 0 |
| 18-evv | 25 | 25 (100%) | 0 | 15 | 1 | 10 | 0 |
| 19-oncall | 38 | 38 (100%) | 0 | 26 | 2 | 12 | 0 |
| 20-field-safety | 30 | 30 (100%) | 0 | 17 | 0 | 12 | 0 |
| 21-supplies | 37 | 37 (100%) | 0 | 24 | 0 | 12 | 0 |
| 22-documents | 35 | 35 (100%) | 0 | 19 | 0 | 15 | 0 |
| 23-billing-medicare | 43 | 43 (100%) | 0 | 17 | 4 | 24 | 22 |
| 24-billing-medicaid | 39 | 39 (100%) | 0 | 20 | 4 | 17 | 0 |
| 25-remittance | 31 | 31 (100%) | 0 | 18 | 5 | 13 | 0 |
| 26-cap | 27 | 27 (100%) | 0 | 12 | 3 | 15 | 0 |
| 27-cost-report | 45 | 45 (100%) | 0 | 28 | 9 | 16 | 0 |
| 28-fhir | 35 | 35 (100%) | 0 | 18 | 8 | 16 | 16 |
| 30-quality | 60 | 60 (100%) | 0 | 36 | 3 | 24 | 0 |
| 31-portal | 53 | 53 (100%) | 0 | 25 | 13 | 28 | 0 |
| 32-ai-platform | 32 | 32 (100%) | 0 | 11 | 0 | 17 | 17 |
| 33-reporting | 42 | 42 (100%) | 0 | 22 | 10 | 20 | 0 |
| 34-saas-tenant-platform | 48 | 48 (100%) | 0 | 30 | 4 | 17 | 0 |
| 35-subscription | 50 | 50 (100%) | 0 | 30 | 15 | 19 | 0 |
| 36-messaging | 22 | 22 (100%) | 0 | 13 | 3 | 6 | 0 |
| 38-terminology | 8 | 8 (100%) | 0 | 1 | 0 | 6 | 0 |
| 39-consent | 27 | 27 (100%) | 0 | 13 | 3 | 13 | 0 |
| 40-mdm | 14 | 14 (100%) | 0 | 8 | 2 | 6 | 0 |
| bootstrap | 6 | 0 (0%) | 6 | 1 | 1 | 5 | 5 |
