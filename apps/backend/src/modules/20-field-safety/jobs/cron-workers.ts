// apps/backend/src/modules/20-field-safety/jobs/cron-workers.ts — the LIVE BullMQ Worker + repeatable
// Queue construction for M20's §4.8 `m20.sos-sla-watchdog.cron` (F-111, #249; the M9/M25/M33
// `jobs/cron-workers.ts` template — active-org fan-out, one `withOrgContext` tx per alert, publish
// through the transactional outbox in the SAME tx as the state-history/lifecycle write).
//
// THE DECIDER WAS ALREADY DONE. `../lifecycle/sos-escalator.ts`'s `decideSosWatchdog` is the pure,
// unit-tested per-alert decision — the 5-second stale-cancel-window sweep, the tier-1/2/3 SLA-dwell
// escalation, and the `emergency_terminus` re-page loop. What was missing is everything IO: nothing
// scanned for an overdue alert, computed its `stateEnteredAt`, resolved the pinned policy, or applied
// the decision back to the row. That absence was invisible to `check-outbox-bindings.ts` and
// `check-live-suite-coverage.ts` — this is a scheduled decider with no producer event to wait on, not an
// outbox consumer, so neither gate class this repo has built could see it.
//
// LOCKING AGAINST DOUBLE-ESCALATION IS THE EXISTING §2.5 OPTIMISTIC-CONCURRENCY COLUMN, NOT A NEW
// PRIMITIVE. `safety_sos_alert.version` already exists for exactly this race (two supervisors
// acknowledging the same alert); `applySosAlertPatch` below is the `write-service-drizzle.ts`
// `applySosPatch` / `consumers/m36-delivery-failed.ts` `applyEscalation` shape verbatim: read the row,
// build the effects, `UPDATE ... WHERE id = ? AND version = ?` and check `.returning()` came back with
// exactly one row. Two ticks (or two workers) racing the same alert cannot both win — Postgres holds the
// row lock across the first UPDATE until it commits or rolls back, so the second UPDATE's WHERE clause
// re-evaluates against the ALREADY-ADVANCED version and matches zero rows. A losing tick is not an
// error: it means the alert was just handled (by the other tick, or by a human acknowledging it in the
// same window), so it is logged and skipped rather than retried within the same pass — the next 15-second
// tick will re-read the row's current state and decide correctly either way.
//
// EACH ALERT GETS ITS OWN TRANSACTION. A tick that touches five open alerts in an org must not let one
// alert's lost race (or genuine failure) abort the other four — `processOneAlert` catches its own
// `STALE_LIFECYCLE_STATE` and logs+continues rather than letting it propagate out of the org's loop.
//
// THE TERMINUS RUNG IS ENTERED AT THE TIER-3 BREACH (GAP-032). `escalateSos` from `escalation_tier_3`
// reaches `emergency_terminus`, whose three life-safety effects (`dial_emergency_contact`,
// `surface_psap_number`, `page_chartwarden_ops`) are `CALLER_OWNED_EFFECT_KINDS` the effects runner does not
// execute: a telephony / webhook round-trip must never hold a pooled tenant connection. They are therefore
// recorded as INTENT rows in `safety_sos_terminus_action` (`../terminus/`) in the SAME tx as the state
// change, and an executor performs them out of the tx and settles each row. The state is a fact about an
// unanswered alert; the ledger carries the truth about each effect - so a down receiver can no longer hide
// a terminus (the original GAP-032 symptom), and the `sos_terminus_reached` payload reports the ledger,
// never a guess. The re-page LOOP is idempotent per (alert, loop period): the ledger's UNIQUE key means the
// ~20 watchdog ticks inside one period produce one event and one set of intents.
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { runWithRequestContext, withOrgContext } from "@chartwarden/tenancy";
import type {
  IsoInstant,
  MembershipId,
  OrgId,
  SafetyPolicyEffectiveDto,
  SafetyPolicyProvider,
  SafetySosAlertId,
  SafetySosLifecycleState,
} from "@chartwarden/types";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { and, desc, eq, sql } from "drizzle-orm";
import { buildSosEscalatedAlert, buildSosTerminusAlert } from "../alerts";
import {
  type SafetySosAlertFacts,
  type SafetySosTransition,
  escalateSos,
  expireCancelWindow,
  type repageTerminus,
} from "../lifecycle/sos-alert";
import { decideSosWatchdog } from "../lifecycle/sos-escalator";
import { type SosStateHistoryPort, runEffects } from "../routes/effects-runner";
import type { AlertPort, WriteOutboxPort } from "../routes/write-service";
import type { TerminusDeps } from "../terminus/deps";
import { emergencyContactConsentGrantedInTx, recordTerminusIteration } from "../terminus/enter";
import { runTerminusExecutorForOrg } from "../terminus/executor";
import { type TerminusLedgerFlags, readLedgerFlags } from "../terminus/ledger";
import { runCoverageGapWatchdogCron } from "./coverage-gap-watchdog";
import {
  M20_COVERAGE_GAP_WATCHDOG_JOB_NAME,
  M20_JOB_SCHEDULES,
  M20_OVERDUE_DETECTOR_JOB_NAME,
  M20_QUEUES,
  M20_QUEUE_PARAMS,
  M20_SOS_WATCHDOG_JOB_NAME,
} from "./index";
import { runOverdueDetectorCron } from "./overdue-detector";
import {
  type ActiveOrgListPort,
  type M20WorkerDeps,
  M20_WORKER_SYSTEM_USER_ID,
  activeOrgsOf,
  logM20Cron,
} from "./worker-support";

