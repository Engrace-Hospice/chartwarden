# ChartWarden — Development Runbook

How to build, verify, and extend the ChartWarden monorepo. This is the Phase 0 output: a
buildable skeleton with CI-enforced architecture fitness. **No business logic yet** —
Phase 1 builds feature modules against the gates described here.

> Authority: architecture docs win over module/UI specs. The **manifest**
> (`architecture/module-manifest.ts`) is the single source of truth for what each module
> owns. See [ADR-0005](adr/ADR-0005-manifest-single-source-of-truth.md) and
> [ADR-0027](adr/ADR-0027-phase-0-toolchain-and-scaffold.md).

## Prerequisites

- **Bun ≥ 1.3** (`.nvmrc` pins Node 22 for tooling that wants it). All scripts run via `bun`.
- Optional: `dot` (Graphviz) only for `bun run arch:graph` (artifact-only; never in the gate path).

## First run

```bash
bun install            # resolves from the committed bun.lock (hoisted linker, see bunfig.toml)
bun run build          # tsc -b across the project-reference graph
bun run arch:fitness   # scaffold parity + the fitness gates (incl. report freshness checks)
bun run test           # Vitest: boot smoke test + fitness-gate self-test (red/green)
```

All four are green on a clean checkout, and CI (`.github/workflows/ci.yml`) runs them on every PR.

## The commands

