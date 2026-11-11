# BIL-1 branch dependency inventory

Local Git evidence captured before BIL-1.5B edits. GitHub API requests for PR metadata timed out, so PR numbers cited from the prior user-provided PR screenshots/reports are **unverified current remote state**. CI and remote review status must be refreshed during the Release Gate.

| Branch / phase | Intended base; merge base against local `develop` | HEAD; unique local commits | Migrations | PR / review / CI | Uncommitted changes and merge dependency |
|---|---|---|---|---|---|
| `develop` / BIL-1.2.2B base | `develop`; `8820f48e9` | `8820f48e9`; includes BIL-1.2.2A/B antecedents `5328e82e5`, `d9a58145a` | 1350–1353 already in local base | Draft PR #974 reported historically; current remote state/review/CI unknown due GitHub timeout | Base for #981; do not infer #974 merged merely because local `develop` contains the commits. |
| `feat/bil-1-3-claimmd-ack` / BIL-1.3 | `develop`; `8820f48e9` | `756c164d2` (one unique commit) | 1354–1355 | Draft PR #981 reported by user; current review/CI unknown | Merge/review before BIL-1.4. |
| `feat/bil-1-4-claimmd-era` / BIL-1.4, 1.4.1A/B | BIL-1.3; `8820f48e9` vs `develop`; direct parent is `756c164d2` | `47cd1aaba`, `2ea823a19` (two unique commits above BIL-1.3) | 1356–1358 | Draft PR #982 reported by user, targeting BIL-1.3 in prior screenshot; current review/CI unknown | Merge/review after BIL-1.3. |
| `feat/bil-1-5a-claimmd-runtime-hardening` / BIL-1.5A through A.3, current BIL-1.5B | BIL-1.4; `8820f48e9` vs `develop`; current HEAD equals BIL-1.4 at `2ea823a19` | No new commit yet; all A/A.1/A.2/A.3 implementation is in the dirty worktree | 1359–1361 untracked in worktree | No PR verified; independent review in progress, CI not run | Requires scoped review/commit on this branch after validation; merge only after earlier stack and Release Gate. |

The local branch stack is linear: `develop` → BIL-1.3 → BIL-1.4 → BIL-1.5A working tree. No branch was merged, rebased, reset, deleted or force-pushed in BIL-1.5B. The working tree contains cumulative prior-phase source, tests, documentation and migrations; BIL-1.5B changes must be identified separately before staging.

Remote PR base/CI and independent review evidence are still required before merge. GitHub API calls to read PR #974 and list PRs failed with network timeouts; this is an inspection limitation, not a passing CI result.