export type { ActiveOrgListPort, M20WorkerDeps } from "./worker-support";
export { runCoverageGapWatchdogCron } from "./coverage-gap-watchdog";
export { runOverdueDetectorCron } from "./overdue-detector";

const SOS = schema.safetySosAlert;
const SOS_HISTORY = schema.safetySosAlertStateHistory;

/** Build the {@link M20WorkerDeps} from the composition-root primitives (the M9/M25 `buildMxWorkerDeps` shape). */
export function buildM20WorkerDeps(deps: {
  connection: ConnectionOptions;
  db: DbClient;
  outbox: WriteOutboxPort;
  policy: SafetyPolicyProvider;
  alerts?: AlertPort;
  terminus?: TerminusDeps;
  activeOrgs?: ActiveOrgListPort;
  locationTimezone?: M20WorkerDeps["locationTimezone"];
}): M20WorkerDeps {
  return {
    connection: deps.connection,
    db: deps.db,
    outbox: deps.outbox,
    policy: deps.policy,
    ...(deps.alerts ? { alerts: deps.alerts } : {}),
    ...(deps.terminus ? { terminus: deps.terminus } : {}),
    activeOrgs: deps.activeOrgs,
    ...(deps.locationTimezone ? { locationTimezone: deps.locationTimezone } : {}),
    now: () => new Date(),
  };
}

function sosFactsOf(row: {
  lifecycleState: string;
  version: number;
  postedByMembershipId: string;
  postedAt: Date;
  cancelWindowExpiredAt: Date;
  cancelStatus: string;
  lastKnownVisitId: string | null;
  linkedIncidentId: string | null;
}): SafetySosAlertFacts {
  return {
    lifecycleState: row.lifecycleState as SafetySosAlertFacts["lifecycleState"],
    version: row.version,
    postedByMembershipId: row.postedByMembershipId as SafetySosAlertFacts["postedByMembershipId"],
    postedAt: row.postedAt.toISOString() as IsoInstant,
    cancelWindowExpiredAt: row.cancelWindowExpiredAt.toISOString() as IsoInstant,
    cancelStatus: row.cancelStatus as SafetySosAlertFacts["cancelStatus"],
    lastKnownVisitId: row.lastKnownVisitId as SafetySosAlertFacts["lastKnownVisitId"],
    linkedIncidentId: row.linkedIncidentId as SafetySosAlertFacts["linkedIncidentId"],
  };
}

/** The `safety_sos_alert_state_history` row a `sos_state_history` effect writes (mirrors
 *  `write-service-drizzle.ts` / `m36-delivery-failed.ts`'s local `SosStateHistoryPort` implementation —
 *  `runEffects` always hands the port the SAME tx this cron opened, via its own `insertTx` parameter). */
