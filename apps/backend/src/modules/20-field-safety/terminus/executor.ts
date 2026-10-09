// apps/backend/src/modules/20-field-safety/terminus/executor.ts - GAP-032: performs the SOS terminus intents
// recorded in `safety_sos_terminus_action`, OUTSIDE any tenant transaction.
//
// Per row: (1) claim in a short tx (lease, attempts+1), (2) re-read the alert and bail to `superseded` the
// instant a human has acknowledged / resolved it, (3) perform the effect with no tx held, (4) settle in a
// short tx. A crashed executor leaves a row `attempting` past its lease; the next claim recovers it. A
// recovered DIAL row is NOT re-placed (a second automated call to a spouse seconds after the first is worse
// than a late redial): it settles `failed / possible_duplicate` and the 10-minute redial rule takes over.
//
// Workers are not requests (CLAUDE.md): every step runs under `runWithRequestContext` / `withOrgContext` with
// the empty system actor, exactly like the watchdog that wrote the intents.
import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import { runWithRequestContext, withOrgContext } from "@wardenx/tenancy";
import type { MembershipId, SafetySosLifecycleState } from "@wardenx/types";
import { and, eq } from "drizzle-orm";
import { OpsPageError } from "../jobs/terminus-port";
import { M20_WORKER_SYSTEM_USER_ID, logM20Cron } from "../jobs/worker-support";
import type { TerminusDeps } from "./deps";
import { dialSettlement } from "./dial";
import {
  type ClaimedTerminusAction,
  type RetryOrFail,
  type TerminusSettlement,
  claimDueTerminusActions,
  settleTerminusAction,
} from "./ledger";
import { TERMINUS_MAX_ROW_ATTEMPTS, retryBackoffMs } from "./policy";
import { loadPositionSource, openPosition, resolvePsapSettlement } from "./psap";

const ALERT = schema.safetySosAlert;
/** Rows claimed per org per tick: the effect list per alert is tiny; this only bounds a backlog. */
const CLAIM_BATCH = 25;
const STILL_AT_TERMINUS: SafetySosLifecycleState = "emergency_terminus";

export interface TerminusExecutorRuntime {
  readonly db: DbClient;
  readonly terminus: TerminusDeps | undefined;
  readonly now: () => Date;
}

interface AlertFacts {
  readonly lifecycleState: SafetySosLifecycleState;
  readonly postedByMembershipId: MembershipId;
  readonly locationId: string | null;
}

async function loadAlert(db: DbClient, row: ClaimedTerminusAction): Promise<AlertFacts | null> {
  return withOrgContext(
    db,
    { organizationId: row.organizationId, userId: M20_WORKER_SYSTEM_USER_ID },
    async (handle) => {
      const [alert] = await (handle as DbClient)
        .select({
          lifecycleState: ALERT.lifecycleState,
          postedByMembershipId: ALERT.postedByMembershipId,
          locationId: ALERT.locationId,
        })
        .from(ALERT)
        .where(and(eq(ALERT.id, row.sosAlertId), eq(ALERT.organizationId, row.organizationId)))
        .limit(1);
      return alert
        ? {
            lifecycleState: alert.lifecycleState as SafetySosLifecycleState,
            postedByMembershipId: alert.postedByMembershipId as MembershipId,
            locationId: alert.locationId,
          }
        : null;
    },
  );
}

/** A transient failure retries in place with backoff; past the row budget it settles `failed`. */
function makeRetryOrFail(row: ClaimedTerminusAction, now: Date): RetryOrFail {
  return (outcome) =>
    row.attempts >= TERMINUS_MAX_ROW_ATTEMPTS
      ? { status: "failed", outcomeCode: outcome }
      : {
          status: "retry",
          outcomeCode: outcome,
          nextAttemptAt: new Date(now.getTime() + retryBackoffMs(row.attempts)),
        };
}

