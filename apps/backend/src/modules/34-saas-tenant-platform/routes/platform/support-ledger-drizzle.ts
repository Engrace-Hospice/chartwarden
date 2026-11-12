// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/support-ledger-drizzle.ts — slice 7 (7S).
//
// The recorder behind the ledger hook (./support-ledger-hook.ts), over the PLATFORM credential. One audited platform transaction:
// resolve the tenant's organization from its slug, find the operator's OPEN session on it (their membership, not closed, not
// past its expiry), and append one `ops.write` row to the TENANT's ledger. The platform carrier is the only role that may write
// that kind (migration 1484 pins the tenant role to `session.close`), so a ledger row can never be forged from the tenant lane.
// When the operator holds several open sessions on the tenant (one per consent grant) the row goes to the most recently started.
// No open session: nothing is written. The platform-context entry itself is audited like every other (`platform.bypass_invoked`).
import { type DbClient, schema } from "@chartwarden/db";
import { OPS_WRITE_EVENT_KIND, SupportRepository } from "@chartwarden/saas-tenant-platform";
import { type PlatformBypassAuditor, withPlatformContext } from "@chartwarden/tenancy";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { SupportLedgerRecorder } from "./support-ledger-hook";

export interface DrizzleSupportLedgerDeps {
  /** The separately-pooled platform credential (BYPASSRLS carrier). */
  readonly platformDb: DbClient;
  readonly auditBypass: PlatformBypassAuditor<DbClient>;
  /** The registered platform-job id (allowlisted at boot). */
  readonly platformJobId: string;
  readonly now: () => Date;
}

export function createDrizzleSupportLedgerRecorder(
  deps: DrizzleSupportLedgerDeps,
): SupportLedgerRecorder {
  const S = schema.supportSession;
  return {
    async recordOpsWrite(write) {
      await withPlatformContext(
        deps.platformDb,
        {
          jobId: deps.platformJobId,
          reason: "m34 support ledger: operator write on a tenant",
          crossTenant: true,
        },
        deps.auditBypass,
        async (tx) => {
          const [org] = await tx
            .select({ id: schema.organizations.id })
            .from(schema.organizations)
            .where(eq(schema.organizations.slug, write.orgSlug))
            .limit(1);
          if (!org) return;
          const at = deps.now();
          const [session] = await tx
            .select({ id: S.id })
            .from(S)
            .where(
              and(
                eq(S.organizationId, org.id),
                eq(S.actorMembershipId, write.actorMembershipId),
                isNull(S.closedAt),
                gt(S.expiresAt, at),
              ),
            )
            .orderBy(desc(S.startedAt))
            .limit(1);
          if (!session) return;
          await new SupportRepository(tx).appendSessionEvent({
            organizationId: org.id,
            supportSessionId: session.id,
            eventKind: OPS_WRITE_EVENT_KIND,
            occurredAt: at,
            actorIp: write.actorIp,
            context: { route: write.route, method: write.method, status: write.status },
          });
        },
      );
    },
  };
}
