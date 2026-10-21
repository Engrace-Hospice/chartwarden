// apps/backend/src/modules/03-authorization/jobs/close-engagements.ts — GAP-011 the `authz.close_engagements`
// cron (M3 spec §2.3.3 / §4.5.1), which was never built: nothing flipped a scheduled engagement to `active`
// or an expired one to `closed`, and the auditor sessions minted for it were never revoked.
//
// Per org, one transaction: scheduled→active when the window has opened, scheduled|active→closed at
// `end_at`, each close publishing `m3.engagement.closed` on the SAME tx. After commit the engagement's
// unconsumed auditor magic links are revoked through an injected port (M2 owns that table; M3 does not
// depend on M2 — the composition root binds `revokeAuditorMagicLinksForEngagement`). Idempotent: the
// UPDATEs are guarded by the status predicate, and a revoke of an already-revoked link is a no-op.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, gt, inArray, lte } from "drizzle-orm";
import type { M3OutboxPublisher } from "../authz-ports";

const E = schema.auditorEngagements;

/** The platform job id the active-org enumeration enters `withPlatformContext` under (registered at boot). */
export const M3_CLOSE_ENGAGEMENTS_PLATFORM_JOB_ID = "m3.close_engagements";
export const M3_CLOSE_ENGAGEMENTS_QUEUE = "authz.close_engagements";
/** §4.5.1: every five minutes. */
export const M3_CLOSE_ENGAGEMENTS_CRON = "*/5 * * * *";

export type EngagementTransition = "activate" | "close" | "none";

/** The pure §2.3.3 transition rule. `closed`/`cancelled` are terminal. */
export function planEngagementTransition(
  engagement: { status: string; startAt: Date; endAt: Date },
  now: Date,
): EngagementTransition {
  if (engagement.status !== "scheduled" && engagement.status !== "active") return "none";
  if (engagement.endAt.getTime() <= now.getTime()) return "close";
  if (engagement.status === "scheduled" && engagement.startAt.getTime() <= now.getTime()) {
    return "activate";
  }
  return "none";
}

export interface CloseEngagementsDeps {
  readonly db: DbClient;
  readonly outbox?: M3OutboxPublisher;
  /** Revokes the engagement's unconsumed auditor magic links; returns how many. */
  readonly revokeAuditorLinks?: (organizationId: string, engagementId: string) => Promise<number>;
  readonly now?: () => Date;
}

export interface CloseEngagementsResult {
  readonly activated: number;
  readonly closed: number;
}

/** Apply the transitions for one org. */
export async function closeEngagementsForOrg(
  deps: CloseEngagementsDeps,
  organizationId: string,
): Promise<CloseEngagementsResult> {
  const now = (deps.now ?? (() => new Date()))();
  const closedIds = await withOrgContext(deps.db, { organizationId, userId: "" }, async (tx) => {
    const activated = await tx
      .update(E)
      .set({ status: "active" })
      .where(
        and(
          eq(E.organizationId, organizationId),
          eq(E.status, "scheduled"),
          lte(E.startAt, now),
          gt(E.endAt, now), // a window that already ended is closed below, never activated for an instant
        ),
      )
      .returning({ id: E.id });
    const closed = await tx
      .update(E)
      .set({ status: "closed" })
      .where(
        and(
          eq(E.organizationId, organizationId),
          inArray(E.status, ["scheduled", "active"]),
          lte(E.endAt, now),
        ),
      )
      .returning({ id: E.id });
    for (const row of closed) {
      await deps.outbox?.publish(tx as never, {
        eventName: "m3.engagement.closed",
        payload: { engagementId: row.id, organizationId },
        organizationId,
        aggregateKind: "auditor_engagement",
        aggregateId: row.id,
      });
    }
    return { ids: closed.map((r) => r.id), activated: activated.length };
  });
  for (const engagementId of closedIds.ids) {
    await deps.revokeAuditorLinks?.(organizationId, engagementId);
  }
  return { activated: closedIds.activated, closed: closedIds.ids.length };
}
