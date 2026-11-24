# M24-1075-L6C2 — Isolated evaluator qualification

Date: 2026-11-24
Branch: `audit/m24-1075-oregon-eocco-readiness-r2`
Starting HEAD: `a351bd19f5aef9ec58c05f9114a8d96f424f797e`

## Decision and boundary

The L6C2 writer and integration-test blockers are closed for the declared threat model: ordinary tenant SQL, the shared platform SQL login, and API callers cannot write evaluator assessments; the runtime performing evaluation has a distinct narrowly privileged login and receives only bounded authenticated commands. The database owner/superuser, evaluator runtime itself, and infrastructure administrator remain trusted. This report does not claim protection against those authorities.

The functionality remains nonposting. `postingAuthorized` is false, and this path has no payment-posting, claim-state-transition, submission, vendor transport, or financial-outbox operation.

## Architecture and trust model

The public API signs only evaluate, note, and nonposting-disposition commands using an Ed25519 key. A short-lived JWS binds the operation, exact command-body digest, user, membership, session, and organization. The isolated M25 evaluator verifies the signature, rejects replay, re-reads the active session, membership, effective permission, and provider reach, then invokes the existing L5 workflow. The command contains no assessment, payer, matching, or financial-summary fields.

The evaluator uses three separate database connections: application-scoped reads, source-artifact reads, and review writes. Migration 1546 provisions the NOBYPASSRLS evaluator role; migration 1547 adds a separately restricted Claim.MD staged-artifact reader and durable idempotency table. The shared application and platform logins cannot write assessment/history rows or assume the evaluator/source roles. The source role cannot select raw inbox ciphertext directly; its security-definer function checks the stage, tenant, provider, delivery, vendor, account, environment, and digest before returning the staged ciphertext projection. This reader is tuple-scoped rather than actor-bound; only the isolated evaluator receives the source credential and artifact keyring.

`isolated_evaluator` identifies the process and database principal through which a review was evaluated and persisted. It is not a cryptographic signature over the stored assessment row. The database owner, superuser, evaluator host administrator, and a compromise of the evaluator remain trusted. An upstream evidence change after the final reinspection and before writer commit can leave a stale nonposting snapshot; consumers must re-evaluate before any future downstream use.

## Database changes

- Migration 1546 creates the isolated evaluator carrier and scoped review/history grants.
- Migration 1547 adds the restricted staged-source reader roles/function and review idempotency reservations. It is forward-only and classified `contract`.
- Both migrations were applied in order on the fresh disposable PostgreSQL environment used by the live suite. Existing review history is retained; historical rows remain `legacy_unverified` and are not promoted.
- RLS and FORCE RLS remain in place for tenant review data. The live suite uses the NOBYPASSRLS application role for tenant assertions and exercises direct-write and role-assumption denial for the shared platform login.

No shared or production database was used.

## Runtime qualification

The live run set `M25_TEST_EVALUATOR_CONTAINER=1`, `M25_TEST_POSTGRES_CONTAINER=chartwarden-l6c2-pg`, and `M25_EVALUATOR_TEST_IMAGE=wardenx-api:latest`. It launched the evaluator as a separate Docker container on a Docker `--internal` network with no published ports, read-only root filesystem, a 16 MiB no-exec `/tmp`, dropped capabilities, `no-new-privileges`, a 64-process limit, 1536 MiB memory and one CPU. Secret files were mounted read-only; inspection asserted the expected mounts, absence of the Docker socket and production env file, absence of database credentials/keyring in environment variables, internal network, read-only root filesystem, and empty port bindings.

The image tag was an existing local `wardenx-api:latest`; the test mounted the current worktree's backend source, packages, and `node_modules` read-only because rebuilding the image had previously exceeded the local build window. The test drove the evaluator's loopback HTTP handler through `docker exec` with request data on stdin. It did not publish an evaluator port or use host-network access. It did not exercise the full production Compose overlay or a separate API container reaching the evaluator over the Compose service network; those remain deployment qualification tasks.

## Results

