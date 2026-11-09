# BIL-2.5 — Cross-Payer Workflow Validation

## Summary

Validated the BIL-2.1 through BIL-2.4 implementations using focused M23, M41 and M24 regression suites, including isolated PostgreSQL execution on the deployment-matching PostgreSQL 18 image. Corrected a PostgreSQL `CHECK`-constraint NULL hole in M41 correction metadata, stale M23 RLS/live-test assumptions, and M23 retry defects: non-ambiguous pre-send refusals were incorrectly left `in_doubt`, retries dropped their immutable reviewed-source fingerprint, and late retries could append work after a successful send. Added the missing M41 detail-page submission action: it first displays the authoritative send-gate result, then requires explicit confirmation before queuing.

The working tree remains uncommitted on local `develop`; `HEAD` and `origin/develop` were both `f06ecfca713e0ced70b04a9bbbf5663eda162a0d` at inspection. Earlier BIL-2 work was already present as uncommitted changes and was preserved. No merge, commit, push, deployment, production migration, Claim.MD request or state Medicaid request was made.

## Verdict

**BIL-2 source-level development: COMPLETE, with external certification deferred.** The validated slices are usable in development, and unsupported transport remains fail-closed. This does not certify vendor behavior, every payer/state route, production rollout, or the complete BIL-1 shared-account runtime. See [the external backlog](EXTERNAL_CERTIFICATION_BACKLOG.md).

The temporary isolated PostgreSQL 18.6 container was used only for synthetic test data and removed after verification; the shared PostgreSQL service remained untouched. M23 and M24 FORCE RLS suites ran as the `chartwarden_app` NOBYPASSRLS role. The M41 live suites use the repository's private test harness; route authorization tests use its injected test context, not the production identity provider. Final M23 clearinghouse worker live coverage passed 17/17 after the retry corrections.
