// apps/backend/src/modules/34-saas-tenant-platform/feature-flag-kill-switch-ports.ts — M34 (§4.1/§4.7).
//
// The carriers M1's `FeatureFlagAdmin.setKillSwitch` needs to be the AUDITED emergency control the spec
// defines, bound over M34's own platform plumbing: the audited `withPlatformContext` tx (job
// `M34_PLATFORM_JOB_ID`, the `platform.bypass_invoked` row on entry), the catalog-validated `m34.*` outbox
// publisher, M36's `AlertEmitter` (resolved lazily — `getSeam` throws on an unregistered name) and the
// critical audit writer. The bootstrap flag store takes no edge on any of them; they arrive here as ports.
import type { DbClient } from "@wardenx/db";
import type { AlertEmitter } from "@wardenx/messaging";
import { type PlatformBypassAuditor, withPlatformContext } from "@wardenx/tenancy";
import type { FeatureFlagKillSwitchPorts } from "../../bootstrap/feature-flag-store";
import { getSeam } from "../../bootstrap/index";
import type { OutboxPublishPort } from "./routes/platform/service-drizzle";
import { M34_PLATFORM_JOB_ID } from "./wiring";

export interface FeatureFlagKillSwitchPortDeps {
  readonly platformDb: DbClient;
  readonly auditBypass: PlatformBypassAuditor<DbClient>;
  readonly outbox: OutboxPublishPort;
  /** Writes the null-org critical `audit_event` row (the SECURITY DEFINER platform-event writer). */
  readonly auditCritical: (
    tx: DbClient,
    event: {
      eventType: string;
      resourceId: string;
      correlationId: string;
      context: Record<string, unknown>;
    },
  ) => Promise<void>;
  /** Defaults to the boot-registered M36 `AlertEmitter` seam, resolved at call time. */
  readonly alerts?: Pick<AlertEmitter, "emit">;
}

export function buildFeatureFlagKillSwitchPorts(
  deps: FeatureFlagKillSwitchPortDeps,
): FeatureFlagKillSwitchPorts {
  return {
    runPlatform<T>(reason: string, fn: (tx: DbClient) => Promise<T>): Promise<T> {
      return withPlatformContext<DbClient, T>(
        deps.platformDb,
        { jobId: M34_PLATFORM_JOB_ID, reason, crossTenant: true },
        deps.auditBypass,
        fn,
      );
    },
    publish: (tx, input) => deps.outbox.publish(tx, input),
    audit: (tx, event) => deps.auditCritical(tx, event),
    alert: (organizationId, input) =>
      (deps.alerts ?? (getSeam("AlertEmitter") as AlertEmitter)).emit(organizationId, input),
  };
}
