# M24-1075-L6C — Trusted Medicaid ERA writer security qualification

Date: 2026-11-23
Repository: `Engrace-Hospice/chartwarden`
Branch: `audit/m24-1075-oregon-eocco-readiness`
Starting HEAD: `d48e7b934d30c1184ae60d9a6e1fc8d133f4375e`

## Disposition

`M24_1075_L6C_BLOCKED`

This lot removes the demonstrated general-platform SQL write path and disables application writes that depended on the same shared platform credential. The repository has no separate trusted evaluator runtime, isolated secret distribution, or approved independent attestation mechanism. Therefore it cannot both prevent general platform workers from forging assessments and retain a positive trusted evaluator-to-writer path. Assessment creation and mutation fail closed; no assessment is reported as evaluator-attested.

## A. Baseline and publication

- Initial branch: `audit/m24-1075-oregon-eocco-readiness` at `d48e7b934d30c1184ae60d9a6e1fc8d133f4375e`.
- Existing PR #1088 is open and Draft; issue #1075 remains open.
- GitHub reported no PR checks on the branch at qualification time.
- No rebase, force-push, merge or deployment was performed for this qualification.
- Implementation lockdown commit `7d3fb3c28c52d1721c816f2607650f4c2211f4f7` was pushed normally; PR #1088's body was updated with this report, exact gates, review disposition, and limitations. The PR remains Draft and is not merge-qualified.

## B. Existing threat model

L6B-FIX's disposable PostgreSQL probes confirmed that `chartwarden_platform_login` inherits `chartwarden_platform` table DML grants and has `BYPASSRLS`. It could insert a staged-source-bound `payment_reported` assessment, set a nested `postingAuthorized: true`, and update an existing assessment without history. The source identity trigger validated the stage linkage, not evaluator execution.

The API, generic worker and optional HL7 listener all receive `DATABASE_PLATFORM_URL` through production Compose and the shared `.env.production`. The composition root previously passed the resulting platform pool to the M25 evaluator writer. A new role/password added to that same environment would not isolate the capability. `withPlatformContext` audit records document application use; an arbitrary SQL session with the same credential bypasses that application convention.

The controls implemented here target ordinary tenant SQL and direct SQL authenticated as the general platform login. A database owner or superuser can still change grants, constraints, triggers and schema; this lot does not claim protection from those roles. A compromised general platform runtime no longer has Medicaid review table privileges, but can still exercise its unrelated existing platform privileges.

## C. Chosen security architecture

No isolated writer architecture was available to reuse. A distinct role alone was rejected because the current process topology and shared environment file would expose its credential to the same API and generic workers. A database marker, hash, `current_setting()` value, or application bypass-audit event would not prove evaluator execution. No independently controlled signing service/key infrastructure exists for a defensible evaluator attestation.

The implemented containment is least-privilege denial:

- Migration 1544 revokes all table and column INSERT/UPDATE/DELETE/TRUNCATE and related mutation privileges on Medicaid review and history from `PUBLIC`, `chartwarden_platform`, and `chartwarden_platform_login`.
- Review tables are no longer readable by the cross-tenant platform role; tenant reads continue through `chartwarden_app` RLS.
- The runtime role provisioner repeats the revocations and checks effective table- and column-level write privileges so reprovisioning cannot restore the general platform write path.
- The API composition root no longer registers an M25 review-writer platform job or passes `DATABASE_PLATFORM_URL` to the review workflow. Without an isolated writer, evaluation persistence and operator mutations return `MEDICAID_ERA_REVIEW_WRITER_UNAVAILABLE`.
- Existing rows receive `legacy_unverified`; the database does not permit a row to claim evaluator verification under this migration. Read APIs redact financial summary, payer/program, decision, match, duplicate, account, environment, digest and artifact-reference claims for legacy rows. Legacy history entries are labeled `legacy_unverified`; their reason and actor are withheld because pre-migration platform SQL could have fabricated them.
- A database CHECK rejects a nested `postingAuthorized: true` value as defense in depth. It is not treated as evaluator integrity.

