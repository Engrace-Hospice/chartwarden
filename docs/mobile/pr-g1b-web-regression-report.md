# PR G.1-B — Web non-regression report

## Compatibility audit

Before editing, inspected the real Admission Detail and F2F scheduling payloads, M6 TypeBox schemas, Drizzle services/tables, RLS context and OpenAPI enrichments. Web sends all fields targeted by this PR. The backend accepted but silently dropped some of them. Signatures, readiness, activation, benefit-period transitions, optimistic concurrency and permission checks remain in their original service paths. The web frontend was not changed.

OpenAPI comparison against `HEAD:docs/api/openapi.json`: 1,657 operations before and after; zero operations removed or added; zero request-body changes. The five enriched GETs only add optional/nullable detail properties to the existing response properties, including optional `patientId`. `bun run openapi:emit`, `bun run client:gen` and `bun run openapi:check` regenerate/check the committed contracts.

## Test evidence

| Scope | Before | After |
|---|---|---|
| M6 backend non-live certification/F2F | 78/78 pass | 78/78 pass |
| Web Admission Detail, Election & Certification, physician authority | 34/34 pass | 34/34 pass; included in the final 56/56 rerun |
| Web Admission evidence, election addendum, M22 document workflows | Not run before change | 22/22 pass; included in the final 56/56 rerun |
| M6 Election/CTI live, private PostgreSQL, app role | Not run before change | 14/14 pass; includes DB re-read, org-B denial and existing signing/conflict tests |
| M6 NOR/admission live, private PostgreSQL, app role | Not run before change | 14/14 pass; includes exact instant/name DB re-read, org-B denial and activation checks |
| M6 F2F/LOC/discharge live, private PostgreSQL, app role | Not run before change | 20/20 pass; includes requested/server window DB re-read, org-B denial and completion/signing checks |
| M6 legacy-read live, private PostgreSQL, app role | Not run before change | 12/12 pass; includes legacy `NULL` facts and org-B denial |
| Backend typecheck | Not run before change | `NODE_OPTIONS=--max-old-space-size=4096 bunx tsc -b apps/backend --pretty false` passed; the root `bun run typecheck` exceeded Node's default 2 GiB heap |
| Web typecheck | Not run before change | `NODE_OPTIONS=--max-old-space-size=4096 bunx tsc -b apps/web --pretty false` passed |

The private database container is `pgvector/pgvector:pg18` on localhost port 55432. Live suites are run sequentially as `wardenx_app` (NOBYPASSRLS), never against the shared Docker cluster. A first NOR attempt failed before tests because PostgreSQL needed more shared memory for `DROP SCHEMA`; increasing container shared memory resolved it. A first F2F attempt failed before tests due `max_locks_per_transaction`; a fresh private container with 4,096 locks resolved setup. The F2F suite then reached 19/20 with one typo in the new test (`ORG_B` constant missing); the production code did not fail, and the corrected rerun passed 20/20. `arch:migration-numbering`, `arch:tenancy`, `arch:openapi-provenance`, `arch:tables`, `arch:ddl`, `arch:audit-denylist-sync`, `arch:request-body-contract`, targeted Biome, OpenAPI check and generated-client check passed. Migration numbering caught an initial ordinal collision; the migration was moved to `1122`, and the live read suite passed again (12/12) with this final application order. Election/CTI live also passed again (14/14), including the period-date immutability assertion.

## Release gate

**GO for the validated G.1-B scope:** the final six web suites pass 56/56 against the regenerated client, all four targeted M6 live suites pass, and both backend/web typechecks pass. No snapshot was changed. Read-back tests assert new facts in database and through the service; legacy tests assert `NULL` remains unknown. The root all-project `bun run typecheck` could not run under the default 2 GiB Node heap; backend and web were instead checked separately with a 4 GiB heap. Full repository-wide tests and unrelated live suites were not executed in this targeted PR.
