# Failure and recovery results

| Scenario | Result | Evidence |
|---|---|---|
| Docling unavailable/exits (isolated dev stack) | FAIL | 21-page run ended with Docling exit 137; BullMQ failed after 3 attempts; batch stayed `uploaded` with no API-visible failure state. Restart restored service but did not automatically recover the exhausted job. |
| Docling unavailable/exits (production envelope) | BLOCKED | Not rerun with production's declared 2 GiB/2 CPU limits. |
| Redis disconnect | PASS | API `/ready` returned 503 with `valkey=fail`; after restart it returned 200 with `valkey=ok`. Worker `/health` remained 200 as a liveness endpoint. |
| AI capability unavailable | BLOCKED | Not destructively toggled after the governed success run; F236 exercises denial, but no Phase-4 live outage result is claimed. |
| Classification fails | BLOCKED | No controlled real-provider failure injection completed. |
| Extraction returns zero candidates | BLOCKED | No controlled real-provider zero-result document completed. |
| Worker crash | BLOCKED | Docling crashed, not the worker process itself. |
| Processing interruption | FAIL | PostgreSQL connection timeouts and BullMQ lock-renewal errors occurred during the same interval as the large parse; causation was not isolated. The intake job ultimately failed without a batch status transition. |
| Duplicate delivery | BLOCKED | Queue code uses deterministic job IDs and removes failed prior jobs, but duplicate delivery was not executed live in this phase. |
| Discard during processing | BLOCKED | Not executed live. |
| Two reviewers open same review | BLOCKED | F237 covers locking semantics; no two-session Phase-4 live attempt was completed. |
| Refresh/navigation | PASS | Identity resolution and review state survived new authenticated requests; completion resumed from persisted state. |

No failure produced a duplicate or unauthorized clinical record. The failed 21-page run produced zero
classification, extraction-job, and candidate rows. The successful run produced no clinical writeback
because risk enforcement excluded all candidates.

