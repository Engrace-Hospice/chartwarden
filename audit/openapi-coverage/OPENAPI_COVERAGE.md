# WardenX — OpenAPI Enrichment Coverage

> **Generated** (`bun run openapi:coverage`). Do not hand-edit — `arch:openapi-coverage`
> (in `arch:fitness`) keeps this in sync with source and enforces the ratchet.

`openapi:check` proves openapi.json was regenerated and that no enrichment targets a dead route. It does NOT prove a route carries a request contract — an unenriched route is still emitted, with no `requestBody` and a bare `200: OK`, and the generated client then types its body as `never`. This report is the coverage half.

**Totals:** 1268/1273 routes enriched (100%) · **1/715 mutating routes read a body they publish none for** · 7/525 GETs carry no response schema

`Deficit` = routes with no enrichment entry; it is the ratcheted number (see `baseline.json`). `Mut. unpublished body` counts a POST/PUT/PATCH whose HANDLER READS a payload and whose contract publishes none — `client:gen` then types that body `never`, so the generated client cannot express the call. It used to count every mutating route with no body schema, which could never honestly reach 0 (an action POST correctly publishes none) and made shipping an empty `{}` schema the cheapest way to move it — 25 routes did exactly that. The reverse direction — a published body no handler reads, which returns 200 and discards the payload — is enforced by `arch:request-body-contract`, not counted here.

| Module | Routes | Enriched | Deficit | Mutating | Mut. unpublished body | GET | GET no resp |
|---|--:|--:|--:|--:|--:|--:|--:|
| 02-identity | 24 | 24 (100%) | 0 | 14 | 0 | 7 | 0 |
| 03-authorization | 17 | 17 (100%) | 0 | 9 | 0 | 6 | 0 |
| 04-audit | 13 | 13 (100%) | 0 | 5 | 0 | 8 | 0 |
| 05-patient | 14 | 14 (100%) | 0 | 5 | 0 | 9 | 0 |
| 06-admission | 49 | 49 (100%) | 0 | 35 | 0 | 14 | 0 |
| 07-care-plan | 19 | 19 (100%) | 0 | 13 | 0 | 6 | 0 |
| 08-encounters | 36 | 36 (100%) | 0 | 22 | 0 | 13 | 0 |
| 09-assessments | 19 | 19 (100%) | 0 | 7 | 0 | 12 | 0 |
| 10-hope | 20 | 20 (100%) | 0 | 10 | 0 | 10 | 0 |
| 11-orders | 28 | 28 (100%) | 0 | 18 | 0 | 10 | 0 |
| 12-dosespot | 31 | 31 (100%) | 0 | 21 | 0 | 10 | 0 |
| 13-emar | 28 | 28 (100%) | 0 | 18 | 0 | 10 | 0 |
| 14-idg | 30 | 30 (100%) | 0 | 17 | 0 | 10 | 0 |
| 15-discipline-care-plans | 28 | 28 (100%) | 0 | 17 | 0 | 11 | 2 |
| 16-bereavement | 33 | 33 (100%) | 0 | 26 | 0 | 7 | 0 |
| 17-scheduling | 32 | 32 (100%) | 0 | 18 | 0 | 13 | 0 |
| 18-evv | 25 | 25 (100%) | 0 | 15 | 0 | 10 | 0 |
| 19-oncall | 39 | 39 (100%) | 0 | 27 | 0 | 12 | 0 |
| 20-field-safety | 30 | 30 (100%) | 0 | 17 | 0 | 12 | 0 |
| 21-supplies | 37 | 37 (100%) | 0 | 24 | 0 | 12 | 0 |
| 22-documents | 38 | 38 (100%) | 0 | 21 | 0 | 15 | 0 |
| 23-billing-medicare | 43 | 43 (100%) | 0 | 17 | 0 | 24 | 0 |
| 24-billing-medicaid | 39 | 39 (100%) | 0 | 20 | 0 | 17 | 0 |
| 25-remittance | 32 | 32 (100%) | 0 | 19 | 0 | 13 | 0 |
| 26-cap | 27 | 27 (100%) | 0 | 12 | 0 | 15 | 0 |
| 27-cost-report | 45 | 45 (100%) | 0 | 28 | 0 | 16 | 0 |
| 28-fhir | 35 | 35 (100%) | 0 | 18 | 0 | 16 | 0 |
| 29-external-interfaces | 33 | 33 (100%) | 0 | 16 | 0 | 17 | 0 |
| 30-quality | 60 | 60 (100%) | 0 | 36 | 0 | 24 | 0 |
| 31-portal | 53 | 53 (100%) | 0 | 25 | 0 | 28 | 0 |
| 32-ai-platform | 32 | 32 (100%) | 0 | 11 | 0 | 17 | 0 |
| 33-reporting | 42 | 42 (100%) | 0 | 22 | 0 | 20 | 0 |
| 34-saas-tenant-platform | 50 | 50 (100%) | 0 | 31 | 0 | 18 | 0 |
| 35-subscription | 54 | 54 (100%) | 0 | 30 | 1 | 23 | 0 |
| 36-messaging | 22 | 22 (100%) | 0 | 13 | 0 | 6 | 0 |
| 37-ipu | 50 | 50 (100%) | 0 | 33 | 0 | 15 | 0 |
| 38-terminology | 14 | 14 (100%) | 0 | 3 | 0 | 10 | 0 |
| 39-consent | 27 | 27 (100%) | 0 | 13 | 0 | 13 | 0 |
| 40-mdm | 14 | 14 (100%) | 0 | 8 | 0 | 6 | 0 |
| bootstrap | 11 | 6 (55%) | 5 | 1 | 0 | 10 | 5 |