- Live M25 PostgreSQL/RLS suite: **30/30 passed**, with migrations applied through 1547. This included the actual evaluator entrypoint, actual M25 reader and Claim.MD staged store, X12 835 parsing, L5 assessment, restricted writer, durable review and history, and container isolation assertions.
- The positive flow verified the staged artifact digest, source vendor/account/environment, organization/provider scope, payer/program facts, review assessment fingerprint, nonposting status, initial version and history. An identical replay created no duplicate history; a changed evaluation used the versioned path; stale writes and conflicting idempotency-key replay were rejected. Authorized note/disposition actions persisted, and unauthorized actions did not mutate the review.
- When submission provenance was incomplete, the service persisted a nonposting hold rather than manufacturing a matched production claim. Synthetic test fixtures were confined to the disposable database.
- Negative cases verified tenant-role and shared-platform direct INSERT/UPDATE/history writes are refused, platform role assumption is refused, foreign artifact tuples return no source rows, expired/forged actors are refused after current-authority resolution, and source credentials cannot read raw staging tables directly.
- Focused unit suites: **15/15 passed** for signed command validation, body binding, replay handling, and session-store expiry behavior.
- Changed-file Biome: passed.
- Architecture checks passed: table ownership, DDL legality, tenancy/FORCE RLS, migration numbering and compatibility, manifest mirror, compliance, Compose policy, architecture sync, architecture docs, ADR docs, module docs, live-suite coverage, outbox bindings, and route reachability. Architecture docs reported three pre-existing warning-only missing verification stamps. Test-typecheck coverage passed for all 3,584 files across two Vitest projects.
- `bun run openapi:check` and `bun run client:check` passed. The evaluator Compose profile validated with synthetic interpolation values; inspection confirmed the evaluator receives its separate secrets and has no published port. Changed-file Biome, the staged PHI scan, and `git diff --check` passed.
- The backend project build (`timeout 300s`, `NODE_OPTIONS=--max-old-space-size=2048`, `bunx tsc -b apps/backend/tsconfig.json --pretty false`) exited 134 with a V8 heap OOM at the 2 GiB limit after about 87 seconds; an earlier 120-second bounded run timed out without diagnostics. Neither is a pass. A separate strict, no-emit typecheck over the changed evaluator/review source graph and its imports passed under the same 2 GiB cap; this is targeted evidence, not a full backend project build. Full repository typecheck, full `arch:fitness`, and dependency-cruiser were not completed in this qualification. Local Gitleaks and `uv` are unavailable. The full unit suite was not rerun.
- At final local inspection, PR #1115 CI had passed the deploy-script/Compose dry run, PostgreSQL image smoke/CVE scan, ClamAV image smoke/CVE scan, and Docling worker pytest. The Docling image CVE scan was still queued. The PR is not represented as fully CI-qualified here.

## Review findings

Fresh code and security reviews found no confirmed High/Critical issue in the L6C2 changes. They retained two bounded Medium observations: (1) the upstream-evidence inspection-to-commit window can produce a stale but nonposting snapshot; (2) qualification evidence must be reported with the actual conditional container mode, migrations, and runtime mounts. The report now records that mode and its limitations. The first issue is documented in ADR-0115 and requires re-evaluation before future downstream use.

## External and deployment limits

There is still no verified production EOCCO enrollment, authenticated production Claim.MD source-account binding, real M24 submission provenance, payer-certified institutional format, or qualified live 835 delivery route. Stedi JSON remains unavailable to the raw X12 parser. No EOCCO certification, vendor sandbox qualification, production authorization, operator worklist, live ERA retrieval, or production posting is established. L6C2 closes only the isolated writer and successful synthetic PostgreSQL integration-test blockers; F09 remains open.

## Safety confirmation

Medicaid submission remains disabled. No Stedi, Claim.MD, OHA, or EOCCO request occurred. No real ERA was retrieved, no payment was posted, no M24 financial state transition or financial outbox event was produced, no unverified payer/enrollment/rate/authorization evidence was promoted, and no production migration or deployment occurred.