function stateHistoryPort(): SosStateHistoryPort {
  return {
    async insert(insertTx, historyRow) {
      await (insertTx as DbClient).insert(SOS_HISTORY).values({
        organizationId: historyRow.organizationId,
        providerEntityId: historyRow.providerEntityId,
        locationId: historyRow.locationId,
        sosAlertId: historyRow.sosAlertId,
        fromState: historyRow.fromState as never,
        toState: historyRow.toState as never,
        transitionedAt: historyRow.transitionedAt,
        transitionedByMembershipId: historyRow.transitionedByMembershipId,
        reason: historyRow.reason,
      });
    },
  };
}

/** §2.5 — the version-guarded UPDATE. Returns `true` on a win, `false` on a lost race (someone else
 *  already moved this alert) — the caller logs+skips rather than treating a loss as a failure. */
async function applySosAlertPatch(
  tx: DbClient,
  sosAlertId: string,
  currentVersion: number,
  patch: {
    lifecycleState?: string;
    acknowledgedAt?: Date;
    acknowledgedByMembershipId?: string;
  },
  at: Date,
): Promise<boolean> {
  const updated = await tx
    .update(SOS)
    .set({
      ...(patch.lifecycleState ? { lifecycleState: patch.lifecycleState as never } : {}),
      version: currentVersion + 1,
      updatedAt: at,
    })
    .where(and(eq(SOS.id, sosAlertId), eq(SOS.version, currentVersion)))
    .returning({ version: SOS.version });
  return updated.length === 1;
}

/** Load one alert's facts plus its `stateEnteredAt` — the `transitioned_at` of its most recent
 *  `safety_sos_alert_state_history` row, or `posted_at` for an alert that has never moved. Because the
 *  terminus RE-PAGE loop writes no history row (§2.2.2 / `m20_ssash_no_self` — see `sos-alert.ts`'s
 *  `repageTerminus` doc comment), the most recent row for an alert CURRENTLY in `emergency_terminus` is
 *  always the entry into it, so `stateEnteredAt` and `terminusEnteredAt` are the same value by
 *  construction — no second query is needed for the terminus case. */
async function loadAlertWithStateEnteredAt(
  tx: DbClient,
  organizationId: string,
  sosAlertId: string,
): Promise<{
  alert: SafetySosAlertFacts;
  stateEnteredAt: IsoInstant;
  postedAt: IsoInstant;
} | null> {
  const [row] = await tx
    .select()
    .from(SOS)
    .where(and(eq(SOS.id, sosAlertId), eq(SOS.organizationId, organizationId)))
    .limit(1);
  if (!row) return null;
  const alert = sosFactsOf(row as never);
  const [history] = await tx
    .select({ transitionedAt: SOS_HISTORY.transitionedAt })
    .from(SOS_HISTORY)
    .where(
      and(eq(SOS_HISTORY.sosAlertId, sosAlertId), eq(SOS_HISTORY.organizationId, organizationId)),
    )
    .orderBy(desc(SOS_HISTORY.transitionedAt))
    .limit(1);
  const stateEnteredAt = (
    history?.transitionedAt ?? (row as { postedAt: Date }).postedAt
  ).toISOString();
  return { alert, stateEnteredAt: stateEnteredAt as IsoInstant, postedAt: alert.postedAt };
}

/** Apply an `escalate` decision. The tier-3 -> `emergency_terminus` rung is applied like any other rung and
 *  additionally records iteration 0 of the terminus intents in the SAME tx (see this file's header). The entry
 *  event is honest at emit time: nothing has been paged or dialled yet, so the flags are false/null. */
