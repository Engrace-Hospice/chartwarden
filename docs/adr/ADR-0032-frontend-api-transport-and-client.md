# ADR-0032 — Frontend API transport: REST/OpenAPI-from-TypeBox + generated typed client

- **Status:** **Accepted** — ratified 2026-06-20 by the Frontend/Architecture Owner (human sign-off per
  ADR-0030 line 40). Authorizes F0 (Frontend Foundation) to proceed and the toolchain additions below.
- **Date:** 2026-06-20
- **Phase:** pre-build governance (blocks the Frontend Foundation step F0; affects every module that
  ships `apps/web` / `apps/admin` / `apps/portal` screens).
- **Extends:** [ADR-0030](ADR-0030-core-frontend-app-ownership.md) (owns *where* frontend code lives —
  `apps/web` sub-path carve, M1 shell + screen registry, per-module `apps/web/src/modules/NN-*`); this
  ADR decides *how* that code talks to the backend, and refines ADR-0030's import-boundary clause.
- **Extends:** [ADR-0027](ADR-0027-phase-0-toolchain-and-scaffold.md) (ratified toolchain: Bun, TS
  project refs, TypeBox, Fastify, Vitest); this ADR adds the frontend build/codegen tools.
- **Depends on:** [ADR-0005](ADR-0005-manifest-single-source-of-truth.md) (LEAF set is fixed; adding a
  leaf needs its own ADR — avoided here by siting the client in `packages/ui`).

## Context

ADR-0030 established the *home* for frontend screens (`apps/web`, M1 shell + a screen registry, each
module owns `apps/web/src/modules/NN-*`) but is **silent on transport** — how a screen reaches its data.
Its boundary bullet says a web slice "may import **its own backend module's published surface**." Taken
literally that invites a compile-time import edge from `apps/web` into `apps/backend`, which would:

- couple the frontend to backend *source* (not a versioned contract), and
- make a frontend PR able to break a backend build — defeating the "frontend is additive" goal.

Meanwhile the codebase has facts that decide the transport for us:

- **The backend is Fastify 5 REST**. Each route *module* defines **TypeBox** request schemas
  (`apps/backend/src/modules/*/routes/*-typebox.ts`) but validates them **manually** via a
  `parse(Schema, body)` helper — the schemas are **not** attached to Fastify's `schema:` option. There
  is **no tRPC** anywhere in the backend.
- **Consequence (verified F0-T01):** because no route declares a Fastify `schema`, `@fastify/swagger`
  would emit a **contract-less** document. "OpenAPI for free" is therefore **not** available without
  first wiring schemas into every route — a cross-cutting change to gate-green backend code that would
  break the "frontend is additive / no backend behavior change" invariant. That wiring is **deferred**
  to a backend follow-up (see Consequences); F0 generates the contract a different way.
- **`packages/ui` ships a `trpc-provider`** placeholder (Phase 0) that contradicts the REST backend.
- TypeBox schemas **are** JSON Schema objects, so they can be embedded into an OpenAPI document
  **directly** (without Fastify) by a standalone generator that reuses the same exported schemas.

So the open decision is: tRPC (rejected — backend isn't tRPC), direct source-import of the backend
module's surface (rejected — couples + breaks additivity), or **generate a typed client from the
serialized OpenAPI contract**.

## Decision

**The frontend↔backend contract is the generated OpenAPI document; the client is generated from it,
never hand-written, and the frontend never compile-imports `apps/backend`.**

1. **Contract.** A **standalone generator** (`scripts/openapi/`, `bun run openapi:emit`) emits an
   **OpenAPI 3.1** document (`docs/api/openapi.json`). It **auto-discovers** every route by scanning the
   backend source for `app.<method>("…")` (the coverage source of truth) and layers request/response
   detail from an **enrichment registry** that reuses the same exported TypeBox schemas the handlers
   validate against. **No backend route file is modified** — the additivity invariant holds. CI guard
   `bun run openapi:check` (in `arch:fitness`) fails on duplicate operationIds, an enrichment targeting a
   non-existent route, an invalid schema, or a stale committed `openapi.json`.
2. **Client.** Generate a typed REST client from `openapi.json` (`openapi-typescript` for types +
   `openapi-fetch` for the runtime) into the **`packages/ui` leaf** at `packages/ui/src/api/`. It is a
   type surface + a thin `fetch` wrapper (auth/correlation-id headers, the existing degraded-state
   hooks). Regenerated, never edited.
3. **Site it in `packages/ui`, not a new leaf.** A dedicated `packages/api-client` leaf would require
   amending `LEAF_PACKAGES` — itself an ADR (ADR-0005). `packages/ui` is already a leaf with no runtime
   deps; the client (type-only + fetch) keeps it one. Every web slice + the shell already import
   `packages/ui`, so the client reaches everyone **with no new `dependsOn` edge**.
4. **Remove the `trpc-provider` placeholder** from `packages/ui/src/providers`; replace with the client
   provider.
5. **No tRPC.** Rejected: the backend is REST/TypeBox; introducing a tRPC router would duplicate the
   contract surface and re-platform 7+ shipped modules' routes for no benefit.

### Refinement of ADR-0030's boundary clause

ADR-0030 said a web slice may import "its own backend module's published surface." **Clarified:** that
"published surface" is the **generated client methods for that module's routes** (reached via the
`packages/ui` leaf) — **not** a source import of `apps/backend/src/modules/NN-*`. The frontend's only
contract with the backend is `openapi.json`. This is a refinement, not a reversal: ADR-0030 stays the
owner of *placement*; ADR-0032 fixes the *mechanism* to a no-edge generated client.