The positive writer remains unavailable by design. The next safe implementation needs a separately deployed evaluator process with independently controlled secret custody, a narrow database writer interface that derives data by reloading and evaluating authenticated evidence, and verified deployment/rotation/rollback controls.

## D. Credential and runtime isolation

No new secret was created or distributed. `DATABASE_PLATFORM_URL` remains a shared general platform credential used by other modules. The future evaluator credential must not enter `.env.production` or any `env_file` shared by API/worker/listener. Deployment must provide a separately controlled service/container and restricted network path; its database login must not be assumable by `chartwarden_platform_login`. Credential creation, rotation and rollback remain unimplemented and are a blocking engineering gate.

## E. PostgreSQL enforcement

Forward-only migration `1544_m25_medicaid_era_assessment_writer_lockdown.sql` follows contract compatibility. It preserves existing records, adds `assessment_trust_status` with `legacy_unverified` as the only accepted value, adds a nonposting JSON invariant, revokes table and column-level platform writes, and removes cross-tenant platform SELECT access. It does not rewrite or delete old review/history data.

The provisioner now reapplies those revocations after its normal grant list and fails if the platform login has table- or column-level write privileges. No writer role, SECURITY DEFINER review writer, or public privileged write function was added.

## F. Trusted assessment execution

The synthetic Claim.MD stage, artifact reader, source/account evidence readers and L5 evaluator remain wired. The live test confirms the actual evaluator reaches the write boundary on a coherent synthetic fixture, after which the application returns `MEDICAID_ERA_REVIEW_WRITER_UNAVAILABLE` because no isolated writer is configured. No review/history row is created by that attempt. The prior L6B-FIX successful write result remains historical evidence only; after this migration, its records are explicitly legacy/unverified and cannot be promoted by this code.

## G. Negative security qualification

The M25 live suite attempts direct privileged assessment INSERT, UPDATE, and review-history INSERT as `chartwarden_platform_login`; each must fail with permission denied. It also checks effective platform privileges and verifies no evaluator writer role can be assumed because no such role exists. Existing tenant RLS tests continue to deny cross-tenant reads/writes. The platform role no longer has review SELECT access. The database JSON CHECK independently rejects a summary that states posting authorization true.

These checks do not constrain the database owner/superuser. They also do not establish a positive trusted-writer path, so the lot remains blocked.

## H. Idempotency, concurrency and history

The previous successful L6B-FIX test covered identical evaluation replay, notes, dispositions, stale versions and history under the application writer. Those writes are now unavailable pending isolation. This lot does not claim concurrent evaluator qualification or a positive reassessment path. Existing rows/history remain unchanged; unsupported direct platform history insertion is denied.

## I. Existing-record handling

Existing rows are preserved and assigned the migration default `legacy_unverified`; no digest match or historical application audit is accepted as proof of evaluator attestation. Tenant list/detail APIs replace old assessment and matching statuses with `unverified`, hide payer/program and stored source identity, and return `safeSummary: null`. Existing history remains unchanged in storage; the API labels it unverified and withholds the recorded reason and actor. No historical evidence is promoted.

## J. Compatibility and verification

The platform duplicate-state read path for Claim.MD remains on the existing Claim.MD store and audited source-resolution job. Medicaid review duplicate checks use the tenant RLS reader; therefore platform SELECT was unnecessary and was removed. M23/M41 workflows, payment posting contracts, M24 claim states, and financial outbox bindings were not changed.