async function applyEscalate(
  tx: DbClient,
  deps: M20WorkerDeps,
  row: AlertAnchorRow,
  sosAlertId: string,
  alert: SafetySosAlertFacts,
  transition: SafetySosTransition,
  at: Date,
  atIso: IsoInstant,
  emergencyContactConsent: boolean,
): Promise<void> {
  const patch = await runEffects(tx, transition.effects, {
    organizationId: row.organizationId,
    providerEntityId: row.providerEntityId,
    locationId: row.locationId,
    sosAlertId,
    at,
    actorMembershipId: null, // §3.3 — a watchdog tier advance carries no membership.
    reason: "m20.sos-sla-watchdog.cron",
    outbox: deps.outbox,
    ...(deps.alerts ? { alerts: deps.alerts } : {}),
    stateHistory: stateHistoryPort(),
    aggregateKind: "safety_sos_alert",
    aggregateId: sosAlertId,
    payloads: {
      "m20.safety.sos_alert_escalated": {
        orgId: row.organizationId,
        providerEntityId: row.providerEntityId,
        occurredAt: atIso,
        sosAlertId,
        fromTier: transition.from,
        toTier: transition.to,
        escalatedAt: atIso,
        reasonCode: "sla_breach",
      },
      "m20.safety.sos_terminus_reached": terminusPayload(row, sosAlertId, atIso, 0, NO_EFFECTS_YET),
    },
    alertPayloads: {
      "m20.safety.sos_terminus_reached": terminusAlert(row, sosAlertId, atIso, 0, NO_EFFECTS_YET),
      "m20.safety.sos_alert_escalated": buildSosEscalatedAlert({
        orgId: row.organizationId as never,
        providerEntityId: row.providerEntityId as never,
        sosAlertId: sosAlertId as never,
        fromTier: transition.from as SafetySosLifecycleState,
        toTier: transition.to as SafetySosLifecycleState,
        escalatedAt: atIso,
        reasonCode: "sla_breach",
      }) as unknown as Record<string, unknown>,
    },
  });

  const won = await applySosAlertPatch(
    tx,
    sosAlertId,
    alert.version,
    { lifecycleState: patch.lifecycleState },
    at,
  );
  if (!won) {
    throw new Error("M20_SOS_WATCHDOG_STALE_VERSION");
  }
  if (transition.to === "emergency_terminus") {
    await recordTerminusIteration(tx, {
      anchor: row,
      sosAlertId,
      loopIteration: 0,
      at,
      consentGranted: emergencyContactConsent,
      pagerBound: deps.terminus?.pager !== undefined,
    });
  }
}

/** Apply the `expire_cancel_window` decision (header note 2's stale-delayed-job sweep). No caller-owned
 *  effects on this edge — always safe to complete. */
async function applyExpireCancelWindow(
  tx: DbClient,
  deps: M20WorkerDeps,
  row: { organizationId: string; providerEntityId: string; locationId: string | null },
  sosAlertId: string,
  alert: SafetySosAlertFacts,
  transition: SafetySosTransition,
  at: Date,
): Promise<void> {
  const patch = await runEffects(tx, transition.effects, {
    organizationId: row.organizationId,
    providerEntityId: row.providerEntityId,
    locationId: row.locationId,
    sosAlertId,
    at,
    actorMembershipId: null,
    reason: "m20.sos-sla-watchdog.cron",
    outbox: deps.outbox,
    ...(deps.alerts ? { alerts: deps.alerts } : {}),
    stateHistory: stateHistoryPort(),
    aggregateKind: "safety_sos_alert",
    aggregateId: sosAlertId,
    payloads: {},
    alertPayloads: {},
  });
  const won = await applySosAlertPatch(
    tx,
    sosAlertId,
    alert.version,
    { lifecycleState: patch.lifecycleState },
    at,
  );
  if (!won) {
    throw new Error("M20_SOS_WATCHDOG_STALE_VERSION");
  }
}

/** Apply a `terminus_repage` decision - one more turn of the loop for an alert already IN
 *  `emergency_terminus`. Not a transition (the state does not move), so no version-guarded patch.
 *
 *  Idempotent per loop period: only the tick whose `page_ops` intent insert WINS publishes the iteration's
 *  event/alert and plans its other intents; the rest of the period's ticks are no-ops. The payload flags are
 *  the ledger's truth as of this iteration, not a guess. */
