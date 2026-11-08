# Deployment interruption and recovery

No deployment script or production configuration was executed in Phase 1.1.

Prior Phase 1 evidence in `../INTERRUPTED_DEPLOYMENT_RECOVERY.md` remains valid for migration-runner transaction rollback and restart idempotency on a private PostgreSQL 18 database. It did not simulate a process interruption around the deployment container swap or after committed contract migration but before compatible application startup.

`deploy/production/deploy.sh` uses the migration compatibility classification to decide whether automatic old-image restoration is safe. Migrations 1353 and 1358 are `compat: contract`; preserve those classifications. A failure after either contract migration requires operator-held recovery/forward-fix, not blind rollback. Phase 1.1 did not modify migrations or migration records.

Actual production-shaped backup restoration, deployment script interruption, container swap, and post-contract-migration operator hold remain blocked pending a safely disposable rehearsal harness and an isolated deployment test configuration. No live deployment operation occurred.
