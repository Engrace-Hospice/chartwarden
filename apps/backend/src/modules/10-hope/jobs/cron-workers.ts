// apps/backend/src/modules/10-hope/jobs/cron-workers.ts — the M10 §4.8 BullMQ cron worker construction
// (TASK-040D, the M25 `25-remittance/jobs/cron-workers.ts` template). Wires EXACTLY TWO of M10's seven §4.8
// queues into live Workers + repeatable Queues: `windows` (`hope-window-watchdog`) and `sfv`
// (`sfv-watchdog`) — the clinical-path regulatory-clock watchdogs (HOPE timepoint window expiry, Symptom
// Follow-up Visit deadlines). `alerts` (`hope-alert-dispatcher`) and `scheduling`/`validation`/
// `submission`/`retention` are DELIBERATELY NOT wired here: they need infrastructure that doesn't exist yet
// (a cadence-dispatch-tracking store, patient-display-name + CTA-URL resolution, the multi-stage iQIES
// submission pipeline) — out of scope for this pass, not silently dropped.
//
// F-058 (#150) SHARPENS the `submission` entry, because "out of scope for this pass" had stopped being
// the reason. §4.10 is three stages and they are not blocked by the same thing:
//
//   • stage 1 `assemble-hope-submission` — needs NOTHING outside M10, and its absence was the whole
//     defect: `hope_submission_item` had no writer anywhere in the repo and the route that claims to
//     force-assemble inserted an empty batch. It is now REAL, in ./assemble-store.ts, reachable through
//     `assembleSubmission` on the route service.
//   • stages 2 and 3 `iqies-submit-worker` / `iqies-reconcile-worker` — terminate in
//     `@wardenx/iqies-client`, whose only adapter is `createUnboundIqiesAdapter`. There is no transport
//     (CMS HOPE submission XML, per-MAC submitter auth, sandbox/prod selection, per-tenant credentials
//     from M34's secret store). A genuine declared absence, and the deny-stub is the right posture.
//
// No `assemble-hope-submission` CRON is registered even though stage 1 works, and that is a decision
// rather than an omission. A nightly pass would create batches nothing can transmit, and each batched
// assessment is then excluded from every future batch by `uniq_hope_sub_item_assessment_active` — so an
// unattended cron would quietly consume the agency's whole backlog into batches that go nowhere. An
// operator pressing force-assemble is a deliberate act; a cron doing it is not. Registering it is a
// one-line change here once a live adapter binds.
//
// Each cron fans out over the active orgs, opens ONE per-org `withOrgContext` RLS envelope, reads via
// ./cron-store, runs the PURE planner (planHopeWindowWatchdog / planSfvWatchdog from ./index), persists the
// `changed===true` transitions, and publishes every planned event to the injected transactional-outbox
// port — all inside that same tx. Unlike M25's crons (which dispatch M36 business alerts), M10's watchdogs
// publish straight to the outbox; the `outbox` dependency is therefore NOT optional (the composition root
// always constructs one wherever a DB client exists). Only `activeOrgs` carries the M25 lazy
// fail-closed-thunk default. `M10_DLQ` is NOT constructed here as separate literal Queues — a later
// composition-root step attaches DLQ-promotion alerting externally to the Workers this file returns.
//
// Nothing here runs at import (constructing a Worker opens Valkey) — same posture as M25.
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import {
  openHopeSchedulesForOrg,
  openOrOverdueSfvsForOrg,
  updateHopeScheduleStatus,
  updateSfvStatus,
} from "./cron-store";
import {
  type M10QueueName,
  M10_JOB_PARAMS,
  M10_JOB_SCHEDULES,
  M10_QUEUES,
  type PlannedHopeEvent,
  planHopeWindowWatchdog,
  planSfvWatchdog,
} from "./index";

/** The system actor id the crons stamp on their per-org `withOrgContext` reads (audit attribution). Chosen
 * to not collide with the other modules' `00000000-0000-0000-0000-0000000000xx` cron system-actor ids
 * (M25 `...e5`, M26 `...e6`, M7 `...07` — grepped the repo first). */
