# Remaining Blockers

- **Payer-specific accepted-claim replacements and voids:** blocked pending verified plan/format requirements, original payer control references and authorized route configuration. Do not enable these operations by inference.
- **PostgreSQL certification:** see `TEST_RESULTS.md`; the dedicated live M41 suite is required to prove migration/trigger and persistence behavior.
- **Formal review:** this development worktree also contains prior BIL-2 phase changes. Review should assess the complete intended branch diff, not only BIL-2.3 files.
- **Activation:** no Claim.MD controlled/live activation or production deployment is authorized by this phase.
- **Migration rollout:** migration 1380 is classified `contract` because it removes the old exclusion constraint and exact-window unique index in favor of a transaction-serialized trigger. Deployers must review app/migration sequencing and rollback behavior; the repository compatibility gate will not treat this as an automatically reversible expand-only deployment. No deployment was run here.
