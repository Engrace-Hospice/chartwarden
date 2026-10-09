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
// THE TERMINUS RUNG IS DELIBERATELY NOT COMPLETED HERE, MIRRORING `consumers/m36-delivery-failed.ts`'S
// OWN CHOICE FOR THE IDENTICAL EDGE CASE. `escalateSos` from `escalation_tier_3` reaches
// `emergency_terminus`, whose entry effects are `dial_emergency_contact` / `surface_psap_number` /
// `page_wardenx_ops` — all three `CALLER_OWNED_EFFECT_KINDS` (`../routes/effects-runner.ts`) that
// `runEffects` deliberately does not execute, and NO caller anywhere in this codebase implements a real
// telephony dial, an M40 jurisdiction lookup, or a platform page (confirmed: no production caller reaches
// `emergency_terminus` today — the "manual escalate" path the decider's own header cites as the ladder's
// other trigger has no live route either). Completing the transition here would write
// `lifecycleState = 'emergency_terminus'` and fire `sos_terminus_reached` while none of the three
// mandated life-safety actions actually happened — `m36-delivery-failed.ts`'s header calls exactly this
// "worse than not escalating: the record would say the life-safety chain reached its mandated end when
// nothing dialed anyone." This worker reuses that reasoning rather than re-deciding it: a tier-3 alert
// past its SLA is logged loudly (structured log, `sosTerminusUnsupported: true`) and left at
// `escalation_tier_3`, not silently dropped — the alert is still visible on the §4.2/§4.3 board at its
// current (breached) tier, which is real information, and the gap is filed as its own follow-up rather
// than papered over here. The re-page LOOP is still wired for an alert that reaches `emergency_terminus`
// by some future path (a manual-escalate route, once built) — `repageTerminus`'s effects are all
// outbox/alert, no caller-owned kinds, so applying them is safe today even though nothing can currently
// put an alert into that state.
import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import { runWithRequestContext, withOrgContext } from "@wardenx/tenancy";
import type {
  IsoInstant,
  MembershipId,
  OrgId,
  SafetyPolicyEffectiveDto,
  SafetyPolicyProvider,
  SafetySosAlertId,
  SafetySosLifecycleState,
} from "@wardenx/types";
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
import type { SosTerminusPort } from "./terminus-port";
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
const CONSENT = schema.safetyEmergencyContactConsent;

/** Build the {@link M20WorkerDeps} from the composition-root primitives (the M9/M25 `buildMxWorkerDeps` shape). */
export function buildM20WorkerDeps(deps: {
  connection: ConnectionOptions;
  db: DbClient;
  outbox: WriteOutboxPort;
  policy: SafetyPolicyProvider;
  alerts?: AlertPort;
  terminus?: SosTerminusPort;
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

/** §2.2.8 — is `emergency_contact_call` an ACTIVE consent for the clinician who raised the alert? Mirrors
 *  `write-service-drizzle.ts`'s `consentActive` / `consumers/m36-delivery-failed.ts`'s
 *  `emergencyContactConsentActive` — duplicated per that file's own convention (private to each caller's
 *  closure) rather than exported. */
async function emergencyContactConsentActive(
  tx: DbClient,
  organizationId: string,
  clinicianMembershipId: MembershipId,
  at: Date,
): Promise<boolean> {
  const [row] = await tx
    .select({ status: CONSENT.status, expiresAt: CONSENT.expiresAt })
    .from(CONSENT)
    .where(
      and(
        eq(CONSENT.organizationId, organizationId),
        eq(CONSENT.clinicianMembershipId, clinicianMembershipId),
        eq(CONSENT.consentPurpose, "emergency_contact_call"),
        eq(CONSENT.status, "granted"),
      ),
    )
    .limit(1);
  if (!row) return false;
  return row.expiresAt === null || row.expiresAt.getTime() > at.getTime();
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

/** Apply an `escalate` decision. Refuses the tier-3 → `emergency_terminus` rung specifically (see this
 *  file's header) — every other rung (`acknowledging → tier_1`, `tier_1 → tier_2`, `tier_2 → tier_3`)
 *  carries only `outbox`/`alert` effects and is applied in full. */
async function applyEscalate(
  tx: DbClient,
  deps: M20WorkerDeps,
  row: { organizationId: string; providerEntityId: string; locationId: string | null },
  sosAlertId: string,
  alert: SafetySosAlertFacts,
  transition: SafetySosTransition,
  at: Date,
  atIso: IsoInstant,
  log: (msg: string, meta: Record<string, unknown>) => void,
): Promise<void> {
  // GAP-032 — the terminus rung is entered only when the platform page was actually delivered. Without a
  // bound pager the rung is still refused (and logged loudly); with one, a page failure throws out of this
  // tx so nothing is recorded as "terminus reached" while nobody was paged.
  let opsPaged = false;
  if (transition.to === "emergency_terminus") {
    if (!deps.terminus) {
      log("m20.sos-sla-watchdog: tier-3 SLA breach, terminus rung refused (no ops pager bound)", {
        organizationId: row.organizationId,
        sosAlertId,
        sosTerminusUnsupported: true,
      });
      return;
    }
    opsPaged = await attemptOpsPage(deps.terminus, row, sosAlertId, 0, atIso, log);
    if (!opsPaged) return; // not recorded as reached: the next tick retries the page from tier 3
  }

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
      "m20.safety.sos_terminus_reached": terminusPayload(row, sosAlertId, atIso, 0, opsPaged),
    },
    alertPayloads: {
      ...(opsPaged
        ? {
            "m20.safety.sos_terminus_reached": terminusAlert(row, sosAlertId, atIso, 0),
          }
        : {}),
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

/** Apply a `terminus_repage` decision — one more turn of the loop for an alert already IN
 *  `emergency_terminus` (reachable only by a future manual-escalate route today; see this file's
 *  header). Not a transition (the state does not move), so no version-guarded patch either — only the
 *  outbox/alert effects.
 *
 *  `emergencyContactCallInitiated`/`psapJurisdictionId`/`wardenxOpsPaged` are ALWAYS `false`/`null`/
 *  `false` here, never derived from consent or anything else: `dial_emergency_contact` /
 *  `surface_psap_number` / `page_wardenx_ops` are `CALLER_OWNED_EFFECT_KINDS` `runEffects` does not
 *  execute (see this file's header — no caller anywhere implements them), so none of the three ever
 *  actually happens, and the payload says so rather than reporting an active consent as an initiated
 *  call nobody placed. */
async function applyTerminusRepage(
  tx: DbClient,
  deps: M20WorkerDeps,
  row: { organizationId: string; providerEntityId: string; locationId: string | null },
  sosAlertId: string,
  effects: ReturnType<typeof repageTerminus>,
  loopIteration: number,
  at: Date,
  atIso: IsoInstant,
): Promise<void> {
  // A failed re-page is still a tenant-facing re-alert (best effort); the payload reports the page honestly.
  const opsPaged = deps.terminus
    ? await attemptOpsPage(deps.terminus, row, sosAlertId, loopIteration, atIso, logM20Cron)
    : false;
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
        opsPaged,
      ),
    },
    alertPayloads: {
      "m20.safety.sos_terminus_reached": terminusAlert(row, sosAlertId, atIso, loopIteration),
    },
  });
}

