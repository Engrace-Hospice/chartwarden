# Repository and Architecture Map

## Repository Map

```text
WardenX
|-- apps
|   |-- backend       Fastify API, composition root, BullMQ workers, module routes
|   |-- web           Staff/clinical/revenue React SPA
|   |-- portal        Patient/family portal React SPA
|   `-- admin         Platform operations React SPA
|-- packages
|   |-- db/tenancy    Drizzle schema, migrations, RLS session envelopes
|   |-- auth/audit    Identity, RBAC/ABAC, read/write audit controls
|   |-- domain/types  Shared domain primitives and contracts
|   |-- ui/shared     UI system and non-domain utilities
|   `-- 40-module domain and integration packages
|-- architecture      Manifest, dependency-cruiser, ownership/fitness policy
|-- scripts           Generators, migrations, status and conformance gates
|-- docs              Authoritative architecture, ADRs, module and UI intent
|-- audit             Generated matrices and earlier point-in-time reviews
|-- .github/workflows CI plus image-build/push deployment skeleton
`-- Dockerfile/compose Shared API-worker image and local dependency topology
```

## Applications

| Application | Entry point | Responsibility | Internal/public interfaces | Status |
|---|---|---|---|---|
| `apps/backend` | `src/index.ts`, `src/worker.ts` | Fastify API and worker composition | 1,221 OpenAPI routes; module seam registry; BullMQ queues | Active, broad runtime wiring incomplete |
| `apps/web` | `src/main.tsx` | Staff EHR SPA | 244 registered screens; generated OpenAPI client | Active; several workflows read-only or backend-blocked |
| `apps/portal` | `src/main.tsx` | Patient/family/telehealth portal | 13 registered screens, M31 APIs | Active; production integration not E2E-proven |
| `apps/admin` | `src/main.tsx` | Cross-tenant platform console | 14 registered screens, M34/M35 platform APIs | Active; tenant operations workers incomplete |

## Package Responsibilities

Every package exports through its `src/index.ts` package boundary unless noted. Architecture fitness reported 10,014 modules and 30,078 imports with no dependency-cruiser violations.

| Packages | Purpose / consumers | Status |
|---|---|---|
| `db`, `tenancy` | Schema, migrations, pools, RLS org/platform/report sessions; consumed by backend repositories | Active; clean migration and sampled live RLS pass |
| `auth`, `audit` | Better Auth, RBAC/ABAC, step-up, audit redaction/read accounting | Active; auth live suite passes with required test key |
| `types`, `shared`, `domain`, `forms`, `ui`, `narrative-vocab` | Shared kernel, money/date helpers, domain contracts, form primitives, design system | Active; some boundary casts remain |
| `assessments`, `hope`, `orders`, `dosespot`, `emar`, `idg`, `discipline-plans`, `bereavement`, `scheduling`, `inpatient` | Clinical domain cores | Active; not all browser workflows proven |
| `supplies`, `messaging`, `triage-vendors`, `evv-aggregators` | Field/operations and adapters | Active; selected auto-sync/provider hooks deferred |
| `billing`, `cap-management`, `cost-report`, `medicaid-adapters`, `x12-837-client`, `x12-835-client`, `xero-client`, `gusto-client` | Revenue-cycle domain and external transports | Domain cores active; several transports/workers unbound |
| `fhir`, `iqies-client`, `telehealth-client`, `routing-client`, `intake-extraction` | External interface clients and pipelines | Mixed; some fail-closed adapters or feature flags |
| `quality`, `cahps-vendors`, `reporting` | HQRP/QAPI/CAHPS and analytics | Domain cores active; important worker ports and vendor adapters incomplete |
| `ai-platform`, `hearthnote` | AI governance, capability inventory, prompt/domain helpers | Phase-1 shell; no live general provider dispatch |
| `saas-tenant-platform`, `subscription-billing`, `admin-ui-shell` | Tenant lifecycle, commercial billing, platform UI | Routes/UI active; M34 operational workers materially incomplete |
| `consent`, `mdm`, `terminology` | Consent policy types, master data, reference terminology | Read paths active; consent writes incomplete |

## Intended Architecture

- **Style:** contract-first modular monolith with independently owned domain packages and a single Fastify composition root.
- **Dependency direction:** application adapters depend on leaf contracts; cross-module reads use registered seams; write propagation uses transactional outbox events.
- **Persistence:** PostgreSQL 18/Drizzle; one owning module per table; forward-only migrations; organization-scoped RLS plus audited platform bypasses.
- **Security boundary:** Better Auth session -> active organization -> RBAC -> named ABAC -> database RLS. High-risk operations add recent step-up and ceremonies.
- **Runtime topology:** API role, worker role, PostgreSQL, Valkey/BullMQ, MinIO/S3-compatible object storage, optional external payer/vendor/provider endpoints.
- **Presentation:** three React/Vite SPAs consume the generated OpenAPI client; registered screens carry required permissions.
- **Auditability:** request correlation, PHI-safe structured logs, route read-audit metadata, DB audit triggers, append-only event/outbox ledgers.

## Actual Runtime Topology

The API and worker use one image with different entry points. API-only replicas avoid queue construction; worker/all roles create M23/M25/M27/M30/M33/M34 and clinical cron workers when `REDIS_URL` is present. The outbox dispatcher separately requires `DATABASE_PLATFORM_URL`. The topology is sound, but many worker dependency bags contain lazy throws, so process health does not imply workload health.

## Architecture Conformance Matrix

| Area | Intended design | Actual implementation | Status | Evidence | Required action |
|---|---|---|---|---|---|
| Module imports | Manifest-enforced dependency direction | Dependency-cruiser passes 10,014 modules/30,078 edges | Conformant | `bun run arch:fitness` | Preserve gate |
| Table ownership | Exactly one module owns each table | Ownership/DDL checks pass 453 tables | Conformant | `architecture/module-manifest.ts`; fitness output | Preserve gate |
| Tenant isolation | Org context + FORCE RLS; audited platform bypass | Clean migration; baseline 109 and M29/M35/M37 live tests pass | Conformant, sampled | `packages/db/migrations/__tests__/*live.test.ts` | Run complete matrix before release |
| Authorization | Session -> RBAC -> ABAC -> RLS | 168 named predicates; 215 guards; auth live suite passes | Conformant | `scripts/check-abac-predicates.ts`; `auth.live.test.ts` | Add browser denial tests |
| Outbox | Every declared consumer live or durably deferred | Only two live consumers and four deferred event types configured; default marks others complete | High-risk divergence | `apps/backend/src/index.ts:2915`; dispatcher `:277` | ARCH-001 |
| Workers | Queue availability means processor dependencies are live | Workers register with lazy-unbound ports | High-risk divergence | `apps/backend/src/index.ts:2502-2689` | FLOW-001/002/006 |
| API contracts | Runtime schema, OpenAPI, client agree | 113 mutation bodies and 80 GET responses absent from OpenAPI | Drifted | `audit/openapi-coverage/OPENAPI_COVERAGE.md` | API-001 |
| Document lifecycle | Bytes + metadata committed with verified digest | Metadata-only `201`, zero byte/hash; signed URL route uses refusing presigner | High-risk divergence | M22 DB service `:443-523`; module index `:39-55` | BUG-001 |
| Consent | Operative consent lifecycle with capture evidence and DEK | Reads live; every lifecycle write throws | Missing | M39 DB store `:338-380` | FLOW-003 |
| AI | Governed provider-neutral invocation | Capability shell and deny-stubs; no live provider dispatch | Partially conformant | M32 invocation service `:252-281` | AI-001 |
| UI registry | Permissioned, reachable screens | 271 routes resolve permissions | Conformant structurally | `audit/ui-parity/UI_PARITY.md` | Add functional/E2E status |
| Visual fidelity | Built screens reconciled to design frames | 17 mapped, 3 matched, 14 partial; 254 untracked | Partially conformant | frame-fidelity report | UI-001 |
| Deployment | Signed, promoted, validated release | Build/push-only skeleton, no deploy target | Missing | `.github/workflows/deploy.yml:3-12` | OPS-001 |

## External Integrations

| Integration | Adapter state |
|---|---|
| PostgreSQL / Valkey | Locally exercised; production HA/load not evidenced |
| MinIO/S3 | SigV4 object adapter exists; document route upload/presign composition remains incomplete |
| Better Auth / passkeys / TOTP | Implemented and live-tested locally |
| X12 837 / MAC / HETS | Client contracts and fail-closed adapters exist; worker transports not bound |
| X12 835 | Default client rejects `X12_835_WORKER_NOT_WIRED` |
| Medicaid state endpoints | Oregon adapter metadata exists; I/O methods throw `ADAPTER_NOT_WIRED` |
| CAHPS vendors | Vendor packages exist; live export/config/decryption paths incomplete |
| FHIR / external interfaces | Large route surface; 16-17 GET response schemas absent per module |
| AI providers | Governance/capability registry exists; general live invocation provider absent |
