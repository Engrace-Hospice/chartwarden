// apps/backend/src/modules/31-portal/jobs/late-join-watchdog.ts - M31 `m31.telehealth-late-join-watchdog.cron`
// (spec 4.8, GAP-159): every 5 minutes, abort telehealth rooms that are past the 15-minute join window with
// no visit in progress. `telehealth_visit` carries no scheduled-start column (the room is minted lazily on the
// first clinician join, F-220), so the window is measured from `room_minted_at`. The abort is one RLS-scoped
// UPDATE per org (idempotent: it only matches non-terminal, non-`in_progress` rows) and emits
// `m31.telehealth.visit_ended` in the same transaction. The vendor room is NOT ended here: the room-id cipher
// needs the per-tenant DEK and the vendor adapter is unbound in production (see docs/history/m31-portal-deferrals.md).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { TelehealthEndReason, TelehealthLifecycleState } from "@wardenx/types";
import { and, eq, inArray, lt } from "drizzle-orm";
import type { M31EventEmitter } from "../events";
import type { M31ActiveOrgListPort } from "./post-discharge-grace-sweep";
import { M31_WORKER_SYSTEM_USER_ID } from "./queues";

const TV = schema.telehealthVisits;

/** Spec 4.8: rooms past the 15-minute visit window with no joiner are aborted. */
export const M31_LATE_JOIN_WINDOW_MS = 15 * 60_000;

const PRE_VISIT_STATES: readonly TelehealthLifecycleState[] = [
  "room_minted",
  "patient_joined",
  "clinician_joined",
];

/** PURE - who failed to show, from the lifecycle state the room stalled in. */
export function lateJoinEndReason(state: TelehealthLifecycleState): TelehealthEndReason {
  if (state === "patient_joined") return "clinician_dropped";
  if (state === "clinician_joined") return "patient_dropped";
  return "both_dropped";
}

export interface LateJoinWatchdogDeps {
  readonly db: DbClient;
  readonly activeOrgs: M31ActiveOrgListPort;
  readonly events?: M31EventEmitter;
  readonly now?: () => Date;
  readonly warn?: (message: string, context: Record<string, string>) => void;
}

export interface LateJoinOrgResult {
  readonly organizationId: string;
  readonly aborted: number;
}

async function abortStaleRoomsForOrg(
  deps: LateJoinWatchdogDeps,
  organizationId: string,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - M31_LATE_JOIN_WINDOW_MS);
  return withOrgContext(
    deps.db,
    { organizationId, userId: M31_WORKER_SYSTEM_USER_ID },
    async (scoped) => {
      const tx = scoped as unknown as DbClient;
      const stale = await tx
        .select({ id: TV.id, m17VisitId: TV.m17VisitId, state: TV.lifecycleState })
        .from(TV)
        .where(
          and(
            eq(TV.organizationId, organizationId),
            inArray(TV.lifecycleState, [...PRE_VISIT_STATES]),
            lt(TV.roomMintedAt, cutoff),
          ),
        );
      let aborted = 0;
      for (const room of stale) {
        const endReason = lateJoinEndReason(room.state);
        // Guard on the state we read so a join racing the sweep wins (the row is simply left alone).
        const done = await tx
          .update(TV)
          .set({
            lifecycleState: "ended_aborted",
            endReason,
            visitEndedAt: now,
            updatedAt: now,
          })
          .where(and(eq(TV.id, room.id), eq(TV.lifecycleState, room.state)))
          .returning({ id: TV.id });
        if (done.length === 0) continue;
        aborted += 1;
        await deps.events?.emitInTx(
          tx,
          organizationId,
          "m31.telehealth.visit_ended",
          { kind: "telehealth_visit", id: room.id },
          {
            telehealthVisitId: room.id,
            m17VisitId: room.m17VisitId,
            lifecycleState: "ended_aborted",
            endReason,
          },
        );
      }
      return aborted;
    },
  );
}

/** One watchdog pass over every active org; a failing org is logged and never stops the rest. */
export async function runLateJoinWatchdogOnce(
  deps: LateJoinWatchdogDeps,
): Promise<readonly LateJoinOrgResult[]> {
  const now = (deps.now ?? (() => new Date()))();
  const results: LateJoinOrgResult[] = [];
  for (const { organizationId } of await deps.activeOrgs.listActiveOrgs()) {
    try {
      results.push({
        organizationId,
        aborted: await abortStaleRoomsForOrg(deps, organizationId, now),
      });
    } catch (error) {
      deps.warn?.("m31.telehealth-late-join-watchdog: org pass failed", {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