/** Page WardenX ops; `true` only when the receiver acknowledged. A failure is logged loudly, never thrown, so
 *  one unreachable receiver cannot abort the rest of the org's alerts in the same tick. */
async function attemptOpsPage(
  port: SosTerminusPort,
  row: { organizationId: string; providerEntityId: string },
  sosAlertId: string,
  loopIteration: number,
  atIso: IsoInstant,
  log: (msg: string, meta: Record<string, unknown>) => void,
): Promise<boolean> {
  try {
    await port.pageOps({
      organizationId: row.organizationId,
      providerEntityId: row.providerEntityId,
      sosAlertId,
      loopIteration,
      at: atIso,
    });
    return true;
  } catch (error) {
    log("m20.sos-sla-watchdog: ops page FAILED for an alert at the emergency terminus", {
      organizationId: row.organizationId,
      sosAlertId,
      loopIteration,
      sosTerminusPageFailed: true,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** The §4.10 `sos_terminus_reached` payload. `emergencyContactCallInitiated` and `psapJurisdictionId` are
 *  never derived from consent or config: the dial (M36 voice) and the PSAP lookup (M40) have no
 *  implementer, so they did not happen and the payload says so. `wardenxOpsPaged` is true only when the
 *  platform page was delivered. */
function terminusPayload(
  row: { organizationId: string; providerEntityId: string },
  sosAlertId: string,
  atIso: IsoInstant,
  loopIteration: number,
  wardenxOpsPaged: boolean,
): Record<string, unknown> {
  return {
    orgId: row.organizationId,
    providerEntityId: row.providerEntityId,
    occurredAt: atIso,
    sosAlertId,
    terminusReachedAt: atIso,
    loopIteration,
    emergencyContactCallInitiated: false,
    psapJurisdictionId: null,
    wardenxOpsPaged,
  };
}

function terminusAlert(
  row: { organizationId: string; providerEntityId: string },
  sosAlertId: string,
  atIso: IsoInstant,
  loopIteration: number,
): Record<string, unknown> {
  return buildSosTerminusAlert({
    orgId: row.organizationId as never,
    providerEntityId: row.providerEntityId as never,
    sosAlertId: sosAlertId as never,
    terminusReachedAt: atIso,
    loopIteration,
    emergencyContactCallInitiated: false,
    psapNumberAvailable: false,
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
        const emergencyContactConsent = await emergencyContactConsentActive(
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
              log,
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
      await runWithRequestContext({ organizationId, userId: M20_WORKER_SYSTEM_USER_ID }, () =>
        processOneAlert(deps, organizationId, sosAlertId, now, log),
      );
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