/**
 * The `app.user_id` a watchdog tick carries — the EMPTY-STRING system sentinel, which the M4 PHI
 * write-audit triggers `NULLIF(...)` to NULL. A cron transition has no acting user.
 *
 * #48 — this was the synthetic uuid `00000000-0000-0000-0000-000000000010`, which has no `user` row.
 * `audit_event.actor_user_id` is a nullable column with an FK to `user`, and the trigger NULLIFs only
 * the EMPTY string before casting to uuid — so the sentinel passed straight through and
 * every transition died on `audit_event_actor_user_id_user_id_fk`. NEITHER watchdog could complete a
 * single status change. `hope-window-watchdog` never showed it because the table it reads was always
 * empty (nothing wrote `hope_timepoint_schedule` at all); `sfv-watchdog` reads rows that DO exist, so
 * it has been failing every 15 minutes wherever an SFV went past due. Surfaced the moment this branch
 * gave the window watchdog a real row to expire. M10's own org-rollup store already used the empty
 * sentinel with this exact reasoning.
 */
const M10_WORKER_SYSTEM_USER_ID = "";

/** The two `hope-*-watchdog` job names this file wires (a narrower key set than `M10_JOB_PARAMS`/
 * `M10_JOB_SCHEDULES`, which also carry the five NOT-yet-wired §4.8 jobs). */
type M10WatchdogJobName = "hope-window-watchdog" | "sfv-watchdog";

/** The transactional-outbox port (§2.4) M10's watchdogs publish `m10.hope.*` events through, on the
 * caller's tx — the bound publisher validates every emit against the boot catalog and writes the
 * `outbox_event` row. Mirrors `HopeWriteOutboxPort` in ../hope-route-service-db.ts (kept local here so this
 * file takes no dependency on the route-service module). */
