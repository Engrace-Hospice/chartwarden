# Git stack and PR matrix

## Local and remote branch evidence

| Phase | Local SHA / range | Remote SHA | Actual PR state | Intended base / status |
|---|---|---|---|---|
| BIL-1.2.2B foundation | `develop` `8820f48e9`; contains `5328e82e5`, `d9a58145a` | `origin/develop` `8820f48e9` | #974 OPEN, Draft, head `develop`, base `main`, no checks/reviews | This is the reverse of the intended feature PR direction; do not merge it as the BIL-1 resolver PR. |
| BIL-1.3 | `756c164d2`, one commit above `develop` | same SHA | #981 CLOSED, not merged; base `develop`, head `feat/bil-1-3-claimmd-ack`; no checks/reviews | Intended stack root after resolver foundation. Reopen or replace only after review preparation. |
| BIL-1.4 / 1.4.1 | `47cd1aaba`, `2ea823a19` above BIL-1.3 | same SHA | #982 CLOSED, not merged; base BIL-1.3, head `feat/bil-1-4-claimmd-era`; no checks/reviews | Correct stacked base historically; re-establish after BIL-1.3 is accepted. |
| BIL-1.5A/B | New commits below; based on `2ea823a19` | No `origin/feat/bil-1-5a-claimmd-runtime-hardening` branch found | No BIL-1.5 PR found | Must target the accepted BIL-1.4 tip or be retargeted after approved consolidation. |

GitHub CLI inspection (`gh pr view`) returned no reviewer decisions and no checks for #974/#981/#982. #981 closed at `2026-11-07T15:11:00Z`; #982 closed at `2026-11-07T15:11:19Z`; neither has `mergedAt`. Remote branch heads for `develop`, BIL-1.3, and BIL-1.4 match their local SHAs. The BIL-1.5 branch exists only locally.

`git merge-base develop <each BIL-1 branch>` was `8820f48e9`, which confirms local ancestry is `develop` → BIL-1.3 → BIL-1.4 → BIL-1.5 working branch. No branch was rebased, reset, force-pushed, deleted, or merged.

## Corrected PR plan (preparation only)

1. Keep the resolver commits already in `develop`; clarify/close or replace #974 because it proposes `develop` → `main` and has no checks.
2. Reopen or create BIL-1.3 → `develop` using head `756c164d2` after independent review and CI are available.
3. Reopen or create BIL-1.4 → BIL-1.3 at `2ea823a19` after #981 lands; then BIL-1.5A/B → BIL-1.4 with source commit `73b4538fb` and the Phase 1 report commit on the same local branch after the previous dependency is accepted.
4. Require each PR's unique diff, CI, migration evidence, review and approvals before Phase 2.

No PR base was edited, no replacement PR was opened, and no remote branch was pushed in Phase 1.

## Migration ranges

| Branch | Migrations |
|---|---|
| BIL-1.3 | 1354–1355 |
| BIL-1.4 | 1356–1358 (`1358` remains `compat: contract`) |
| BIL-1.5A/B | 1359–1361 |

Migration 1353 is in the resolver foundation and remains `compat: contract`. Do not reclassify it to ease the deployment sequence.
