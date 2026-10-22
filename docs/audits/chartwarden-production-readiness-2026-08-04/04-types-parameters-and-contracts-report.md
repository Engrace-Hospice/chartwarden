# Types, Parameters, and Contracts Report

## Type-Safety Baseline

The forced TypeScript composite build passes with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `useUnknownInCatchVariables`. This is meaningful. It is weakened by `skipLibCheck: true`, disabled Biome `noExplicitAny` and `noNonNullAssertion` rules, and 347 `as unknown as` occurrences across 166 files. The single `@ts-expect-error` hit is an intentional type-level AI inventory test, not production suppression.

## TYPE-001 - Double assertions bypass seam and generated-client contracts

- Severity: Medium
- Priority: P2
- Confidence: Confirmed
- Category: Type safety
- Production blocker: No
- Affected workflow: Portal reads/writes, care-plan rendering, terminology queries, credential updates
- Affected persona: Staff and portal users
- Evidence: 347 double assertions; representative boundary casts listed below.
- File(s): `apps/backend/src/modules/31-portal/routes/write.routes.ts:54`; `apps/backend/src/modules/31-portal/routes/read.routes.ts:64`; `apps/backend/src/modules/31-portal/routes/session.routes.ts:58`; `apps/web/src/modules/07-care-plan/care-plan-view.tsx:123-126`; `apps/backend/src/modules/38-terminology/terminology-store-db.ts:221-315`; `apps/web/src/modules/23-billing-medicare/mac-credentials.tsx:407-410`
- Symbol(s): `arm<T>`, `getSeam`, care-plan response mapping, terminology row mapping
- Description: Generic casts permit a seam name, runtime object, and consumer view to disagree without a compiler error. Frontend casts similarly bypass generated OpenAPI types.
- Root cause: Canonical seam registry types and generated contracts do not express several richer consumer projections.
- User impact: Plausible undefined-field rendering or request/response mismatch after a producer change.
- Technical impact: Refactors remain green while runtime schemas drift.
- Security or data impact: Portal/consent seam mistakes could fail closed or hide data; an incorrect widening must not expose data.
- Recommended remediation: Add typed `getSeam` overloads/registry map; define adapters that validate/transform rows; eliminate generated-client casts route by route.
- Tests required: Compile-time contract tests, TypeBox response validation, portal disclosure negative tests.
- Dependencies: API-001 and canonical seam registry.
- Acceptance criteria: No double assertion at an HTTP, seam, DB-row, or generated-client boundary in remediated workflows.

## API-001 - OpenAPI enrichment does not guarantee request or response contracts

- Severity: High
- Priority: P1
- Confidence: Confirmed
- Category: API contracts
- Production blocker: Yes for SDK/public integration launch
- Affected workflow: All API consumers, especially M23/M27-M35
- Affected persona: Frontend users, partner integrators, SDK developers
- Evidence: 1,214/1,221 routes have enrichment entries, yet 113/697 mutating routes have no request body and 80/494 GETs have no response schema. M35 has 15 missing mutation bodies; M31 13; M33 10; M27 9. M23 has 22 GETs with no response; M28 16; M29 17; M32 17.
- File(s): `audit/openapi-coverage/OPENAPI_COVERAGE.md`; `scripts/report-openapi-coverage.ts`; generated `openapi.json`
- Symbol(s): enrichment registry and emitter
- Description: The coverage label “enriched” can still emit a client method whose body is `never` or whose response is untyped.
- Root cause: The ratchet counts an enrichment entry, while body/response completeness remains advisory.
- User impact: Frontends use assertions; external consumers cannot safely call documented endpoints.
- Technical impact: Runtime TypeBox schemas, OpenAPI, and generated TypeScript diverge.
- Security or data impact: Missing schemas weaken systematic validation review and compatibility guarantees.
- Recommended remediation: Ratchet mutation-body and success/error-response schemas to zero by launch module; generate route schemas from shared TypeBox where possible.
- Tests required: OpenAPI/runtime schema parity; generated client compile fixtures; negative request tests; error status schema tests.
- Dependencies: Module route owners, client generation.
- Acceptance criteria: All non-empty mutations publish body schemas; all business GETs and mutation success/errors publish response schemas.

## PARAM-001 - Document upload contract has no content parameter

- Severity: High
- Priority: P0
- Confidence: Confirmed
- Category: Parameter / persistence contract
- Production blocker: Yes
- Affected workflow: Document upload/versioning
- Affected persona: Intake and clinical staff
- Evidence: `POST /api/v1/documents` parses metadata only and returns 201; `uploadVersion` parses a body but passes no content; persistence writes `byteSize: "0"` and a 64-zero digest.
- File(s): `apps/backend/src/modules/22-documents/routes/documents-routes.ts:127-171`; `apps/backend/src/modules/22-documents/documents-route-service-db.ts:443-523`
- Symbol(s): `UploadDocumentRequest`, `UploadVersionRequest`, `uploadDocument`, `uploadVersion`
- Description: The boundary called “upload” cannot transfer a file, staged-upload token, object key, digest, byte count, or MIME type.
- Root cause: Metadata lifecycle was implemented before binary storage and the public contract was not gated.
- User impact: A successful action creates an unusable record.
- Technical impact: Invalid active-version rows and unrecoverable linkage to absent content.
- Security or data impact: False clinical-document completeness; potential retention/audit confusion.
- Recommended remediation: Replace with a staged, tenant-bound upload protocol or multipart endpoint; verify size, MIME, hash, malware policy, bucket key, and final object before commit.
- Tests required: See BUG-001 plus size/type limits, duplicate/idempotency, tenant-key mismatch.
- Dependencies: M22 object adapter and API-001.
- Acceptance criteria: Success proves verified bytes exist and are retrievable under authorized presign.