export interface HopeOutboxPublishPort {
  publish(
    tx: DbClient,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

/** The M2 active-org enumerator the cron fan-out reads (runs under withPlatformContext when bound). */
export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

/** The dep bag the composition root injects. `outbox` is required; `activeOrgs` defaults to a fail-closed
 * thunk until the integrator binds it (the M25 pattern). */
export interface M10WorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly outbox: HopeOutboxPublishPort;
  readonly activeOrgs?: ActiveOrgListPort;
  now?: () => Date;
}

/** A fail-closed port: throws a descriptive UNBOUND error when a cron tick reaches an unbound dependency. */
function unbound<T>(port: string, hint: string): Promise<T> {
  return Promise.reject(new Error(`M10_WORKER_PORT_UNBOUND: ${port} — ${hint}`));
}

function activeOrgsOf(deps: M10WorkerDeps): ActiveOrgListPort {
  return (
    deps.activeOrgs ?? {
      listActiveOrgs: () =>
        unbound(
          "activeOrgs.listActiveOrgs",
          "bind the M2 active-org enumerator (the cron fan-out source) under withPlatformContext",
        ),
    }
  );
}

/** Build the {@link M10WorkerDeps} from the composition-root primitives (the M25 `buildM25WorkerDeps` shape). */
export function buildM10WorkerDeps(deps: {
  connection: ConnectionOptions;
  db: DbClient;
  outbox: HopeOutboxPublishPort;
  activeOrgs?: ActiveOrgListPort;
}): M10WorkerDeps {
  return {
    connection: deps.connection,
    db: deps.db,
    outbox: deps.outbox,
    activeOrgs: deps.activeOrgs,
    now: () => new Date(),
  };
}

/** The confirmed §2.4 outbox-catalog aggregate routing for each `PlannedHopeEvent` (events-by-m10.ts):
 * `timepoint_expired` targets the schedule; `sfv_overdue`/`sfv_missed` target the SFV. */
function outboxTargetFor(event: PlannedHopeEvent): { aggregateKind: string; aggregateId: string } {
  switch (event.eventName) {
    case "m10.hope.timepoint_expired":
      return {
        aggregateKind: "hope_timepoint_schedule",
        aggregateId: String(event.payload.scheduleId),
      };
    case "m10.hope.sfv_overdue":
    case "m10.hope.sfv_missed":
      return { aggregateKind: "symptom_follow_up_visit", aggregateId: String(event.payload.sfvId) };
  }
}

// ── the per-org cron runners (fan out over active orgs, RLS-scoped, outbox-publishing) ─────────────────────

/** `hope-window-watchdog` (§4.8, every 15 min) — per org, flip every `open` schedule past its late deadline
 * to `expired` and publish `m10.hope.timepoint_expired` for each transition. */
export async function runHopeWindowWatchdogCron(deps: M10WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await activeOrgsOf(deps).listActiveOrgs();
  for (const { organizationId } of orgs) {
    await withOrgContext(
      deps.db,
      { organizationId, userId: M10_WORKER_SYSTEM_USER_ID },
      async (tx) => {
        const t = tx as unknown as DbClient;
        const schedules = await openHopeSchedulesForOrg(t, organizationId);
        const plan = planHopeWindowWatchdog(schedules, now.toISOString());
        for (const transition of plan.transitions) {
          if (transition.changed) {
            await updateHopeScheduleStatus(t, transition.scheduleId, transition.toStatus);
          }
        }
        for (const event of plan.events) {
          await deps.outbox.publish(t, {
            eventName: event.eventName,
            payload: event.payload,
            organizationId,
            ...outboxTargetFor(event),
          });
        }
      },
    );
  }
}

/** `sfv-watchdog` (§4.8, every 15 min) — per org, decay every `open`/`overdue` SFV (→ `overdue`/`missed`)
 * and publish `m10.hope.sfv_overdue` (re-emitted every tick it stays overdue) / `m10.hope.sfv_missed`
 * (terminal edge). Only writes the row when `changed===true` — an unchanged `overdue` re-emit fires the
 * event without a redundant UPDATE. */
export async function runSfvWatchdogCron(deps: M10WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await activeOrgsOf(deps).listActiveOrgs();
  for (const { organizationId } of orgs) {
    await withOrgContext(
      deps.db,
      { organizationId, userId: M10_WORKER_SYSTEM_USER_ID },
      async (tx) => {
        const t = tx as unknown as DbClient;
        const sfvs = await openOrOverdueSfvsForOrg(t, organizationId);
        const plan = planSfvWatchdog(sfvs, now.toISOString());
        for (const transition of plan.transitions) {
          if (transition.changed) {
            await updateSfvStatus(t, transition.sfvId, transition.toStatus);
          }
        }
        for (const event of plan.events) {
          await deps.outbox.publish(t, {
            eventName: event.eventName,
            payload: event.payload,
            organizationId,
            ...outboxTargetFor(event),
          });
        }
      },
    );
  }
}

// ── BullMQ construction ──────────────────────────────────────────────────────────────────────────────────

/** The §4.8.1 catalog's string-form backoff (e.g. `"exponential 30s"`) parsed into BullMQ's `{type,delay}`
 * shape. Only the base delay is used; neither wired job's catalog entry carries a `, max …` clause. */
interface ParsedBackoff {
  readonly type: "exponential" | "fixed";
  readonly delay: number;
}

const DURATION_UNIT_MS: Record<"s" | "m" | "h", number> = { s: 1_000, m: 60_000, h: 3_600_000 };

function parseBackoff(spec: string): ParsedBackoff {
  const [head] = spec.split(",");
  const [type, duration] = (head ?? "").trim().split(/\s+/);
  const match = /^(\d+)(s|m|h)$/.exec(duration ?? "");
  if ((type !== "exponential" && type !== "fixed") || !match) {
    throw new Error(`M10_WORKER_BACKOFF_UNPARSEABLE: ${spec}`);
  }
  const amount = match[1] as string;
  const unit = match[2] as "s" | "m" | "h";
  return { type, delay: Number(amount) * DURATION_UNIT_MS[unit] };
}

/** Construct one BullMQ `Worker` per wired §4.8 cron queue. The caller owns lifecycle (`close()` on shutdown). */
export function registerM10CronWorkers(deps: M10WorkerDeps): Worker[] {
  const { connection } = deps;
  return [
    new Worker(M10_QUEUES.windows, async () => runHopeWindowWatchdogCron(deps), {
      connection,
      concurrency: M10_JOB_PARAMS["hope-window-watchdog"].concurrency,
    }),
    new Worker(M10_QUEUES.sfv, async () => runSfvWatchdogCron(deps), {
      connection,
      concurrency: M10_JOB_PARAMS["sfv-watchdog"].concurrency,
    }),
  ];
}

/** Register the two wired §4.8 repeatable cron schedules on their dedicated queues. Returns the `Queue`s to
 * `close()`. */
export async function scheduleM10Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const jobs: readonly [M10QueueName, M10WatchdogJobName][] = [
    [M10_QUEUES.windows, "hope-window-watchdog"],
    [M10_QUEUES.sfv, "sfv-watchdog"],
  ];
  const queues: Queue[] = [];
  for (const [queueName, jobName] of jobs) {
    const params = M10_JOB_PARAMS[jobName];
    const queue = new Queue(queueName, { connection });
    await queue.add(
      "scheduled",
      {},
      {
        repeat: { pattern: M10_JOB_SCHEDULES[jobName] },
        attempts: params.attempts,
        backoff: parseBackoff(params.backoff),
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    queues.push(queue);
  }
  return queues;
}
