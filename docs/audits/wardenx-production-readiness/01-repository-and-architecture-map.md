# 01 — Repository & Architecture Map

**Audit date:** 2026-08-03 · **Branch:** `main` @ `91e5b09` · Bun 1.3.5 / Node v25.8.0, darwin.

## Toolchain & topology
- **Monorepo:** Bun workspaces — `apps/*` (4) + `packages/*` (48). 119 root scripts. The `apps/`+`packages/` tree is **generated from `architecture/module-manifest.ts`** via `bun run scaffold`; the `arch:parity` gate keeps tree ↔ manifest 1:1 (48 packages + 4 apps verified).
- **Migrations:** 154 SQL files in `packages/db/migrations`, frontier `0153` (M37).
- **Build/test baseline (this audit):** `bun install --frozen-lockfile` ✓ · `bun run build` ✓ · `bun run arch:fitness` (17 gates) ✓ · `bun run test` → 6,746 passed / 927 skipped / 12 todo ✓.

## Applications
| App | Purpose | Entry / composition root | Notes |
|---|---|---|---|
| `apps/backend` | Fastify API, all 40 modules | `src/index.ts` (~2,271 lines) + `src/bootstrap/` kernel | Single process also hosts BullMQ workers (only if `REDIS_URL` set). No worker/deploy artifact. |
| `apps/web` | Staff clinical SPA (React) | `src/main.tsx`, registry `src/shell/screen-registry.ts` | 242 registered screens; single 1.53 MB chunk. |
| `apps/portal` | Patient/family SPA (M31) | own registry `src/screens/manifest.ts` | 13 screens; invisible to UI gates. |
| `apps/admin` | Platform console (M34/M35) | `src/modules/35-subscription-billing/screens.ts` | 14 screens; invisible to UI gates. |

## Packages (48)
Leaf/shared: `types` (seam interfaces, error taxonomy), `auth` (RBAC/ABAC registry + permission catalog), `db` (Drizzle schema + 154 migrations), `shared`, `domain`, `ui` (design system + generated API client). Per-module domain packages: `billing`, `medicaid-adapters`, `cost-report`, `cap-management`, `remittance` (in `billing`), `quality`, `cahps-vendors`, `inpatient`, `subscription-billing`, `fhir`, `consent`, `mdm`, `terminology`, `messaging`, `reporting`, `saas-tenant-platform`, `ai-platform`, `hope`, `assessments`, `orders`, `dosespot`, `emar`, `idg`, `scheduling`, `evv-aggregators`, `discipline-plans`, `bereavement`, `supplies`, `triage-vendors`, `forms`, `hearthnote`, `narrative-vocab`, `intake-extraction`, `admin-ui-shell`, `tenancy`, `audit`. Vendor clients: `x12-835-client`, `x12-837-client`, `iqies-client`, `gusto-client`, `xero-client`, `routing-client`, `telehealth-client`.

## Runtime topology
```
Browser SPAs (web / portal / admin)
   └─ generated typed client (packages/ui/src/core/api) ─ HTTP ─▶ apps/backend (Fastify, single process)
                                                                     ├─ bootstrap kernel: env gate, auth plugin, request-context,
                                                                     │   read-audit, error-handler, security (rate limit), idempotency
                                                                     ├─ 40 module route mounts (Drizzle route services) — when DATABASE_URL set
                                                                     ├─ wireModuleSeams / wireModuleErasers  ⚠ many bound to in-memory (ARCH-003/007)
                                                                     ├─ transactional outbox: WRITE side only ⚠ no dispatcher (OPS-001)
                                                                     └─ BullMQ workers (in-process, only if REDIS_URL) ⚠ several catalogs never constructed
   Postgres (RLS + M4 audit triggers) · Redis/BullMQ · (MinIO/object store: in-memory in prod ⚠)
   Platform DB (DATABASE_PLATFORM_URL, separate pool) — admin console / platform crons
```

