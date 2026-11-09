# Migration and PostgreSQL results

No new matching schema was required: candidate decisions and supersession use migration 1394's append-only JSON evidence column. The pre-existing duplicate ordinal was resolved by moving the independent `1378_fk_supporting_indexes_code_status_emergency_recipient.sql` unchanged to ordinal 1382. The migration runner adopts an old ledger filename only when its stored checksum matches the new file; tests cover matching and mismatching checksums. `arch:migration-numbering` and `arch:migration-compat` pass.

No private isolated PostgreSQL instance with the real application role was established during this run. The known local PostgreSQL 16 cluster is shared and unsuitable for destructive/RLS certification; it was not used. Migration 1394 runtime, RLS, append-only trigger, concurrent decision and no-financial-table-mutation certification remain NOT EXECUTED. No migration was run against a database.
