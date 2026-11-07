# BIL-1.3 — Claim.MD acknowledgment integration

**Source verdict: conditional. Activation verdict: NO-GO.** This branch adds an inactive, account-scoped consumer of BIL-1.2 resolved events. It recognizes only the narrow `CLMMD` / `ACK` / `A` clearinghouse receipt shown in the [Claim.MD API response example](https://api.claim.md/). Payer acceptance, rejection, denial, payment, notices, and ERA remain outside the implemented mapping. The source implementation has not been certified against a private PostgreSQL role/RLS run or a synthetic Claim.MD test account.

The path is `claimmd_response_event` → current `claimmd_response_resolution` → encrypted page → interpreter → M23 or M41 owner adapter → tenant-scoped application history. Delivery uses a separate durable account/environment/mode lease table; claim mutation, M41 outbox and application outcome share one tenant transaction. `CLAIMMD_ACK_SHADOW_ENABLED` and `CLAIMMD_ACK_DISPATCH_ENABLED` both default off. Neither flag is set in this branch.

Key source: `claimmd-ack/{store,service,interpret,config,worker}.ts`, `claimmd-ack/{medicare-adapter}.ts`, M41 `services/claimmd-ack-adapter.ts`, migration `1354_m23_claimmd_ack_application.sql`, and migration `1355_m41_ack_source_representation.sql`. The old Claim.MD provider pollers are guarded; other vendors retain their prior paths.

This branch is based on `develop` at `8820f48e9`, which is the head of the still-draft BIL-1.2.2B PR #974 at branch creation. It must be reviewed as a dependent change; it must not be merged before its base is settled. No Claim.MD call, production migration, deployment, or worker activation was made.

See the other files here for provenance, transaction rules, test evidence and activation blockers. The exact API response example is documentation evidence, not test-account certification.
