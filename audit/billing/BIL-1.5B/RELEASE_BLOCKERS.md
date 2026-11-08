# Remaining blockers

| Severity | Status | Component / required action | Effect |
|---|---|---|---|
| P0 | RESOLVED IN SOURCE; focused verification passed | Recovery route tenant-admin authorization, recovery platform registration and terminal delivery race. Focused tests, final TypeScript build and relevant architecture checks pass. | No longer blocks cumulative validation; protect with required CI and independent PR review. |
| P1 | BLOCKED | Vendor test-account endpoint/credential/fixture authorization and documented hospice notice support. | No controlled vendor activation, no notice transmission. |
| P1 | PENDING | In-place migration from populated pre-BIL-1 schema; contract migration 1353/1358 version-transition exercise; recovery after interrupted deploy. | No merge/production approval. |
| P1 | PENDING | Full private-PG operator invocation, integrated cross-tenant resolver/ERA scenarios, two-worker restart/fencing and ERA delivery crash reconciliation. | Controlled pipeline activation remains NO. |
| P1 | PENDING | Remote PR state, required branch CI and formal independent PR/security reviews. GitHub API timed out in this run. | No merge approval. |
| P2 | KNOWN | Some historical financial guard and lease-contention event totals have no durable counter. Configure safe alerts on available backlog/state metrics; do not represent unavailable counts as zero. | Operational visibility incomplete. |

No production flag, migration or API request was activated in BIL-1.5B.