The disposable PostgreSQL suites apply the actual ordered migration chain through 1544. M25 RLS/security suite: 30/30 passed, including platform-login INSERT/UPDATE/history-write denial and legacy detail/list/history redaction. M24 RLS suite: 70/70 passed. The runtime-role provisioner completed successfully after the M24 suite. Effective privilege query returned platform-login review INSERT/UPDATE/history INSERT as false/false/false, app review SELECT/INSERT as true/false, and table owner `postgres`. Focused M25 route/evaluator tests: 19/19 passed. Changed-file Biome and `git diff --check` pass. Full repository typecheck/architecture limitations remain separately classified; no prior OOM is treated as a pass.

Exact focused commands run:

- `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m25` — 30/30 passed.
- `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m24` — 70/70 passed.
- `PROVISION_DATABASE_URL=postgres://… CHARTWARDEN_PLATFORM_PASSWORD=<synthetic> bun run db:provision-roles` — passed; effective grants were queried afterward.
- `bunx vitest run apps/backend/src/modules/25-remittance/routes/__tests__/claimmd-era-review.routes.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-review.test.ts` — 19/19 passed.
- Changed-file `bunx biome check` — passed (7 files); `git diff --check` — passed.
- `bun run arch:tenancy`, `bun run arch:ddl`, `bun run arch:migration-compat`, `bun run arch:module-docs`, `bun run arch:migration-numbering`, `bun run arch:tables`, and `bun run arch:compliance` — passed.
- `bun run harness:phi-scan` — 13,566 files clean.
- `bun run openapi:check`, `bun run arch:openapi-provenance`, and `bun run arch:openapi-coverage` — passed after regenerating `docs/api/openapi.json` from the changed TypeBox response; `bun run client:gen` and `bun run client:check` passed after regenerating the typed client schema.
- `NODE_OPTIONS=--max-old-space-size=2048 bunx tsc --noEmit --pretty false -p apps/backend/tsconfig.json` — did not complete; Node exited 134 after reaching its configured 2 GiB heap. This is an OOM, not a pass. Full `arch:fitness` and full test suite were not run; prior dependency-cruiser OOM, missing local `uv`, pre-existing architecture parity orphans, and unavailable local Gitleaks remain qualification limitations.

## K. Remaining qualification gates

1. Implement and deploy an isolated evaluator runtime and restricted writer credential unavailable to API and general workers.
2. Prove credential separation from actual Compose/deployment secret configuration and test role assumption denial.
3. Add a positive synthetic PostgreSQL run through the isolated evaluator, atomic review/history writer and authorized operator mutation path.
4. Add conflicting-idempotency and concurrent reassessment qualification under that writer.
5. Complete L6D mounted Fastify/PostgreSQL API qualification.
6. Complete broader repository CI/architecture gates that remain resource-limited or unavailable.

Independent security follow-up confirmed that the legacy source-identity redaction closes its prior medium caveat. It also identified that legacy history could contain forged actor/reason fields from the former platform writer. The history API now marks those entries `legacy_unverified` and returns null actor/reason while preserving append-only storage. No new critical/high finding was reported. The missing isolated positive writer remains the blocking completion requirement.

The independent security and compliance reviews found no new critical/high defect in the lockdown; the fresh code review likewise found no confirmed blocking/high/critical defect in this patch. They confirm the blocked disposition because the positive isolated writer and full-repository gates remain incomplete.

External Claim.MD/EOCCO source account enrollment, real production submission provenance and payer qualification remain independent prerequisites and were not fabricated.

## L. GitHub and safety

PR #1088 remains Draft and issue #1075 remains open. No production/shared migration, deployment, merge, live vendor call, ERA retrieval, payment posting, M24 financial transition, financial outbox event, or secondary Medicaid Room & Board activation occurred. Medicaid electronic submission remains disabled.

## Historical follow-up (2026-11-24)

L6C2 implements the isolated evaluator architecture that was missing when this report was issued. The blocked disposition above remains the accurate historical L6C result. See `M24_1075_L6C2_ISOLATED_EVALUATOR_QUALIFICATION_20261124.md` for the new implementation and its independently recorded qualification limits.