## Boundary-enforcement kit (the "gates")
`architecture/module-manifest.ts` (codePaths / dependsOn / ownedTables — 453 tables) + `architecture/.dependency-cruiser.cjs` (import rules). `bun run arch:fitness` chains: scaffold-parity → boundaries (dependency-cruiser) → table-ownership → tenancy → ddl-legality → fitness-gaps (event-catalog / seam-registry / phi-guards) → ai-governance → plan-integrity → status-matrix → ui-parity → frame-fidelity → design-tokens → abac-predicates → docs:ui → openapi:check → openapi-coverage → client:check.

**Seam system:** `bootstrap/seams/registry.ts` — `REQUIRED_SEAMS` (~155 registered / 87 consumed per gate output), `registerSeam` = last-wins `Map.set` (no owner check — ARCH-012), `getSeam` throws pre-registration, `validateSeams()` backfills fail-closed deny-stubs. `wireModuleSeams(deps)` runs before route mounting.
**ABAC:** `packages/auth/src/abac/registry.ts` — single-owner named predicates; the registry throws on duplicate but the per-module registrars swallow collisions with `if (has(name)) continue` (ARCH-002).
**Production switch:** there is **no `NODE_ENV` gating of implementations**; everything keys off `const dbHandle = process.env.DATABASE_URL ? createDbClient() : undefined` (`index.ts:1256`). `assertProductionEnv()` validates env vars only.

## Architecture conformance matrix

| Area | Intended design | Actual implementation | Status | Evidence |
|---|---|---|---|---|
| Module import boundaries | Enforced by dependency-cruiser + manifest | Clean for `import`/raw-SQL; **blind to `schema.<table>`** style (~35 escapes) | Drifted | ARCH-017 |
| Cross-module reads via seams | Producers stand real impls over deny-stubs | ~15 modules stand **in-memory** impls in prod | High-risk divergence | ARCH-003 |
| Right-to-erasure | Per-DataClass eraser over Drizzle | ~25 erasers over in-memory Maps in prod | High-risk divergence | ARCH-007 |
| Auth-plane audit durability | All audit to `audit_event` | M3/M4 route sinks in-memory in prod | High-risk divergence | ARCH-006 |
| Effective-permission resolution | One DB-backed resolver | Two abstractions; M3 routes use empty `_fixedPerms([])` | Drifted | ARCH-015 |
| Transactional outbox | Emit → relay → consumer | Emit only; **no relay** | Missing | OPS-001 |
| ABAC single-owner predicates | Registry throws on dup | Registrars silently first-win | High-risk divergence | ARCH-001/002 |
| Tenant isolation (FORCE RLS) | Every RLS table FORCEd | Only partition leaves post-0118 | Drifted | DB-002 |
| Route services over Drizzle+RLS | All 40 modules | ✓ confirmed (in-memory route scaffolds retired) | Conformant | API inventory; ARCH-note-8 |
| Idempotency / concurrency | DB-backed idempotency + If-Match | ✓ Postgres-backed globally | Conformant | `index.ts:1455` |
| Type safety | strict TS, no `any` | ✓ `tsc -b` clean, zero real `any` | Conformant | types report |
| Money/decimal discipline | decimal strings / integer cents | Mostly; 3 float edges in M25/M23/M26 | Partially conformant | PARAM-003 |
| Deployment / DR | Blue-green + pgBackRest (docs) | No artifacts; docs reference nonexistent tooling | Missing | OPS-012/016 |
| Duplicate money kernels | one shared kernel | 3 verbatim copies (billing/cost-report/cap) | Duplicated | ARCH-021 |
| AI capability governance | one catalog joined to runtime | 3 parallel registries, no join, no seed path | Drifted | ARCH-019 |

## Verified-fixed since prior audits (representative)
migrate.ts idempotency + tracking table + NOBYPASSRLS healing (DB-001); M2 identity Drizzle-bound with audit INSERT policy (mig 0119); `membershipId` populated end-to-end (ARCH-010); break-glass durable + non-null target with regression tests (SEC verified-fixed 1); M26 request validation wired (types verified-fixed); `org_admin` role defined/seeded/synced (ARCH-022 residual); CI now runs a live-Postgres RLS matrix (tests verified-fixed).
