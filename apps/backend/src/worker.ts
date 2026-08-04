// apps/backend/src/worker.ts — dedicated worker-only entrypoint (TASK-040A, production-readiness
// audit 2026-08-03, OPS-002).
//
// Before this file, `index.ts` was the ONLY entrypoint: every horizontally-scaled API replica also
// constructed its own BullMQ Workers, repeatable-cron Queue producers, and outbox-dispatcher poller
// — wasted duplicate work at best, and coupling background-job concurrency to API replica count at
// worst. This process runs the SAME composition root (`bootWardenX`, defined in `./index`) with
// `role: "worker"`, which skips route-serving traffic concerns and constructs only the background
// half; run `./index.ts` (or this repo's existing `dev`/`start` scripts) with `PROCESS_ROLE=api` to
// get the complementary API-only process. Omitting `PROCESS_ROLE` entirely (the historical single-
// process shape) still runs everything in one process — this file is additive, not a breaking split.
import { bootWardenX } from "./index";

await bootWardenX("worker");
