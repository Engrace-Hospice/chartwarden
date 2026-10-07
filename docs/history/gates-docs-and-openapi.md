# Fitness gates: docs corpora, OpenAPI, UI/status reports

> Rationale for the architecture/module/ADR doc gates, status matrix, OpenAPI provenance/coverage, UI parity and frame fidelity. Moved verbatim from the repo-root `CLAUDE.md`; point-in-time narrative — generated reports under `audit/` are authoritative. Index: [`README.md`](./README.md).

- `scripts/check-architecture-docs.ts` — **architecture-corpus freshness gate**
  (`bun run arch:architecture-docs`, in `arch:fitness` since 2026-08-14). The authority rule makes
  `docs/architecture/` binding, yet it was the only ungated documentation body and drifted for two
  months (63 dead cited paths, stale companion citations — see
  `audit/ARCHITECTURE_DOC_CONSISTENCY_AUDIT_2026-08-13.md`). Enforces: cited repo paths exist
  (paths on a line that says they don't exist are exempt — documented absence is correct), version
  headers parse (filename-version drift needs the "FILENAME still reads" note), `Companion to:`
  citations match on-disk header versions, and four-digit `ADR-NNNN` citations resolve
  (ARCHITECTURE §21's short `ADR-00N` open-decision register is a separate, deliberately ungated
  namespace). Warn-only `<!-- verified-against: sha · date -->` staleness stamps. The six build
  divergences the 2026-08-13 audit surfaced are recorded as ADR-0036…0040 (+ ADR-0030/0032/0035
  for the frontend stack).
- `scripts/check-module-docs.ts` — **module-spec corpus gate** (`bun run arch:module-docs`, in
  `arch:fitness`). Different contract from the architecture gate because specs are PROPOSALS:
  no cited-path rule (planned paths are legal); enforces index parity (40 rows ↔ 40 files),
  the **re-lock-in-place versioning convention** (filename version is pinned; the HEADER is
  authoritative and the index "Spec ver" column must track it — it sat 1–2 re-locks stale for
  26 of 40 modules before this gate), four-digit ADR-citation resolution (audit-era
  "ADR-NNNN / ARCH-nnn" composite citations exempt as a historical namespace), relative-link
  integrity, and the "implementation proposal" authority marker every spec now carries.
- `scripts/check-adr-docs.ts` — **ADR corpus gate** (`bun run arch:adr-docs`, in `arch:fitness`).
  ADRs are immutable once Accepted, so this never checks prose freshness — it checks the corpus as
  a decision REGISTER: contiguous unique numbering 0001…max, index parity, a parseable Status line
  (Accepted/Proposed/Superseded/Rejected/Deprecated; Superseded must cite its successor), the
  index row's status cell AGREEING with the file (a decision must not sit formally Proposed while
  the register calls it Accepted), cross-citations and links resolving. Code-vs-Decision
  compliance is the audit layer (audit/ADR_COMPLIANCE_AUDIT_*.md), not this gate.
- `scripts/audit-fitness.ts` — point-in-time enforcement audit (module matrix, table
  ownership, dependency graph/cycles); writes `audit/FITNESS_ENFORCEMENT_AUDIT.md`.
- `scripts/report-implementation-status.ts` — per-module **implementation-status matrix**
  (spec/schema/migration/routes/screens/tests/adapter per module). A green `arch:fitness`
  proves architecture coherence, NOT feature-completeness — this advisory report shows build
  progress. Regenerate with `bun run status:matrix`; `arch:fitness` runs it in `--check` mode
  (`arch:status-matrix`) to keep `audit/implementation-status/` fresh and to hard-fail on orphan
  (unowned) schema/migration tables. Writes `audit/implementation-status/IMPLEMENTATION_STATUS.md` (+ `.json`).
  The **`Enriched` column is a ratio** (`n/m`), joined route-by-route against the enrichment
  registry — it used to be a per-module boolean that flipped ✅ on a single entry anywhere in the
  module (M06 once sat at 6-of-46 showing ✅). As of the **2026-08-01 enrichment sweep every 🟢
  *feature* module reads a full-ratio ✅** (0 unenriched routes; M01 Foundation reads ❌ because it
  owns tables but no feature routes). The **`Live` column** (owned tables named in a
  `*.live.test.ts`) is likewise full-ratio ✅ for every 🟢 module now — **20 modules carry executed
  cross-tenant RLS suites** (M1–M14, M17, M18, M22, M27, M34, M36, M38, M39, M40, plus M4/M5/M7/
  M15/M16/M19–M21/M23–M26/M30/M32/M33). Both columns are advisory; `arch:openapi-coverage` is what
  fails the build.
