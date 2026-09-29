# Fitness gates: kit overview, tenancy/RLS, migration numbering

> Rationale and incident history for `check-tenancy` and `check-migration-numbering`, plus the kit overview. Moved verbatim from the repo-root `CLAUDE.md`; point-in-time narrative — generated reports under `audit/` are authoritative. Index: [`README.md`](./README.md).

### Architecture-fitness kit (enforcement code under the repo-root `architecture/`)

Note: the `architecture/` directory at the repo root holds the *enforcement code*, distinct from
the prose docs in `docs/architecture/`.

- `architecture/module-manifest.ts` (+ `.cjs`) — single source of truth for each module's
  `codePaths`, `dependsOn`, and `ownedTables` (461 tables across 40 modules).
- `architecture/.dependency-cruiser.cjs` — import-boundary rules.
- `scripts/check-table-ownership.ts`, `check-ddl-legality.ts`,
  `check-fitness-gaps.ts` (event-catalog `mN.` convention, seam-registry completeness, PHI
  RLS/audit-trigger presence — armed-inert until app source lands), `check-ui-screens.ts` —
  enforced via `package.json` scripts (`bun run arch:fitness`; UI-corpus check also standalone
  as `bun run docs:ui`).
- `scripts/check-tenancy.ts` — **tenancy & RLS invariants** (`bun run arch:tenancy`, in
  `arch:fitness`): the three-column rule, the canonical `app.org_id` session variable, the
  dangerous policy shapes ADR-0010 D3 bans, and (F-087) **RLS enabled ⇒ RLS FORCEd**. Its Rule 2 exemptions — M4 audit attribution, the M34
  key-ring SECURITY DEFINER GUCs — are scoped to the **statement** they were written for and never
  reach a policy predicate. They used to be tested against the whole FILE, and the repo's own
  convention puts a module's RLS policies in the same migration as its audit triggers
  (`*_rls_audit_triggers.sql`), so one `INSERT INTO audit_event` exempted every `app.user_id` in the
  file — policy bodies included. That is how `user_notif_pref_self` (#21: an org-unscoped `FOR ALL`
  policy on an org-scoped table, a confirmed cross-tenant read AND write) sat green in `0017` while
  the gate reported only the two migrations that happened not to contain a trigger. Policy
  predicates are now judged on the migrations' **net effect** — the files replayed in apply order,
  so a violation a later migration drops and replaces stops counting, which is what lets a
  remediated policy go green without the offending text ever leaving its original file. Deliberately
  a static replay and not a `pg_policies` read: `arch:fitness` runs where there is no database (the
  same reason the live suites are `skipIf`-guarded), so a catalog-reading gate would skip in CI —
  `m1-rls-isolation.live.test.ts` is the catalog-side complement and runs in `rls-live`. A policy
  created through dynamic SQL inside a `DO` block is the known limit, and the plain text scan still
  sees the session variables inside it.
  **Rule 4** (F-087) applies the same net-effect replay to `ENABLE`/`FORCE ROW LEVEL SECURITY`.
  ENABLE does not apply to a table's OWNER; every policy here is `TO wardenx_app` and
  `scripts/db/migrate.ts` connects as `DATABASE_ADMIN_URL ?? DATABASE_URL`, so a deployment that
  migrates with only `DATABASE_URL` set makes `wardenx_app` the owner and every policy on an
  unFORCEd table stops applying to it — and there is no flag to catch it, since the boot guard
  checks BYPASSRLS and **ownership is not BYPASSRLS**. Migration 0118 documents all of this and
  swept 370 tables; 0159 re-swept the 66 M28/M29/M35/M37 added after it; 0203 hand-patched two M24
  tables; F-087 found `fhir_read_disclosure` (0233, the M28 §164.528 disclosure ledger — the one
  table whose whole purpose is to answer "which patients did this partner read", so an unFORCEd copy
  answers a *different* tenant's disclosures to whoever asks). **Four manual re-sweeps, each found
  by querying a live schema, none of which prevented the next** — the only thing that had ever asked
  is `rls-isolation.live.test.ts`'s catalog assertion, in `rls-live`, which has no runner assigned.
  The rule MODELS the two catalog sweeps rather than hardcoding them (a statement that reads
  `relforcerowsecurity` and issues `FORCE` forces everything enabled before it), so a fifth needs no
  edit here. Its known limit is Rule 2a's mirrored: RLS enabled by dynamic SQL is invisible, which is
  a MISS and never a false alarm — partition leaves are the deliberate case (0118's event trigger
  enables and forces them at CREATE time, asserted against the catalog in the live suite).
- `scripts/check-migration-numbering.ts` — **migration ordinal uniqueness** (F-026,
  `bun run arch:migration-numbering`, in `arch:fitness`). The four-digit prefix in
  `packages/db/migrations/NNNN_name.sql` IS the migration's position in the apply order, and
  `scripts/db/migrate.ts` applies files in plain lexicographic `.sort()` order — yet nothing
  enforced that two files do not claim the same number. With a duplicate, which one runs first is
  decided by the rest of the filename (`0216_admission_…` before `0216_m36_…` because "a" < "m"),
  a coin flip nobody chose; two independent migrations survive it, a backfill and the migration
  adding the column it backfills do not. It is a WHEN on a branch-per-change workflow: every branch
  picks "the next number" against `main`, so two opened the same afternoon pick the same one — four
  audit branches had already collided in pairs on 0215 and 0216 with every gate green on all four.
  Duplicates are a hard error naming **every** claimant (the fix is a rename, and which file to
  rename is the reader's judgement); **gaps are reported, never fatal**, because a branch that
  leaves 0215 for a sibling PR and takes 0216 is doing the right thing.