async function applyTerminusRepage(
  tx: DbClient,
  deps: M20WorkerDeps,
  row: AlertAnchorRow,
  sosAlertId: string,
  effects: ReturnType<typeof repageTerminus>,
  loopIteration: number,
  at: Date,
  atIso: IsoInstant,
  emergencyContactConsent: boolean,
): Promise<void> {
  const { won } = await recordTerminusIteration(tx, {
    anchor: row,
    sosAlertId,
    loopIteration,
    at,
    consentGranted: emergencyContactConsent,
    pagerBound: deps.terminus?.pager !== undefined,
  });
  if (!won) return;
  const flags = await readLedgerFlags(tx, sosAlertId);
  await runEffects(tx, effects, {
    organizationId: row.organizationId,
    providerEntityId: row.providerEntityId,
    locationId: row.locationId,
    sosAlertId,
    at,
    actorMembershipId: null,
    reason: "m20.sos-sla-watchdog.cron",
    outbox: deps.outbox,
    ...(deps.alerts ? { alerts: deps.alerts } : {}),
    stateHistory: stateHistoryPort(),
    aggregateKind: "safety_sos_alert",
    aggregateId: sosAlertId,
    payloads: {
      "m20.safety.sos_terminus_reached": terminusPayload(
        row,
        sosAlertId,
        atIso,
        loopIteration,
        flags,
      ),
    },
    alertPayloads: {
      "m20.safety.sos_terminus_reached": terminusAlert(
        row,
        sosAlertId,
        atIso,
        loopIteration,
        flags,
      ),
    },
  });
}

type AlertAnchorRow = {
  organizationId: string;
  providerEntityId: string;
  locationId: string | null;
};

/** At terminus entry nothing has been paged, dialled or resolved yet - the ledger rows are only intents. */
const NO_EFFECTS_YET: TerminusLedgerFlags = {
  wardenxOpsPaged: false,
  emergencyContactCallInitiated: false,
  psapJurisdictionId: null,
};

/** The §4.10 `sos_terminus_reached` payload. Every flag comes from the ledger (`readLedgerFlags`): a call
 *  that was only planned is not "initiated", a page that was never acknowledged is not "paged". */
function terminusPayload(
  row: { organizationId: string; providerEntityId: string },
  sosAlertId: string,
  atIso: IsoInstant,
  loopIteration: number,
  flags: TerminusLedgerFlags,
): Record<string, unknown> {
  return {
    orgId: row.organizationId,
    providerEntityId: row.providerEntityId,
    occurredAt: atIso,
    sosAlertId,
    terminusReachedAt: atIso,
    loopIteration,
    emergencyContactCallInitiated: flags.emergencyContactCallInitiated,
    psapJurisdictionId: flags.psapJurisdictionId,
    wardenxOpsPaged: flags.wardenxOpsPaged,
  };
}

function terminusAlert(
  row: { organizationId: string; providerEntityId: string },
  sosAlertId: string,
  atIso: IsoInstant,
  loopIteration: number,
  flags: TerminusLedgerFlags,
): Record<string, unknown> {
  return buildSosTerminusAlert({
    orgId: row.organizationId as never,
    providerEntityId: row.providerEntityId as never,
    sosAlertId: sosAlertId as never,
    terminusReachedAt: atIso,
    loopIteration,
    emergencyContactCallInitiated: flags.emergencyContactCallInitiated,
    psapNumberAvailable: flags.psapJurisdictionId !== null,
  }) as unknown as Record<string, unknown>;
}

/** Decide-and-apply for one alert, in its own transaction so a lost race or a failure never aborts the
 *  rest of the org's tick. */