async function performAction(
  runtime: TerminusExecutorRuntime,
  deps: TerminusDeps | undefined,
  row: ClaimedTerminusAction,
  alert: AlertFacts,
  now: Date,
): Promise<TerminusSettlement> {
  const retryOrFail = makeRetryOrFail(row, now);
  switch (row.kind) {
    case "page_ops": {
      if (deps?.pager === undefined) return { status: "skipped", outcomeCode: "pager_unbound" };
      try {
        await deps.pager.pageOps({
          organizationId: row.organizationId,
          providerEntityId: row.providerEntityId,
          sosAlertId: row.sosAlertId,
          loopIteration: row.loopIteration,
          at: now.toISOString(),
          idempotencyKey: row.idempotencyKey,
        });
        return { status: "succeeded", outcomeCode: "ok", externalRef: `sos:${row.sosAlertId}` };
      } catch (error) {
        return retryOrFail(error instanceof OpsPageError ? error.outcome : "timeout");
      }
    }
    case "dial_contact": {
      if (deps === undefined) return { status: "skipped", outcomeCode: "dial_disabled" };
      return dialSettlement({
        deps,
        db: runtime.db,
        row,
        clinicianMembershipId: alert.postedByMembershipId,
        now,
        retryOrFail,
      });
    }
    case "resolve_psap": {
      if (deps === undefined) return { status: "skipped", outcomeCode: "jurisdiction_unavailable" };
      const source = await withOrgContext(
        runtime.db,
        { organizationId: row.organizationId, userId: M20_WORKER_SYSTEM_USER_ID },
        (handle) => loadPositionSource(handle as DbClient, row.organizationId, row.sosAlertId),
      );
      const point = await openPosition(source, row.organizationId, deps.decipher);
      return resolvePsapSettlement(
        deps,
        { organizationId: row.organizationId, locationId: alert.locationId, point },
        retryOrFail,
      );
    }
  }
}

async function settle(
  db: DbClient,
  row: ClaimedTerminusAction,
  settlement: TerminusSettlement,
  at: Date,
) {
  await withOrgContext(
    db,
    { organizationId: row.organizationId, userId: M20_WORKER_SYSTEM_USER_ID },
    (handle) => settleTerminusAction(handle as DbClient, row.id, settlement, at),
  );
}

async function executeClaimed(
  runtime: TerminusExecutorRuntime,
  row: ClaimedTerminusAction,
): Promise<void> {
  const now = runtime.now();
  let settlement: TerminusSettlement;
  try {
    const alert = await loadAlert(runtime.db, row);
    if (alert === null || alert.lifecycleState !== STILL_AT_TERMINUS) {
      // The human-in-the-loop exit: an acknowledgment between decision and effect prevents the effect.
      settlement = { status: "superseded", outcomeCode: "superseded_ack" };
    } else if (row.kind === "dial_contact" && row.recoveredFromExpiredLease) {
      settlement = { status: "failed", outcomeCode: "possible_duplicate" };
    } else {
      settlement = await performAction(runtime, runtime.terminus, row, alert, now);
    }
  } catch (error) {
    // Never include the error message: it could carry a destination. The name is enough for ops.
    logM20Cron("m20.sos-terminus: executor step threw", {
      organizationId: row.organizationId,
      sosAlertId: row.sosAlertId,
      actionKind: row.kind,
      error: error instanceof Error ? error.name : "unknown",
    });
    settlement = makeRetryOrFail(row, now)("vendor_refused");
  }
  await settle(runtime.db, row, settlement, runtime.now());
  logM20Cron("m20.sos-terminus: action settled", {
    organizationId: row.organizationId,
    sosAlertId: row.sosAlertId,
    actionKind: row.kind,
    loopIteration: row.loopIteration,
    status: settlement.status,
    outcomeCode: settlement.outcomeCode,
  });
}

/** Claim and perform every due terminus action for one org. Safe to call concurrently (leases + SKIP LOCKED). */
export async function runTerminusExecutorForOrg(
  runtime: TerminusExecutorRuntime,
  organizationId: string,
): Promise<number> {
  const claimed = await withOrgContext(
    runtime.db,
    { organizationId, userId: M20_WORKER_SYSTEM_USER_ID },
    (handle) =>
      claimDueTerminusActions(handle as DbClient, organizationId, runtime.now(), CLAIM_BATCH),
  );
  for (const row of claimed) {
    await runWithRequestContext({ organizationId, userId: M20_WORKER_SYSTEM_USER_ID }, () =>
      executeClaimed(runtime, row),
    );
  }
  return claimed.length;
}
