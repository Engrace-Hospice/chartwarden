// apps/backend/src/modules/31-portal/jobs/signature-reminder-sweep.ts - ADR-0107 D7: a daily reminder for every signature request that is
// still waiting for the patient or their representative. Decision: the request is announced once when sent, then reminded daily until it is
// signed or voided, with NO expiry. This sweep owns only the CADENCE: it stamps `last_reminded_at` / `reminder_count` and emits
// `m31.signature_request.reminded` in the same transaction; delivering the reminder (push) is a consumer of that event.
//
// Idempotent and safe to run twice: the UPDATE only matches a still-`pending` row that has not been reminded inside the interval, so a second
// tick, a retry or two workers cannot remind the same request twice. `uploaded_pending_review` is not reminded (the patient has acted; staff
// owe the next step). A failing org is logged and does not stop the rest. Bounded per org so a backlog drains over several ticks.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { M31EventEmitter } from "../events";
import type { M31ActiveOrgListPort } from "./post-discharge-grace-sweep";
import { M31_WORKER_SYSTEM_USER_ID } from "./queues";

const SR = schema.portalSignatureRequests;

/** One day less an hour: a daily tick that lands a few minutes early or late must not skip a day. */
export const M31_SIGNATURE_REMINDER_INTERVAL_MS = 23 * 60 * 60_000;
/** Most requests one org's tick may remind; the rest wait for the next tick, oldest first. */
export const M31_SIGNATURE_REMINDER_MAX_PER_ORG_PER_RUN = 500;

export interface SignatureReminderSweepDeps {
  readonly db: DbClient;
  readonly activeOrgs: M31ActiveOrgListPort;
  readonly events?: M31EventEmitter;
  readonly now?: () => Date;
  readonly warn?: (message: string, context: Record<string, string>) => void;
}

export interface SignatureReminderOrgResult {
  readonly organizationId: string;
  readonly reminded: number;
}

async function remindOrg(
  deps: SignatureReminderSweepDeps,
  organizationId: string,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - M31_SIGNATURE_REMINDER_INTERVAL_MS);
  // Due = pending, and the last announcement (the request itself, else the last reminder) is older than the interval.
  const due = or(
    and(isNull(SR.lastRemindedAt), lt(SR.requestedAt, cutoff)),
    lt(SR.lastRemindedAt, cutoff),
  );
  return withOrgContext(
    deps.db,
    { organizationId, userId: M31_WORKER_SYSTEM_USER_ID },
    async (scoped) => {
      const tx = scoped as unknown as DbClient;
      const candidates = await tx
        .select({ id: SR.id })
        .from(SR)
        .where(and(eq(SR.status, "pending"), due))
        .orderBy(asc(sql`coalesce(${SR.lastRemindedAt}, ${SR.requestedAt})`))
        .limit(M31_SIGNATURE_REMINDER_MAX_PER_ORG_PER_RUN);
      let reminded = 0;
      for (const { id } of candidates) {
        // Guarded on the same predicate: a request signed, voided or reminded since the read is simply left alone.
        const [row] = await tx
          .update(SR)
          .set({ lastRemindedAt: now, reminderCount: sql`${SR.reminderCount} + 1` })
          .where(and(eq(SR.id, id), eq(SR.status, "pending"), due))
          .returning();
        if (!row) continue;
        await deps.events?.emitInTx(
          tx,
          organizationId,
          "m31.signature_request.reminded",
          { kind: "portal_signature_request", id: row.id },
          {
            requestId: row.id,
            patientId: row.patientId,
            docKind: row.docKind,
            reminderCount: row.reminderCount,
          },
        );
        reminded += 1;
      }
      return reminded;
    },
  );
}

/** One sweep over every active org. Exported for tests and for the BullMQ processor. */
export async function runSignatureReminderSweepOnce(
  deps: SignatureReminderSweepDeps,
): Promise<readonly SignatureReminderOrgResult[]> {
  const now = (deps.now ?? (() => new Date()))();
  const results: SignatureReminderOrgResult[] = [];
  for (const { organizationId } of await deps.activeOrgs.listActiveOrgs()) {
    try {
      results.push({ organizationId, reminded: await remindOrg(deps, organizationId, now) });
    } catch (error) {
      deps.warn?.("m31 signature reminder sweep failed for an org", {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