async function processOneAlert(
  deps: M20WorkerDeps,
  organizationId: string,
  sosAlertId: string,
  now: Date,
  log: (msg: string, meta: Record<string, unknown>) => void,
): Promise<void> {
  const atIso = now.toISOString() as IsoInstant;
  try {
    await withOrgContext(
      deps.db,
      { organizationId, userId: M20_WORKER_SYSTEM_USER_ID },
      async (handle) => {
        const tx = handle as DbClient;
        const loaded = await loadAlertWithStateEnteredAt(tx, organizationId, sosAlertId);
        if (!loaded) return; // settled/vanished between the org scan and this tx.
        const { alert, stateEnteredAt } = loaded;

        const policy: SafetyPolicyEffectiveDto = await deps.policy.policyAtTime(
          organizationId as OrgId,
          alert.postedAt,
        );
        const emergencyContactConsent = await emergencyContactConsentGrantedInTx(
          tx,
          organizationId,
          alert.postedByMembershipId,
          now,
        );

        const [row] = await tx
          .select({
            organizationId: SOS.organizationId,
            providerEntityId: SOS.providerEntityId,
            locationId: SOS.locationId,
          })
          .from(SOS)
          .where(and(eq(SOS.id, sosAlertId), eq(SOS.organizationId, organizationId)))
          .limit(1);
        if (!row) return;

        const decision = decideSosWatchdog({
          alert,
          stateEnteredAt,
          policy,
          nowIso: atIso,
          emergencyContactConsent,
          terminusEnteredAt: alert.lifecycleState === "emergency_terminus" ? stateEnteredAt : null,
        });

        switch (decision.kind) {
          case "none":
            return;
          case "expire_cancel_window":
            return applyExpireCancelWindow(
              tx,
              deps,
              row,
              sosAlertId,
              alert,
              decision.transition,
              now,
            );
          case "escalate":
            return applyEscalate(
              tx,
              deps,
              row,
              sosAlertId,
              alert,
              decision.transition,
              now,
              atIso,
              emergencyContactConsent,
            );
          case "terminus_repage":
            return applyTerminusRepage(
              tx,
              deps,
              row,
              sosAlertId,
              decision.effects,
              decision.loopIteration,
              now,
              atIso,
              emergencyContactConsent,
            );
        }
      },
    );
  } catch (err) {
    if (err instanceof Error && err.message === "M20_SOS_WATCHDOG_STALE_VERSION") {
      log("m20.sos-sla-watchdog: lost the version race for an alert — already handled elsewhere", {
        organizationId,
        sosAlertId,
      });
      return;
    }
    throw err;
  }
}

/**
 * §4.8 `m20.sos-sla-watchdog.cron` — fan out over every active org, scan every alert in a
 * non-terminal-for-the-watchdog state (the `ssa_org_active_idx` predicate — broader than
 * `ssa_sla_scan_idx` on purpose, since it also covers `raised`/`cancel_window_open` for the stale-sweep;
 * `sos-escalator.ts`'s own header explains why the sweep needs the wider index), and decide-and-apply
 * per alert.
 */
