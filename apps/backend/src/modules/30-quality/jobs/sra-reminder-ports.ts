// apps/backend/src/modules/30-quality/jobs/sra-reminder-ports.ts — GAP-155.
//
// The two ports of the `m30.sra_reminders` cron (§4.9 / W-M30-30), previously fail-closed `unboundWorkerPort`s
// that made every 09:00 run throw:
//   - `cycles`  — the open-SRA-cycle scan: fan out across the active orgs, one RLS-scoped read per org
//                 (a cron tick is not a request — org-explicit `withOrgContext`, never an ambient context);
//   - `alerts`  — the §4.9 dispatch: emit through the M36 AlertEmitter (structural type — M30's manifest does
//                 not depend on M36's internals), severity taken from the M30_ALERTS def for the payload type.
import type { DbClient } from "@chartwarden/db";
import type { OpenSraCycle, OpenSraCycleReadPort, SraReminderAlertPort } from "@chartwarden/quality";
import { M30_ALERTS } from "@chartwarden/quality";
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";

/** `withOrgContext` carries no acting human for a cron (the M4 audit trigger maps "" to NULL). */
const SYSTEM_USER_ID = "";

/** One org's open (un-closed) SRA cycles with their anniversary — RLS-scoped, org-explicit. */
export async function listOpenSraCyclesForOrg(
  db: DbClient,
  organizationId: string,
): Promise<readonly OpenSraCycle[]> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const res = await tx.execute(sql`
      SELECT id, due_at AS "dueAt"
        FROM sra_cycle
       WHERE organization_id = ${organizationId}::uuid
         AND status <> 'closed'::m30_sra_cycle_status`);
    const rows = (res as unknown as { rows?: { id: string; dueAt: string | Date }[] }).rows ?? [];
    return rows.map((r) => ({ organizationId, cycleId: r.id, dueAt: new Date(r.dueAt) }));
  });
}

/** The structural slice of the M36 `AlertEmitter` the cron needs. */
export interface SraAlertEmitterLike {
  emit(
    orgId: string,
    input: {
      eventType: string;
      payload: Record<string, unknown>;
      severity: "info" | "warn" | "critical";
      correlationId: string;
    },
  ): Promise<unknown>;
}

export interface SraCycleScanDeps {
  readonly listActiveOrgs: () => Promise<readonly { readonly organizationId: string }[]>;
  readonly listOpenCyclesForOrg: (organizationId: string) => Promise<readonly OpenSraCycle[]>;
  readonly warn?: (message: string, context: Record<string, string>) => void;
}

/** Build the open-cycle scan; a failing org is logged and skipped so one tenant cannot starve the rest. */
export function buildSraReminderCyclePort(deps: SraCycleScanDeps): OpenSraCycleReadPort {
  return {
    async listOpenCyclesWithDue() {
      const orgs = await deps.listActiveOrgs();
      const out: OpenSraCycle[] = [];
      for (const { organizationId } of orgs) {
        try {
          out.push(...(await deps.listOpenCyclesForOrg(organizationId)));
        } catch (error) {
          deps.warn?.("m30.sra_reminders: open-cycle scan failed for org", {
            organizationId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return out;
    },
  };
}

type EmitSeverity = "info" | "warn" | "critical";

function severityFor(payloadType: string): EmitSeverity {
  const def = Object.values(M30_ALERTS).find((d) => d.payloadType === payloadType);
  if (def === undefined) return "warn";
  if (def.severity === "info") return "info";
  if (def.severity === "critical") return "critical";
  return "warn";
}

/** Build the §4.9 dispatch over the M36 emitter. One alert per (type, cycle, UTC day) — re-runs dedupe. */
export function buildSraReminderAlertPort(
  emitter: SraAlertEmitterLike,
  now: () => Date,
): SraReminderAlertPort {
  return {
    async dispatch(payloadType, payload) {
      const organizationId = payload.organizationId;
      const cycleId = payload.cycleId;
      if (typeof organizationId !== "string" || organizationId === "") {
        throw new Error("m30.sra_reminders: alert payload carries no organizationId");
      }
      await emitter.emit(organizationId, {
        eventType: payloadType,
        severity: severityFor(payloadType),
        correlationId: `m30:sra:${payloadType}:${String(cycleId)}:${now().toISOString().slice(0, 10)}`,
        payload,
      });
    },
  };
}
