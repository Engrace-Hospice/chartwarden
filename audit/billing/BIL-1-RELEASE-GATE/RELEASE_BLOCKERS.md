# Release blockers

| Priority | Blocker | Required action | Merge / activation effect |
|---|---|---|---|
| P1 | PR stack inconsistent remotely: #974 is reversed to main; #981/#982 closed unmerged; no BIL-1.5 PR | Re-establish correct PR targets after review; verify unique diffs and ancestry | Blocks Phase 2 merge |
| P1 | No remote CI or formal independent PR/security review for current commits | Push reviewed candidate, run required CI, resolve findings and obtain approvals | Blocks Phase 2 merge |
| P1 | Full authenticated recovery route and PostgreSQL audit not tested together | Add/run private-PG integration test through actual auth plugin and persisted audit | Blocks controlled-test recovery |
| P1 | Integrated multi-tenant response/ERA flow not tested against DB | Run two-tenant/two-provider journey and ambiguity/collision matrix | Blocks controlled-test pipeline activation |
| P1 | Worker multi-process fencing, restart and crash boundaries not DB-certified | Run concurrent independent-worker and crash/replay tests on private PG | Blocks controlled-test activation |
| P1 | Production-shaped populated snapshot and deploy interruption not tested | Exercise backup-based pre-BIL-1 upgrade plus `deploy.sh`/forward recovery | Blocks production and merge gate closure |
| P1 | Claim.MD test-account endpoint and hospice notice semantics unverified | Obtain test-only credential/endpoint authorization and vendor confirmation; execute only after approved | Blocks vendor activation and notice transmission |
| P2 | Gitleaks was unavailable locally | Run configured secret scan in remote CI | Must pass before merge |

Phase 1 commit identities and local tests are evidence, not substitutes for these items. No worker flags or auto-post were enabled.
