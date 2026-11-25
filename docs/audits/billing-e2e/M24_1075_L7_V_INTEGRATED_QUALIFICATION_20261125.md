# M24-1075-L7-V — Integrated Medicaid ERA Review Qualification

- Date: 2026-11-25
- Branch: `audit/m24-1075-oregon-eocco-readiness-r2`
- Starting HEAD: `f9f36ae5348a70191560968725c5e9537c49bcc1`
- Target: `main` at preflight `5d1892511e439acbb35f61aef3cb7cce4fbbf1ed`
- PR: [#1115](https://github.com/Engrace-Hospice/chartwarden/pull/1115), Draft

Latest fetched `origin/main` after the qualification run: `2a62721330`; GitHub reported PR #1115 `MERGEABLE`/`CLEAN` before this L7-V publication. No rebase was needed or performed.

## Scope and preflight inventory

The cumulative PR changes M5/M6/M23/M24/M25/M40, the M25 evaluator runtime, X12 837I and 835 packages, database migrations 1535–1548, backend permissions and seams, the web billing workflow, Compose, API/client contracts, compliance controls, and qualification documentation. There are no migrations after 1548 in this branch. PR #1088 is closed and superseded. At preflight the worktree was clean, the branch matched its remote, and the PR was open/Draft. The five reported PR checks (Postgres image smoke, ClamAV image smoke, Docling CVE scan, Docling worker pytest, and deploy/Compose dry run) passed; no full CI workflow was attached to this HEAD.

Available host resources at preflight: 15 GiB RAM, 6.2 GiB available, swap 4 GiB with 3.9 GiB in use, and 77 GiB free disk. A shared `os-postgres-1` container was running; it is outside this qualification and will not be used. Existing local `wardenx-api` and `wardenx-web` images predate this source tree and are not immutable-image evidence.

| Gate | Coverage | Existing evidence | New execution plan |
|---|---|---|---|
| X12 `BodyInit` source graph | `packages/x12-837-client` | L6D diagnostic did not reproduce at L7; the L3 X12/M23/M41 regression covered 12 files/312 tests on unchanged shared-X12 sources. | Full workspace typecheck below; no cast or suppression added. |
| L7 reassessment | Seven mounted Medicaid review operations and signed evaluator path | Stub-route test was insufficient by itself. | M25 live/API/evaluator/database/browser suite passed 30/30, including reassessment, authorization, replay, legacy/source holds, changed evidence and evaluator failure. |
| PostgreSQL M24/M25/M40 | Ownership, RLS, evidence reads/writes | Previous lot reports were scoped. | Private PostgreSQL suites: M24 70/70, M25 30/30 (actual evaluator/API/browser mode), M40 15/15. Shared `os-postgres-1` was not used. |
| M24 submission evidence | M24 → M25 read seam and lineage | L6D reports five filtered live cases. | `bun run test:m24:remittance-feedback:live`: 45/45 on private PostgreSQL. |
| Migrations and role provisioning | Fresh and representative upgrade, 1535–1548, contract hold, grants | Earlier live migration suite passed 17/17 for fresh chain, historical 1508 upgrade, rerun and contract hold. | Additional `origin/main`→PR upgrade: 793 target migrations, then 12 PR migrations; strict checks reported zero drift/orphans; rerun applied zero. Runtime-role provisioner succeeded twice; exact production Compose topology remains blocked by an unavailable pinned SeaweedFS image. |
| Immutable runtime images and Compose | API, web, evaluator overlay, secrets and recovery | API and web test images built locally; API ran immutable with no source mounts in the integrated test harness. | Actual API/evaluator container integration passed using the local immutable images. Compose syntax/dry-run passed. Full production base/overlay runtime was not completed: pinned SeaweedFS pull timed out; official web image build stalled on dependency download. This is not immutable release-topology qualification. |
| Real browser-to-database journey | Web → mounted API → isolated evaluator → PostgreSQL | L7 browser/axe previously used synthetic API responses. | Real synthetic Playwright journey passed inside the M25 live suite against the current web/API test images, evaluator HTTP runtime and disposable PostgreSQL; desktop/mobile screenshots and axe checks are retained in ignored scratchpad. It does not qualify the blocked full Compose release topology. |
| `bun run lint` | Full repo Biome | Changed-file lint had passed. | Passed once on the integrated worktree: 10,993 files, no fixes. |
| `bun run typecheck` | Workspace build plus test type programs | Prior OOM evidence was historical. | Passed once with workspace build and all 8 test shards plus DOM shard; exit 0, no diagnostics. |
| `bun run test` | Full configured Vitest suite | L7 targeted 93 tests passed. | One bounded full run completed: 3,025 files passed, 4 failed, 556 skipped; 61,040 tests passed, 4 failed, 9,859 skipped, 16 todo. Failures: M36 mention autocomplete timed out (it passed in the targeted rerun); `scaffold-parity` saw ignored generated `packages/domain` and `packages/admin-ui-shell` in the primary workspace (standalone parity passed in a clean snapshot); Linux GNU `env` does not implement the BSD `env -S -P` behavior this test asserts (reproduces in isolation); and the new Medicaid ERA CSS used uppercase styling (fixed; sentence-case guard passed afterward). No second full run was started. |
| `bun run arch:fitness` | All 50 gates, including boundaries, tenancy, migrations, Compose and generated checks | Initial aggregate was 44/50. Dependency-cruiser completed 10,465 modules/48,335 dependencies with no violations; four generated reports were then refreshed and their direct checks passed. `arch:docling-lock` passed with temporary `uv`. | The aggregate was not repeated. `arch:parity` passes in a clean snapshot (47 packages + 4 apps). Its primary-workspace failure is caused by ignored generated directories. A broad fitness-gates self-test rerun in a temporary worktree reported a boundary failure because the `node_modules` symlink resolved package sources back into the main checkout; this is an invalid isolated topology, not evidence of a source boundary violation. |
| Full PHI and secret scan | Repository source and fixtures | L7 scoped PHI passed. | Full PHI scan passed over 13,639 files; report also passed directly. Pinned Gitleaks source scan reports two findings identical to `origin/main`; they remain unresolved baseline findings and are not silently waived. Final scan after this report edit is recorded below. |
| PR CI and docs/client/migration gates | Targeted public contracts and branch CI | Five PR image/deploy-path checks passed at preflight; no full CI on the source HEAD. | Latest PR checks and final branch CI status will be recorded after publication. |

## Existing qualification retained

- L6C containment, L6C2 restricted evaluator, L6D mounted API/runtime, and L7 operator workflow reports remain historical evidence with their original scope. They are not represented as one integrated run.
- The private database and source-mounted L6D result do not qualify immutable images or the full Compose overlay.
- The X12 package typecheck and 44 focused tests passed during this preflight. The recorded `BodyInit` diagnostic did not reproduce; no workaround or cast has been introduced.

## Results

Qualification is tied to the working tree based on starting HEAD `f9f36ae5348a70191560968725c5e9537c49bcc1`, plus the uncommitted L7-V changes. The full suite is not green. The M36 timeout did not reproduce in the targeted 3-file run; the Linux `env` test failure did reproduce and is host-specific; the uppercase CSS defect was fixed and its targeted guard passed. The ignored-output parity condition passes in a clean snapshot. The isolated `fitness-gates.test.ts` rerun was not accepted as architecture evidence because its dependency-cruiser process resolved through a symlinked `node_modules` into the primary checkout.

## Final gates and disposition

- **Full lint:** `bun run lint` passed once (10,993 files, no fixes).
- **Full typecheck:** `bun run typecheck` passed once, including workspace build, all eight test type shards and the DOM shard; exit 0 with no diagnostics.
- **Full tests:** `bun run test` completed once with 4 failures, 556 skipped files and 16 todo tests. The CSS failure is corrected and the targeted guard now passes. The three remaining full-run failures are the M36 flake (not reproduced), ignored-output parity (clean-snapshot parity passes), and the Linux `env -S -P` platform mismatch (reproduced). The 556 skipped files and 9,859 skipped tests remain skips, not passes.
- **Architecture:** the first `bun run arch:fitness` aggregate reported 44/50. Dependency-cruiser, direct generated-report checks, temporary-`uv` docling lock, and clean-snapshot parity passed. The aggregate was not rerun; ignored generated directories remain in the main workspace and prevent a clean aggregate parity result without altering user-owned ignored data.
- **PostgreSQL:** private disposable database only. Origin/main-to-PR migration upgrade, rerun and role provisioning passed; prior live suite results are listed above. Shared `os-postgres-1` was not touched.
- **Runtime:** current API/evaluator source topology and the L7 browser-to-database journey passed 30/30 using immutable local test images. Production Compose and immutable release topology remain unqualified because SeaweedFS image download timed out and the official web image build stalled at dependency download. The source-mounted/locally assembled test topology is not release-image evidence.
- **Secrets:** two Gitleaks detections match the clean `origin/main` scan exactly; they remain open findings requiring maintainer disposition. PHI scan passed.
- **Publication:** PR #1115 remains Draft and issue #1075 remains open. No merge, production migration, deployment, payer/vendor request, ERA retrieval, posting, claim-state change or financial outbox event occurred.

### Final targeted scan and regression details

- `bunx vitest run scripts/__tests__/no-uppercase-labels.test.ts apps/web/src/modules/36-messaging/staff-messaging.dom.test.tsx scripts/__tests__/harness-env-wave12e1.test.ts`: 70 passed, 1 failed. The 2 sentence-case guard tests passed after removing uppercase transformation from `medicaid-era-reviews.css`; all 25 M36 DOM tests passed on this rerun. The only remaining failure is the Linux GNU `env -S -P` expectation in a test explicitly describing BSD `env` semantics.
- `bun run arch:parity` from a clean snapshot: passed, 47 packages and 4 apps match the manifest. The same gate fails in the main workspace because ignored generated `packages/domain` and `packages/admin-ui-shell` directories are present; they were preserved.
- Changed-file Biome: passed on all 7 changed source/test files. `git diff --check`: passed before the final documentation additions and will be repeated on the commit candidate.
- Pinned Gitleaks v8.30.1, redacted source-only scan of the current tracked patch plus this report: 2 findings, matching the clean `origin/main` scan by rule and source location: `jwt` in `apps/backend/src/bootstrap/rust-bridge/__tests__/signer-config.test.ts:35` and `stripe-access-token` in `packages/subscription-billing/__tests__/stripe-adapter.test.ts:57`. No L7-V file introduced either match. Both remain unresolved findings; no unrelated fixture or scanner allowlist was changed.

## External qualification still required

- **Engrace/provider owners:** identify the legal Oregon billing entity and provider NPI/TIN, provide current Oregon Medicaid and EOCCO hospice enrollment/participation evidence, and identify the authenticated clearinghouse account and ERA enrollment scope for each provider entity.
- **EOCCO:** provide the current hospice companion/implementation guide, service responsibility and carve-outs, accepted 837I/835 payer identifiers and formats, notification/authorization requirements, effective contracted pricing and adjustment rules, and written test/production qualification requirements.
- **Chosen clearinghouse:** qualify the exact provider account, EOCCO payer mapping, 837I sender enrollment, 835 delivery and recovery semantics, acknowledgments, test-mode evidence and production authorization. Stedi’s JSON report is not raw X12; Claim.MD has no authenticated Medicaid staging integration in this lot.
- **Clinical data owners:** supply authoritative CHC care minutes and an in-home respite service representation before those service lines can be priced or rendered.

## Safety confirmation

Medicaid electronic submission remained disabled. No Stedi, Claim.MD, OHA or EOCCO request was made; no real ERA was retrieved; no real claim or patient PHI was used in the synthetic tests; no payment was posted; no M24 financial state or outbox event was created; no payer rate, enrollment, authorization or certification was approved from synthetic evidence; no secondary Room & Board route was enabled; and no production/shared database migration or deployment occurred.

### Disposition

`M24_1075_L7_GROUP_BLOCKED` — the full configured suite has unresolved platform/baseline failures, the complete architecture aggregate is not green, two baseline secret-scan findings remain, and production Compose/release-image qualification could not complete. The L7-specific ERA review/browser integration is operational and passed its targeted live qualification; this does not establish EOCCO production readiness.

### Verification debt checkpoint

At integrated PR qualification, use a clean generated-output workspace for `bun run arch:fitness`, rerun only the host-compatible form of the GNU/BSD `env` test or add an explicit platform skip/implementation, and address the two baseline Gitleaks findings through maintainer-approved fixture handling. Retry the pinned SeaweedFS and official web image qualification when registry access is available. Do not repeat the full test campaign unless the group-level code changes materially or the repository CI requires it.

Renumbering note (2026-11-25): main merged `1546_object_key_column_rename` (#1110) after this record, so this branch's migrations 1546 to 1548 named above are now `1547_m25_isolated_medicaid_era_evaluator`, `1548_m25_medicaid_era_integrity_and_source_reader` and `1549_m25_medicaid_era_point_in_time_assessments`. Contents are unchanged; the live runs recorded here predate the rename.
