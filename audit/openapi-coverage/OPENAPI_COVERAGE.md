# WardenX — OpenAPI Enrichment Coverage

> **Generated** (`bun run openapi:coverage`). Do not hand-edit — `arch:openapi-coverage`
> (in `arch:fitness`) keeps this in sync with source and enforces the ratchet.

`openapi:check` proves openapi.json was regenerated and that no enrichment targets a dead route. It does NOT prove a route carries a request contract — an unenriched route is still emitted, with no `requestBody` and a bare `200: OK`, and the generated client then types its body as `never`. This report is the coverage half.

**Totals:** 1664/1664 routes enriched (100%) · **1/949 mutating routes read a body they publish none for** · 8/670 GETs carry no response schema

`Deficit` = routes with no enrichment entry; it is the ratcheted number (see `baseline.json`). `Mut. unpublished body` counts a POST/PUT/PATCH whose HANDLER READS a payload and whose contract publishes none — `client:gen` then types that body `never`, so the generated client cannot express the call. It used to count every mutating route with no body schema, which could never honestly reach 0 (an action POST correctly publishes none) and made shipping an empty `{}` schema the cheapest way to move it — 25 routes did exactly that. The reverse direction — a published body no handler reads, which returns 200 and discards the payload — is enforced by `arch:request-body-contract`, not counted here.

| Module | Routes | Enriched | Deficit | Mutating | Mut. unpublished body | GET | GET no resp |
|---|--:|--:|--:|--:|--:|--:|--:|
| 02-identity | 53 | 53 (100%) | 0 | 33 | 0 | 16 | 0 |
| 03-authorization | 17 | 17 (100%) | 0 | 9 | 0 | 6 | 0 |
| 04-audit | 13 | 13 (100%) | 0 | 5 | 0 | 8 | 0 |
| 05-patient | 44 | 44 (100%) | 0 | 25 | 0 | 19 | 4 |
| 06-admission | 87 | 87 (100%) | 0 | 63 | 0 | 24 | 0 |
| 07-care-plan | 25 | 25 (100%) | 0 | 15 | 0 | 10 | 0 |
| 08-encounters | 39 | 39 (100%) | 0 | 23 | 0 | 15 | 0 |
| 09-assessments | 20 | 20 (100%) | 0 | 8 | 0 | 12 | 0 |
| 10-hope | 29 | 29 (100%) | 0 | 15 | 0 | 14 | 1 |
| 11-orders | 34 | 34 (100%) | 0 | 23 | 0 | 11 | 0 |
| 12-dosespot | 34 | 34 (100%) | 0 | 23 | 0 | 11 | 0 |
| 13-emar | 28 | 28 (100%) | 0 | 18 | 0 | 10 | 0 |
| 14-idg | 39 | 39 (100%) | 0 | 22 | 0 | 14 | 0 |
| 15-discipline-care-plans | 28 | 28 (100%) | 0 | 17 | 0 | 11 | 0 |
| 16-bereavement | 34 | 34 (100%) | 0 | 27 | 0 | 7 | 0 |
| 17-scheduling | 38 | 38 (100%) | 0 | 20 | 0 | 16 | 0 |
| 18-evv | 25 | 25 (100%) | 0 | 15 | 0 | 10 | 0 |
| 19-oncall | 40 | 40 (100%) | 0 | 28 | 0 | 12 | 0 |
| 20-field-safety | 33 | 33 (100%) | 0 | 17 | 0 | 15 | 0 |
| 21-supplies | 40 | 40 (100%) | 0 | 27 | 0 | 12 | 0 |
| 22-documents | 58 | 58 (100%) | 0 | 31 | 0 | 25 | 2 |
| 23-billing-medicare | 90 | 90 (100%) | 0 | 46 | 0 | 42 | 0 |
| 24-billing-medicaid | 39 | 39 (100%) | 0 | 20 | 0 | 17 | 0 |
| 25-remittance | 82 | 82 (100%) | 0 | 54 | 0 | 27 | 0 |
| 26-cap | 27 | 27 (100%) | 0 | 12 | 0 | 15 | 0 |
| 27-cost-report | 45 | 45 (100%) | 0 | 28 | 0 | 16 | 0 |
| 28-fhir | 35 | 35 (100%) | 0 | 18 | 0 | 16 | 0 |
| 29-external-interfaces | 33 | 33 (100%) | 0 | 16 | 0 | 17 | 0 |
| 30-quality | 63 | 63 (100%) | 0 | 38 | 0 | 25 | 0 |
| 31-portal | 59 | 59 (100%) | 0 | 28 | 0 | 31 | 0 |
| 32-ai-platform | 32 | 32 (100%) | 0 | 11 | 0 | 17 | 0 |
| 33-reporting | 42 | 42 (100%) | 0 | 22 | 0 | 20 | 0 |
| 34-saas-tenant-platform | 58 | 58 (100%) | 0 | 34 | 0 | 23 | 0 |
| 35-subscription | 54 | 54 (100%) | 0 | 30 | 1 | 23 | 0 |
| 36-messaging | 113 | 113 (100%) | 0 | 57 | 0 | 44 | 0 |
| 37-ipu | 52 | 52 (100%) | 0 | 34 | 0 | 16 | 0 |
| 38-terminology | 19 | 19 (100%) | 0 | 6 | 0 | 12 | 0 |
| 39-consent | 27 | 27 (100%) | 0 | 13 | 0 | 13 | 0 |
| 40-mdm | 25 | 25 (100%) | 0 | 17 | 0 | 8 | 0 |
| bootstrap | 11 | 11 (100%) | 0 | 1 | 0 | 10 | 1 |