- `scripts/check-openapi-provenance.ts` — **OpenAPI schema-provenance gate** (`bun run
  arch:openapi-provenance`, in `arch:fitness`). Three rules over `scripts/openapi/enrichments.ts`.
  **Rule 1** — no local name bound by two imports (#31: `TenantExportJobListResponseSchema` is
  exported by both the platform and tenant typebox files, the second binding won, and a CROSS-TENANT
  ops list published the tenant-scoped shape). **Rule 2** — a route's schema must come from its own
  directory or an ancestor, never a sibling surface. **Rule 3 (F-061/#156)** — one entry per
  `METHOD /path` key. That is rule 1 one level up and it went unasked for the registry's whole life:
  the file is a base literal plus 47 `Object.assign(ROUTE_ENRICHMENTS, {...})` blocks, so a second
  entry REPLACES the first wholesale rather than extending it. **441 keys were declared twice, 422 of
  the pairs disagreeing, and 62% of the base literal was unreachable text.** No gate could see it:
  `openapi:check` regenerates from the map `Object.assign` left behind, `arch:openapi-coverage`
  counts routes with *no* entry, `client:check` runs downstream of resolution, and rule 2 itself read
  the same collapsed `Map` — every gate ran on what survived and none asked what was discarded. It is
  not merely dead text. A superseded schema is worse than a wrong one — wrong somewhere a reader will
  still find it, right nowhere anything checks: M7's shadowed care-plan DTO declared
  `requiredSignerSet: Type.Array(Type.String())` while the wire had always sent `{ role, count }`,
  and two screens were written from it (#155). And the shadowing quietly DEGRADED the published
  contract 123 times, where a later block re-summarised a route it did not know was already
  documented — those summaries were restored onto the surviving entries rather than deleted with the
  duplicates. There is **no allowlist**, and the one shape that could argue for one is banned with
  it: an entry that extends an earlier one via `...ROUTE_ENRICHMENTS["<its own key>"]` (17 M32 routes
  did, and they published correctly) makes a key's value depend on block ORDER — the property that
  failed — and is indistinguishable at a glance from the 424 that were silently clobbered. With one
  entry per key, extending it means editing it.
- `scripts/report-openapi-coverage.ts` — **OpenAPI enrichment-coverage report + ratchet**
  (`bun run openapi:coverage`; `arch:openapi-coverage` runs `--check`). `openapi:check` proves
  openapi.json was *regenerated* and that no enrichment targets a dead route — it says nothing
  about the reverse, so an **unenriched route is legal** and a routes task can ship 30+ routes
  carrying zero request contracts with every gate green (this is what M20-T06 did). The emitted
  contract does not look absent, it looks *satisfied*: `emit.ts` still writes those routes with
  `parameters: []`, no `requestBody`, and a bare `200: OK`, and `client:gen` types their bodies
  as `never`. This gate ratchets, per module, the count of routes with **no** enrichment entry
  against `audit/openapi-coverage/baseline.json`: the deficit may never **rise** (new routes must
  ship their contracts), and when it **falls** the baseline must be re-tightened
  (`bun run openapi:coverage --update`) so progress is locked in. A module absent from the
  baseline has an implied floor of **0** — a brand-new module's first unenriched route fails.
  The 2026-08-01 sweep retro-enriched the corpus from **478 unenriched → 6** (only bootstrap's
  health/infra routes remain unenriched; the current ratio is in the generated report, not here) and
  re-tightened the baseline — the gate never *required* that backfill, but the progress is now
  locked in. Writes
  `audit/openapi-coverage/OPENAPI_COVERAGE.md` (+ `.json`).
  `client:check` (generated typed client ↔ openapi.json) is now in `arch:fitness` too.
- `scripts/report-ui-parity.ts` — **UI implementation-parity report**: bridges the documented
  screen-spec corpus (`docs/design`) and the implemented web surface (registered `screens.ts`), so a
  green `docs:ui` is not mistaken for "the UI is built". Regenerate with `bun run ui:parity`;
  `arch:fitness` runs it in `--check` mode (`arch:ui-parity`) to keep `audit/ui-parity/` fresh and
  to hard-fail on duplicate screen id/path, an unknown `requiredPermission`, or a `screens.ts` not
  wired into `main.tsx`. Writes `audit/ui-parity/UI_PARITY.md` (+ `.json`).
- `scripts/report-frame-fidelity.ts` — **frame-fidelity report**: tracks how far each *built* screen
  has been visually matched to its Pencil frame — the layout-fidelity gap the R0/R1 Lantern
  reconciliation left open (it matched the design *language*, not each screen's *composition*). The
  hand-maintained `scripts/frame-fidelity/registry.ts` maps a built screen → its `SCREENS.md` frame
  node → status (`pending`/`partial`/`matched`); the process is in
  `docs/design/FRAME_FIDELITY_PLAYBOOK.md`. Regenerate with `bun run frame:fidelity`; `arch:fitness`
  runs `--check` mode (`arch:frame-fidelity`) to keep `audit/frame-fidelity/` fresh and to hard-fail
  on an unknown frame node, a duplicate mapping, or a dangling screen id. Writes
  `audit/frame-fidelity/FRAME_FIDELITY.md` (+ `.json`).

- **`check-module-docs` rule 6, BANNED (GAP-180).** ADR-0010 D2 bans `app.tenant_id` / `withTenantContext`
  (canonical: `app.org_id` / `withOrgContext`), yet the M22/M25/M05/M11/M29 specs and the module-29 task
  docs still prescribed them in ~90 code samples — an implementer following one writes an RLS policy on a
  GUC nothing sets. They are normalised (including `tenant_id` columns in the M22/M25 policy prose), and
  the gate now fails any module doc that prescribes either spelling; a line that says the token is
  banned/removed/renamed (the M02/M31 changelog rows) is exempt (`scripts/lib/banned-rls-tokens.ts`).
- **`check-ui-screens` check 6, STATUS PARITY (GAP-186).** `ui:parity` only counts specs against screens.
  `docs/design/SCREEN_SPEC_STATUS.md` is the per-spec join — one row per indexed spec, `built` / `partial` /
  `deferred`, the registered screen set(s) (`<app>/<module-dir>`, validated against `ui-parity.json`) and,
  for every spec with no screen (wound care, prior auth, grievances, accreditation, OIG, the six external
  portals, …), the reason. `docs:ui` fails on a missing/duplicate/orphan row, an unknown screen set, or a
  deferred row without a reason.
- **GAP-179 / GAP-187 / GAP-188 (stale prose).** The frame-fidelity notes for the eMAR, Encounter and
  Patient-chart frames described unbuilt write paths / unbound reads that exist (the eMAR `AdministerModal`,
  the bound HearthNote selections, the care-plan and admission chart cards); `DEFERRED_SCREENS.md` no longer
  calls read-only M26 "done" or restates a screen count; the `main.tsx` composition-root headers no longer say
  nothing is registered; the M23 boot comment, the M22 eraser and the dead `M39_CONSENT_CONSUMER_DEFERRED`
  constant no longer describe live wiring as unbound.
