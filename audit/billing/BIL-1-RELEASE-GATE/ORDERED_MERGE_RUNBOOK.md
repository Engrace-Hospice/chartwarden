# Phase 2 ordered merge runbook (not executed)

## Preconditions

1. Resolve #974's direction. Its current `develop` → `main` Draft does not represent the resolver PR and has no checks.
2. Obtain formal independent code/security review of exact candidate SHAs. Run Gitleaks and all required branch CI; do not merge until green and approved.
3. Reopen or replace #981 as BIL-1.3 → `develop`, head `756c164d2`.
4. Reopen or replace #982 as BIL-1.4 → BIL-1.3, head `2ea823a19`. After #981 lands, retarget #982 to `develop` so its unique diff is only `47cd1aaba`–`2ea823a19`.
5. After BIL-1.4 is accepted, create BIL-1.5A/B → `develop` with implementation commit `73b4538fb` and report commits `5e71c9e65`, `410b3a081`. Verify no unrelated commits are included.
6. Preserve migration classification. Apply 1353/1358 in a maintenance window with backups and forward-fix operators ready; automatic rollback after a contract migration is not safe.

## Merge order

1. BIL-1.3 PR into `develop`.
2. Retarget BIL-1.4 to `develop` after BIL-1.3 lands, then merge after its checks/approvals pass.
3. BIL-1.5A/B to `develop` after BIL-1.4 lands.
4. Rebase/retarget only with branch owners' approval; never force-push reviewed public history.
5. After final integration, run full relevant BIL-1 tests, build/typecheck, architecture gates, private PostgreSQL suites and `check:boot:platform` on the exact final `develop` commit.

## Stop/rollback behavior

Before migrations: restore previous release normally. For expand-only DDL, deploy tooling may restore prior app. For 1353/1358 contract DDL, a failure halts for operator decision (exit 75); use forward repair or a tested backup restore, never automatic old-binary restart. Keep all Claim.MD/notice/posting flags false. Phase 2 requires a separate explicit user authorization; this runbook authorizes no merge.
