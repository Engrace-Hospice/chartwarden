# Environment readiness

| Area | Result | Evidence |
|---|---|---|
| PostgreSQL | PASS | Disposable PostgreSQL 18; migrations current; application readiness reported `db=ok`. |
| Redis/BullMQ | PASS | Isolated Valkey accepted queue work; real `m22-doclens-intake` job reached the worker. Redis outage made API `/ready` return 503 and recovery returned 200. |
| Worker registration | PASS | Worker consumed the one-page job and completed Docling, classification, extraction, vision verification, and SUD detection. Composition root calls `registerDocLensIntakeWorker` in `apps/backend/src/index.ts`. |
| Docling availability (isolated dev stack) | FAIL | Health and one-page parsing passed; the 21-page packet drove the dev container to exit 137. |
| Docling production resource envelope | BLOCKED | Production declares 2 GiB/2 CPU, but the packet was not rerun under that exact envelope. |
| Document storage/retrieval | PASS | Verified presigned PUT, checksum-enforced completion, worker retrieval, and page rendering succeeded after the tenant bucket existed. |
| Tenant bucket provisioning | FAIL | The newly seeded isolated tenant initially received valid presigns but PUT returned 404. `scripts/backfill-tenant-buckets.ts` created the missing bucket; subsequent upload passed. |
| AI providers | PASS | Worker reached pinned local Ollama backends: Llama 3.1 8B q8 and Qwen 2.5 VL 7B. No mocked response was used for the acceptance run. |
| Tenant feature/governance config | PASS | `documents.doclens` enabled; DocLens templates pinned; tenant local-only opt-in and budgets seeded; four DocLens capabilities in PILOT. |
| Capability/budget enforcement | PASS | Six completed `ai_invocation` rows recorded capability, backend, exact model pin, tokens, duration, encrypted prompt/response, and routing state. Existing F236 live suite also passed the enforcement cases. |

The isolated stack used dedicated loopback ports, project-specific volumes, a synthetic tenant, and no
shared database. The repository's synthetic 21-page packet and a one-page PNG derived from it were the
only clinical documents.