export async function runSosSlaWatchdogCron(deps: M20WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const log = (msg: string, meta: Record<string, unknown>): void => {
    // eslint-disable-next-line no-console -- cron workers in this codebase log via console (M9's own
    // `runReassessmentDueCron` precedent); a structured logger is threaded through Fastify's `app.log`
    // at the route layer, not into these standalone worker functions.
    console.log(msg, meta);
  };
  const orgs = await activeOrgsOf(deps).listActiveOrgs();
  for (const { organizationId } of orgs) {
    const alertIds = await withOrgContext(
      deps.db,
      { organizationId, userId: M20_WORKER_SYSTEM_USER_ID },
      async (handle) => {
        const tx = handle as DbClient;
        const rows = await tx
          .select({ id: SOS.id })
          .from(SOS)
          .where(
            and(
              eq(SOS.organizationId, organizationId),
              // Mirrors `ssa_org_active_idx`'s own predicate (schema comment: "the SLA watchdog's hot
              // path", `write-service-drizzle.ts`'s open-SOS-bracket check for the exact same clause).
              // Deliberately wider than `ssa_sla_scan_idx`: the header's note 2 sweep needs
              // `raised`/`cancel_window_open` too, which that narrower index excludes.
              sql`${SOS.lifecycleState} NOT IN ('resolved','cancelled_in_window','incident_opened')`,
            ),
          );
        return rows.map((r) => r.id as SafetySosAlertId);
      },
    );
    for (const sosAlertId of alertIds) {
      // One bad alert (a bad row, a failed ledger insert, a DB error) must not stop its siblings or, worse,
      // the terminus executor below: life-safety effects already recorded as pending are not gated on every
      // other alert processing cleanly. Log it loudly and move on; the next tick retries it.
      try {
        await runWithRequestContext({ organizationId, userId: M20_WORKER_SYSTEM_USER_ID }, () =>
          processOneAlert(deps, organizationId, sosAlertId, now, log),
        );
      } catch (err) {
        log("m20.sos-sla-watchdog: alert failed - continuing with the rest of the org", {
          organizationId,
          sosAlertId,
          error: err instanceof Error ? `${err.name}: ${err.message}` : "unknown",
        });
      }
    }
    // GAP-032: perform the terminus intents (page / dial / PSAP) the pass above just recorded - and any
    // earlier row still due or past its lease - outside every tenant tx. One org's executor failure must
    // not stop the next org's tick.
    try {
      await runTerminusExecutorForOrg(
        { db: deps.db, terminus: deps.terminus, now: deps.now ?? (() => new Date()) },
        organizationId,
      );
    } catch (err) {
      log("m20.sos-sla-watchdog: terminus executor failed for an org", {
        organizationId,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }
}

// ── backoff-string parsing (M20_QUEUE_PARAMS.backoff is a STRING; the M9/M25 duplication convention) ──

interface ParsedBackoff {
  readonly type: "exponential" | "fixed";
  readonly delay: number;
}

function parseDurationMs(token: string): number {
  const m = /^(\d+)(ms|s|m|h)$/.exec(token);
  if (!m) throw new Error(`M20_BACKOFF_PARSE: unrecognized duration token '${token}'`);
  const [, digits, unit] = m;
  const n = Number(digits);
  switch (unit) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    default:
      throw new Error(`M20_BACKOFF_PARSE: unreachable unit '${unit}'`);
  }
}

function parseBackoff(spec: string): ParsedBackoff {
  const head = spec.split(",")[0] ?? spec;
  const [type, duration] = head.trim().split(/\s+/);
  if (type !== "exponential" && type !== "fixed") {
    throw new Error(`M20_BACKOFF_PARSE: unrecognized backoff type '${type}' in '${spec}'`);
  }
  if (!duration) throw new Error(`M20_BACKOFF_PARSE: missing duration in '${spec}'`);
  return { type, delay: parseDurationMs(duration) };
}

// ── BullMQ construction (the M9/M25 registerMxCronWorkers / scheduleMxJobs template) ───────────────────

/** Construct the §4.8 cron `Worker`s (the caller owns lifecycle — `close()` on shutdown). */
export function registerM20CronWorkers(deps: M20WorkerDeps): Worker[] {
  return [
    new Worker(M20_QUEUES.sosSlaWatchdog, async () => runSosSlaWatchdogCron(deps), {
      connection: deps.connection,
      concurrency: M20_QUEUE_PARAMS.sosSlaWatchdog.concurrency,
    }),
    // GAP-061 — the lone-worker overdue check-in detector (every 30 s) and the §7.8 coverage-gap watchdog.
    new Worker(M20_QUEUES.overdueDetector, async () => runOverdueDetectorCron(deps), {
      connection: deps.connection,
      concurrency: M20_QUEUE_PARAMS.overdueDetector.concurrency,
    }),
    new Worker(M20_QUEUES.coverageGapWatchdog, async () => runCoverageGapWatchdogCron(deps), {
      connection: deps.connection,
      concurrency: M20_QUEUE_PARAMS.coverageGapWatchdog.concurrency,
    }),
  ];
}

/** Register the §4.8 repeatable schedules (`every` not `pattern` — the M33 `lagProbeEveryMs` precedent).
 *  Returns the `Queue`s so the composition root can `close()` them. */
export async function scheduleM20Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const specs = [
    {
      queue: M20_QUEUES.sosSlaWatchdog,
      name: M20_SOS_WATCHDOG_JOB_NAME,
      every: M20_JOB_SCHEDULES.sosSlaWatchdogEveryMs,
      params: M20_QUEUE_PARAMS.sosSlaWatchdog,
    },
    {
      queue: M20_QUEUES.overdueDetector,
      name: M20_OVERDUE_DETECTOR_JOB_NAME,
      every: M20_JOB_SCHEDULES.overdueDetectorEveryMs,
      params: M20_QUEUE_PARAMS.overdueDetector,
    },
    {
      queue: M20_QUEUES.coverageGapWatchdog,
      name: M20_COVERAGE_GAP_WATCHDOG_JOB_NAME,
      every: M20_JOB_SCHEDULES.coverageGapWatchdogEveryMs,
      params: M20_QUEUE_PARAMS.coverageGapWatchdog,
    },
  ] as const;
  const queues: Queue[] = [];
  for (const spec of specs) {
    const queue = new Queue(spec.queue, { connection });
    queues.push(queue);
    await queue.add(
      spec.name,
      {},
      {
        repeat: { every: spec.every },
        priority: spec.params.priority,
        attempts: spec.params.attempts,
        backoff: parseBackoff(spec.params.backoff),
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }
  return queues;
}