### Toolchain additions (extending ADR-0027)

- **OpenAPI generator:** no new dependency — `scripts/openapi/` reuses `@sinclair/typebox` (already a
  root dep) + `node:fs`. (`@fastify/swagger` is **not** adopted now; it belongs to the deferred
  route-wiring follow-up below.)
- `openapi-typescript` + `openapi-fetch` (client codegen + runtime, frontend).
- **Vite** as the `apps/web` build tool (React 18, already the `packages/ui` runtime).

## Consequences

- **Frontend is provably additive.** `arch:boundaries` keeps `packages/ui` (and the client in it) a
  leaf; there is no import path from `apps/web` to `apps/backend`. A frontend PR cannot break a backend
  fitness gate. This is the invariant the Frontend Integration plan relies on.
- **One contract, two sides, no drift.** Client regenerates from `openapi.json`; a backend route/schema
  change that breaks a screen surfaces as a **client type error at build**, not a runtime 4xx.
- **Server stays the only enforcement point.** The client carries no authz; PHI screens call routes
  already gated by the module's permission keys. No new authz surface on the frontend.
- **Removing `trpc-provider` is a breaking change to `packages/ui`'s exports** — but it has no
  consumers yet (web slices are placeholders), so the blast radius is zero.
- **On ratification:** F0 (Frontend Foundation) may proceed — emit OpenAPI, generate the client, build
  the M1 shell + screen registry, implement the layout-pattern components, drop `trpc-provider`. No
  manifest codePath flips and no screens are part of F0. See
  `docs/plans/FRONTEND_INTEGRATION_PLAN.md`.
- **`docs/api/openapi.json` is a generated artifact** — committed for client codegen + review diffs,
  regenerated by `bun run openapi:emit`, never hand-edited.
- **New backend routes must keep the contract in sync:** adding a route makes `openapi:check` (in
  `arch:fitness`) fail until `bun run openapi:emit` is re-run; request/response detail is added to the
  enrichment registry (`scripts/openapi/enrichments.ts`). This obligation joins the per-module template.
- **Deferred backend follow-up (own task/PR):** wire the TypeBox schemas into Fastify's `schema:`
  option (with `@fastify/type-provider-typebox` + `@fastify/swagger`) so the contract is produced from
  the routes themselves and Fastify validates at the edge — then **reconcile** `@fastify/swagger` output
  against `docs/api/openapi.json` and retire the standalone enrichment registry. This is a real backend
  change (validation/error-envelope flow across all route modules) and is intentionally kept **out of
  F0** to preserve the additivity invariant. Tracked in `docs/plans/FRONTEND_INTEGRATION_PLAN.md`.

## References

- ADR-0030 (frontend app ownership), ADR-0027 (toolchain + scaffold), ADR-0005 (LEAF set / no-edge).
- Frontend Integration plan (`docs/plans/FRONTEND_INTEGRATION_PLAN.md`).
- Backend transport evidence: `apps/backend/package.json` (Fastify 5, no tRPC),
  `apps/backend/src/modules/*/routes/*-typebox.ts` (TypeBox per-route schemas).
- Placeholder to remove: `packages/ui/src/providers/trpc-provider.tsx`.