## Contract Trace Samples

| Workflow | Input -> client -> route -> service -> persistence -> response -> UI | Result |
|---|---|---|
| Document upload | Metadata form -> generated/manual call -> `UploadDocumentRequest` -> DB service -> zero-byte version -> 201 -> document row | **Broken at content parameter and storage commit** |
| Consent sign | UI has no capture action -> sign route -> DB service -> `lifecycleNotWired` | **Broken before persistence** |
| Medicare submit | claim detail action -> submit route -> enqueue -> M23 worker -> unbound X12/MAC port -> job failure | **Broken after accepted response** |
| Organization select | auth form -> Better Auth/session route -> active org in session -> context -> authorized route | Verified by live auth test |
| Care-plan read | generated response -> double-cast arrays -> rendered plan | Runtime works in tests; transition is **unverified by type** |

## API Route Classification

The authoritative per-method/path inventory is the generated `openapi.json` plus `audit/openapi-coverage/OPENAPI_COVERAGE.md` (1,221 routes). Static registration/auth/schema presence was checked for the entire inventory; runtime classification below avoids calling a route “fully implemented” when a normal downstream port is known to fail.

| Modules | Route count | Classification | Primary qualification |
|---|---:|---|---|
| M02-M06 | 99 | Mostly fully implemented | Auth live and strong API/DB coverage; browser E2E absent |
| M07-M14 | 202 | Mostly implemented | Clinical source routes broad; some declared cross-module consumers omitted (ARCH-001) |
| M15-M21 | 220 | Mostly implemented / selected deferred effects | Vendor/offline/auto-sync paths require launch verification |
| M22 | 35 | **Partially implemented / misleading upload** | Metadata writes live, bytes/download/render incomplete |
| M23 | 43 | **Partially implemented** | Read/config routes live; submission/ack worker path unbound; 22 GET responses undocumented |
| M24 | 39 | **Partially implemented** | Route/data surface live; state adapter not wired |
| M25 | 31 | **Partially implemented** | Worklists/cron routes exist; automatic 835 transport missing |
| M26 | 27 | Implemented, launch verification required | Cap domain/read/write surfaces present |
| M27 | 45 | **Partially implemented** | Nine mutation bodies missing; worker inputs/integrations unbound |
| M28 | 35 | Partial contract | 8 mutation bodies and all 16 business GET responses missing from OpenAPI |
| M29 | 33 | Partial contract / integration dependent | 5 mutation bodies and 17 GET responses missing; live RLS passed |
| M30 | 60 | **Partially implemented** | Route/domain surface broad; quality/CAHPS/outbreak workers incomplete |
| M31 | 53 | Partially typed | 13 mutation bodies missing; portal seam double assertions; browser E2E absent |
| M32 | 32 | **Stubbed/disabled execution** | Admin/governance routes exist; 17 GET responses missing; invocation is phase-1 shell |
| M33 | 42 | **Partially implemented** | 10 mutation bodies missing; schedule/render/delivery worker incomplete |
| M34 | 48 | **Partially implemented / P0 worker failure** | Platform/tenant routes exist; provision/key/shred/export/onboarding workers incomplete |
| M35 | 54 | Partial contract | 15 mutation bodies missing; current service lint failure |
| M36 | 22 | Partially implemented | Messaging core exists; selected source-module auto-sync hooks deferred |
| M37 | 45 | Implemented, launch verification required | Full live RLS sample passed; browser workflow absent |
| M38 | 8 | Implemented with type-risk | DB row double assertions remain |
| M39 | 27 | **Read-only/partially stubbed** | All operative lifecycle mutations throw |
| M40 | 14 | Partially implemented | Read/master-data surface broad; selected canonical writer operations report not wired |
| Bootstrap | 7 | Infrastructure | Health/metrics/root endpoints intentionally outside feature enrichment baseline |

No endpoint was classified as “missing authentication” from the registered feature inventory: shell/route authorization fitness passes. That does not replace direct negative tests for every route (TEST-002).

## Parameter Risks to Address

- Dates/times: architecture supplies org-timezone helpers, but no full browser/workflow boundary suite proves DST and payer-period behavior.
- IDs: TypeBox/UUID validation is common; generic seam casts can still pair the wrong identifier view.
- Pagination: signed/keyset cursor helpers exist; cross-restart signing is production-required by env validation.
- Tenant IDs: request handlers generally derive organization from authenticated context, not bodies; sampled RLS tests support this posture.
- Secrets: trading-partner and 2FA keys validate at production boot; `.env.example` omits the full required set (OPS-003).
