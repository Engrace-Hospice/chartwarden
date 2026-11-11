# Non-regression

- BIL-4.1 full payment eligibility remains unchanged: charge equals payment, zero patient responsibility, and no CAS adjustment.
- Multi-claim fully-paid execution remains all-or-nothing under the existing v3 plan and M25 transaction core.
- Existing `postAdvice`/manual/SFTP adjustment routing and financial tables were not changed by the partial assessment.
- The existing partial event and M41/M23/M26 consumers are reused; no false full-paid event is emitted by the supported case.
- No migration, posting table, worker, or event-catalog change was introduced.
- `CLAIMMD_ERA_CONTROLLED_POSTING_ENABLED` remains default-disabled; production guard and automatic-posting boundary remain unchanged.

Exact tests rerun for this work are listed in [POSTGRESQL_FINANCIAL_TESTS.md](POSTGRESQL_FINANCIAL_TESTS.md) and the final response.