| Command | What it does |
|---|---|
| `bun run build` / `typecheck` | `tsc -b` the whole graph; `clean` removes build output. |
| `bun run scaffold` | (Re)generate the tree from the manifest (idempotent; never overwrites hand-authored files). |
| `bun run arch:parity` | `scaffold --check` — fails on tree↔manifest drift or orphan packages. |
| `bun run arch:boundaries` | dependency-cruiser: module import boundaries, leaves, vendor-adapter + helper-table rules. |
| `bun run arch:tables` | table ownership — no cross-module schema access. |
| `bun run arch:tenancy` | three-column rule, canonical `app.org_id`, no dangerous RLS shapes. RLS policy predicates are judged on the migrations' **net effect** (replayed in apply order), and the rule's audit/key-ring exemptions are scoped to a single statement — never a policy body. |
| `bun run arch:ddl` | PostgreSQL DDL legality (partition keys, CHECK subqueries, duplicate enums). |
| `bun run arch:gaps` | event-catalog `mN.` naming, seam-registry completeness, PHI RLS/audit presence. |
| `bun run docs:ui` | UI screen-spec corpus consistency. |
| `bun run arch:ai-governance` | AI capability catalog ↔ per-capability docs parity (AI Governance §4.1/§4.4). |
| `bun run status:matrix` / `arch:status-matrix` | (re)generate / freshness-check the per-module implementation-status matrix (`audit/implementation-status/`); hard-fails on orphan (unowned) schema/migration tables. |
| `bun run ui:parity` / `arch:ui-parity` | (re)generate / freshness-check the UI implementation-parity report (`audit/ui-parity/`); hard-fails on duplicate screen id/path, unknown `requiredPermission`, or an unregistered `screens.ts`. |
| `bun run arch:fitness` | all of the above (parity + every fitness gate, including the report freshness checks). |
| `bun run test` | Vitest self-tests. |
| `bun run lint` / `lint:fix` | Biome — **blocking** in CI (#33). The repo's only automated a11y enforcement outside the E2E axe scans. |

> **One rule is deliberately off.** `lint/style/noUnusedTemplateLiteral` is disabled in
> `biome.json`. Backticks mark SQL in this codebase — 1676 statements across 216 files — and the
> rule fires only on the ~31 that happen to be single-line with no interpolation. Obeying it would
> make the corpus *less* consistent, and would force backslash-escaping the moment a statement
> contains a literal (SQL quotes values with single quotes). The rationale lives here because
> `biome.json` is strict JSON and cannot carry a comment.


### Local demo data (`bun run db:reset`)

`bun run db:reset` is `docker compose down -v` → `docker compose up -d postgres redis minio` →
`db:wait --expect-empty` → `db:migrate` → `db:seed:all`. **Compose is the only local provisioning
path** (F-016 / #43): there used to be a second one, a standalone `wardenx-postgres` container on
port 5440, and `db:reset` straddled both — it destroyed the 5440 volume and then migrated and seeded
the 5432 compose database, which was never reset. `db:wait --expect-empty` now asserts the database
really is empty before migrations replay, so that class of mismatch fails loudly instead of silently
seeding on top of existing data.

**Existing dev volume after the database/dev-credential rename.** The local database is now named
`chartwarden` (was `wardenx`) and the dev role passwords, MinIO credentials and compose volumes carry
the `chartwarden-` prefix (`chartwarden-compose-pgdata|minio|clamav`). A stack created before that has a
`wardenx` database with the old role passwords, so it cannot be reused: run `docker compose down -v`
(or `bun run db:reset`), optionally `docker volume rm wardenx-compose-pgdata wardenx-compose-minio
wardenx-compose-clamav` for the orphaned old volumes, re-copy `.env.example` to `.env` (or edit the
`DATABASE_*` URLs and `CHARTWARDEN_APP_PASSWORD` by hand), then `bun run db:migrate && bun run db:seed:all`.
The seeds still delete the legacy `wardenx-demo` organization if one is found.

`cp .env.example .env` is sufficient; the full onboarding runbook is
[`docs/START_PROJECT.md`](./START_PROJECT.md).

The fourteen seed steps live in `db:seed:all`, their own script, so CI's `e2e` job seeds through
exactly the chain `db:reset` runs rather than a copy of it that can drift. Two prerequisites are not
enforced by the chain itself and each one aborts it partway:

- **The backend must already be running** (`bun run dev:backend`). Only the first few steps talk to
  Postgres directly; the rest drive the real REST API as signed-in demo users, precisely so RLS,
  ABAC and the state machines are exercised rather than bypassed.
- **`REDIS_URL` must be set for that backend.** `db:seed:scenario-billing` reaches M27's
  `refresh-inputs`, which enqueues a trial-balance pull; with no queue connection the port is
  unbound and the step fails.

CI runs all of this: the `e2e` job migrates, boots the backend, runs `db:seed:all` and drives the
18-spec Playwright suite against it, so a break in the demo-data path is now reported rather than
found by the next person who tries to bring the stack up.

Roles matter in the seeds because they matter in the product. `db:seed:staff` creates ten discipline
personas (`CREDENTIALS.local.md`), and the scenario seeds sign in as whichever one is actually
entitled to each action — the physician signs the §418.22(c) certifications, the RN case manager
holds the caseload, the administrator does intake and activation. A seed that signs everything as
the administrator does not work, and should not: `cti.is_hospice_md` is an attribute gate, and no
number of permission keys satisfies it.

The fitness gates are **armed-but-inert**: they pass with no source and begin enforcing
automatically as a module's schema/seams/events land.

### Runtime login roles (deployment precondition)

The migrations define NOLOGIN carrier roles only — deployment (or a local full-stack run) must
provision the LOGIN credentials the backend's optional pools connect as:

```sh
PROVISION_DATABASE_URL=postgres://postgres:...@host/db \
CHARTWARDEN_PLATFORM_PASSWORD=... CHARTWARDEN_DESTRUCTION_PASSWORD=... \
bun run db:provision-roles
```

creates `chartwarden_platform_login` (inherits the enumerated `chartwarden_platform` carrier + the
BYPASSRLS **attribute** — attributes are not inherited, so it sits on the login role) and
`chartwarden_destruction_login` (`IN ROLE chartwarden_destruction`, migration 0157, NOBYPASSRLS). Then set
`DATABASE_PLATFORM_URL` (admin console, platform crons, the outbox relay's org enumeration, the
M34 offboarding eraser, **and every per-tenant PHI cipher**) and `DATABASE_DESTRUCTION_URL`
(right-to-erasure over the append-only clinical/billing tables + `audit_event`). Without them the
affected paths refuse loudly — the boot log says exactly what is off.

**Message attachments (M36 WP 1.5) in the compose stack.** `docker compose up` starts a `clamav` sidecar (clamd on the
compose network only; config `deploy/clamav/clamd.conf`; signature DB in the `chartwarden-compose-clamav` volume, downloaded on
first start, a minute or two) and sets `MESSAGING_ATTACHMENT_SCANNER=clamd` on api and worker. api/worker only wait for it to
*start*: until clamd answers, attachments stay `pending` (nothing is delivered). For a quick run without ClamAV set
`MESSAGING_ATTACHMENT_SCANNER=builtin ALLOW_BUILTIN_ATTACHMENT_SCANNER=1` in `.env` (EICAR + type check, not an antivirus).
The compose api/worker also get `DATABASE_DESTRUCTION_URL` (the eraser and the orphan reaper need it), and the `migrate` step
runs `bun run ops:backfill-tenant-buckets`, which creates the `tenant-<orgId>` bucket for every org that lacks it (re-run it
any time; it is idempotent). Upload also creates a missing bucket on demand, and answers a typed 503 naming the bucket if it
cannot. An existing dev volume predating the destruction role needs `docker compose build migrate && docker compose run --rm migrate`
once (it provisions `chartwarden_destruction_login`); do not run host `db:migrate` against that stack.

**The PHI-cipher half is easy to miss, so it is spelled out (F-082).** Migration 0052 §5 REVOKES
`chartwarden_app`'s SELECT on `tenant_key_ring` by design — the request path reads only the
ciphertext-free metadata view — so the platform login is the only credential that can resolve a
wrapped tenant DEK. With `DATABASE_PLATFORM_URL` unset, `dekForOrg` refuses and so does everything
composed over it: M8's HearthNote narrative (an encounter cannot be FINALIZED, and therefore never
reaches signing), M27's raw cost-report payloads, M29's stored HL7 payloads, M31's portal contact
ciphers, M39's consent notes. Each answers a fail-closed 503 naming the DEK, which reads the same
whether the KEK, the credential, or the key ring itself is what is missing. `M34_TENANT_KEK` (the
platform key that WRAPS the DEK, `.env.example`) is required alongside it, and `bun run db:seed`
provisions the demo org's `tenant_account` + `tenant_key_ring` through the same SECURITY DEFINER
function the production provision worker calls — it skips with a printed note when no KEK is set. Re-running the script rotates passwords; a missing grant
surfaces as a 42501 and is fixed by one reviewed line in
`scripts/db/provision-runtime-roles.ts`, never a blanket `ALL`.

### DocLens locally (F-236, [ADR-0048](./adr/ADR-0048-doclens-docling-plus-grounded-extractor.md))

DocLens is Docling (the `docling-worker` compose service, CPU-only) plus an M32 extractor that quotes each
value; M22 grounds the quote against Docling's text. Every model call goes through the governed M32
pipeline, which is only **built** when a backend is configured and only **dispatches** when every gate
passes. To run it end to end against a local model:

1. **Local models.** Run Ollama on the host and pull the models the registry keys name:
   `ollama pull llama3.1:8b-instruct-q8_0` (classify, extract, SUD screen) and `ollama pull qwen2.5vl:7b`
   (stage-5 vision double-check, F-237). Give the `api` and `worker` services (a local, git-excluded
   `docker-compose.override.yml` is the place):
   `OLLAMA_BASE_URL=http://host.docker.internal:11434`,
   `OLLAMA_MODELS=local-llama-3.1-8b-instruct=llama3.1:8b-instruct-q8_0,local-qwen2.5-vl-7b-instruct=qwen2.5vl:7b`,
   `OLLAMA_NUM_CTX=16384`.
   (Claude instead: `ANTHROPIC_API_KEY`, plus `ANTHROPIC_BAA_REFERENCE` and an unexpired
   `ANTHROPIC_ZDR_CONTRACT_REF` / `ANTHROPIC_ZDR_EXPIRES_AT` — without them every call refuses, D19.)
2. **Register** with `DATABASE_ADMIN_URL` set: `bun run db:sync:ai-capabilities`, then
   `bun run db:sync:ai-backends` (same `OLLAMA_*` env as above but reachable from the host, plus
   `OLLAMA_LICENSES="local-llama-3.1-8b-instruct=Llama 3.1 Community License Agreement,local-qwen2.5-vl-7b-instruct=Apache-2.0"`). The worker's
   health sweep marks the backend `healthy` within a minute.
3. **Enable for the demo org only:** `bun run db:seed:scenario-doclens-ai` — flags `ai.full` +
   `documents.doclens`, the hash-pinned prompt templates, PILOT + a pilot-enrolled `local_only` opt-in, and
   a token budget. Undo with `DOCLENS_AI=off`. Nothing here is a production promotion.
4. **A reviewer:** `bun run db:seed:scenario-doclens` (needs `DATABASE_PLATFORM_URL`, `M34_TENANT_KEK`,
   `BETTER_AUTH_URL`). Upload a PDF/fax via `POST /api/v1/document-uploads` → `…/complete`, create the
   batch with `POST /api/v1/intake/uploads {documentId, patientId}`, then
   `POST /api/v1/intake/uploads/:id/extraction/run` (202, queued; the worker runs it).
5. **Review** in the web app at `/intake` (F-237): the queue, then the side-by-side workspace — page image
   with each value's box, per-field accept / edit / reject after a source-view check, the stage-5 vision
   result, and the 42 CFR Part 2 SUD banner (confirm / reject before completing).
6. **ICD-10-CM** (F-238, for diagnosis coding checks): `db:seed:all` already seeds a small ICD-10-CM and LOINC
   starter subset (`scripts/db/lib/terminology-starter-set.ts`) so the pickers work offline; DocLens coding checks
   then run against that subset. `bun run db:load:icd10cm` with `DATABASE_ADMIN_URL` set — downloads the CDC/NCHS
   FY2026 + FY2027 releases (checksum-pinned, cached in `.cache/`) into M38 and replaces the subset in place.
   On a database with no ICD-10-CM version at all the intake job skips the coding checks and says so
   (`coding.status: icd10cm_not_loaded`).
   The docling-worker OCRs with Tesseract by default (`DOCLING_OCR_ENGINE=easyocr` to switch back).
   A synthetic 21-page complex referral packet + answer key lives in
   `apps/backend/__tests__/fixtures/doclens-complex-packet/` (regenerate with
   `services/docling-worker/.venv/bin/python scripts/doclens/make-complex-packet.py <dir>`).

## How to add a module (Phase 1+)

1. **Confirm the manifest.** The module's `codePaths`, `dependsOn`, and `ownedTables` are
   already in `architecture/module-manifest.ts`. If a new table or dependency is needed, that is
   a deliberate architecture change — one consolidated ADR per module (ADR-0005 D5), then edit the
   manifest. Never reshape the manifest to fit code.
2. **Generate any missing dirs:** `bun run scaffold` (creates only what's missing).
3. **Schema** → `packages/db/src/schema/<module>.ts` as `export const x = pgTable("x", …)` for
   each `ownedTable`. Add `organization_id` (+ `provider_entity_id`/`location_id` on PHI tables),
   RLS keyed only on `app.org_id`, and an M4 audit trigger. `arch:tenancy`/`arch:ddl`/`arch:gaps`
   begin enforcing immediately.
4. **Cross-module reads** go through a **seam** (interface in `@chartwarden/types`, registered in
   `apps/backend/src/bootstrap/seams/`, validated by `validateSeams()`) or an **outbox event**
   (`mN.<resource>.<verb>`) — **never** a direct schema import. Neither adds a `dependsOn` edge
   (ADR-0005 D1).
5. **Routes** under `apps/backend/src/modules/NN-slug/`, each behind
   `requirePermission`/`requireAbac`; emit audit events; register the module's eraser with M4.
6. **UI** per `docs/design/screens/*` using the declared layout pattern (`docs:ui` stays green).
7. **Tests** (Vitest) including RLS cross-tenant isolation. Keep the fitness fixtures red.
8. **Regenerate the freshness-checked reports and commit them:** `bun run status:matrix && bun run ui:parity`.
   Adding schema/routes/screens makes `audit/implementation-status/` and `audit/ui-parity/` stale, so
   `arch:status-matrix` / `arch:ui-parity` (inside `arch:fitness`) go red until the committed reports are
   regenerated. (Their failure output also prints the exact command to run.)
9. Run `bun run build && bun run arch:fitness && bun run test` before opening the PR.

See the per-module Definition of Done in
[`IMPLEMENTATION_ROADMAP.md`](./IMPLEMENTATION_ROADMAP.md).

## Layout

```
apps/        backend (Fastify host + src/bootstrap + src/modules/NN-slug), admin (M34), portal (M31)
packages/    leaves (shared, types, domain, ui); foundation (db, audit, auth, tenancy);
             + one package per spec'd domain area (see manifest codePaths)
architecture/ module-manifest.ts (source of truth) + .dependency-cruiser.cjs (generated rules)
scripts/     fitness gates + the scaffold generator; __fixtures__ (gate red-proofs); __tests__
```

## Proving the gates work

`scripts/__tests__/fitness-gates.test.ts` runs each gate against a one-violation fixture in
`scripts/__fixtures__/` and asserts it goes **red**, then asserts **green** at the repo root. If
you weaken a gate, a fixture test fails — that's the regression net.

## Enforcement model (free / private repo — no GitHub branch protection)

GitHub branch protection + rulesets require a paid plan on private repos, so `main` is protected by
three free layers instead:

1. **CI on every PR** — `.github/workflows/ci.yml` runs `build-and-verify` (install → `tsc -b` →
   `arch:fitness` → `vitest`) on each PR. The green/red status is visible before you merge.
2. **Local pre-push hook** — `.githooks/pre-push` blocks a **direct push to `main`** unless the full
   fitness suite passes. Activate once: `bun run setup:hooks` (auto-runs via the `prepare` script on
   `bun install`). Emergency bypass: `git push --no-verify` or `SKIP_FITNESS=1 git push`.
3. **PR discipline** — always merge via a PR after CI is green (see `plans/ARCHON_RUN_TRACKER.md`).

This isn't server-enforced (a paid plan would add that), but it catches the realistic failure modes:
broken code reaching `main` by direct push, and red PRs (CI flags them). If you later upgrade, enable a
ruleset requiring the `build-and-verify` check — the command is in the run tracker's notes.
