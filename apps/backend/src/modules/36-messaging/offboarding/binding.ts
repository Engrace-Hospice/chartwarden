// M36 WP 5.9 (ADR-0084) - the composition of the workforce-offboarding operation: the standing check, the audit writer and the ordered steps.
// No table is added: each step recounts the live rows, and the record of what a run did is its audit row (ids and counts only).
import { type AuditExecutor, audit } from "@chartwarden/audit";
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";
import type { SupervisorAttentionDeps } from "../ack-escalation/supervisor-attention";
import type { AckService } from "../ack-requests/ack-service";
import type { SessionDeviceService } from "../session-devices/session-device-service";
import type { Tx } from "../session-devices/session-device-types";
import { createOffboardingService } from "./offboarding-service";
import type { OffboardingService } from "./offboarding-service";
import type { OffboardingAuditEntry, OffboardingDeps, Standing } from "./offboarding-types";
import { channelMembershipsStep, sessionsDevicesStep } from "./steps-access";
import {
  ackAssignedStep,
  ackSentStep,
  handoffsStep,
  tasksStep,
  urgentUntrackedStep,
} from "./steps-owned-work";
import {
  draftsStep,
  onCallSeatsStep,
  remindersSnoozesStep,
  scheduledSendsStep,
} from "./steps-personal";

const MEMBERSHIP = schema.memberships;
const USER = schema.users;

export interface OffboardingBindingInput {
  readonly db: DbClient;
  /** ADR-0083: the session revoke is reused, not rebuilt. */
  readonly sessionDevices: Pick<SessionDeviceService, "revokeForUser">;
  /** The same ack service the supervisor reassign route uses (ADR-0078). */
  readonly ack: Pick<AckService, "supervisorReassign" | "supervisorReassignCandidates">;
  readonly attention: SupervisorAttentionDeps;
  /** The idempotent sweeps the deactivation event already runs. */
  readonly endMemberships: (organizationId: string, userId: string) => Promise<number>;
  readonly reassignTasks: (
    orgId: string,
    userId: string,
  ) => Promise<{ reassigned: number; flaggedNeedsOwner: number }>;
  readonly resolveHandoffs: (
    orgId: string,
    userId: string,
  ) => Promise<{ recipientClosed: number; senderFlagged: number }>;
  readonly warn?: OffboardingDeps["warn"];
  readonly now?: () => Date;
}

/**
 * A person has LEFT when their account is deactivated or every membership in this organisation is revoked. Pending and suspended memberships are
 * reinstatable and are not offboarding. No membership row in this organisation at all (absent or another tenant's user) is `unknown`.
 */
export function createDbStanding(db: DbClient): OffboardingDeps["standing"] {
  return (organizationId, userId): Promise<Standing> =>
    withOrgContext(db, systemOrgContext(organizationId), async (tx) => {
      const rows = await tx
        .select({ membership: MEMBERSHIP.status, user: USER.status })
        .from(MEMBERSHIP)
        .innerJoin(USER, eq(USER.id, MEMBERSHIP.userId))
        .where(and(eq(MEMBERSHIP.organizationId, organizationId), eq(MEMBERSHIP.userId, userId)));
      if (rows.length === 0) return "unknown";
      if (rows.some((r) => r.user === "deactivated")) return "offboarded";
      return rows.every((r) => r.membership === "revoked") ? "offboarded" : "active";
    });
}

function createAuditWriter(db: DbClient): OffboardingDeps["audit"] {
  return (entry: OffboardingAuditEntry) =>
    withOrgContext(
      db,
      { organizationId: entry.organizationId, userId: entry.actorUserId },
      async (tx: Tx) => {
        await audit(
          tx as unknown as AuditExecutor,
          {
            organizationId: entry.organizationId,
            userId: entry.actorUserId,
            actorKind: "user",
            correlationId: crypto.randomUUID(),
          },
          {
            eventType: entry.action,
            resourceKind: "user",
            resourceId: entry.targetUserId,
            outcome: "success",
            severity: entry.action === "m36.offboarding.executed" ? "warn" : "info",
            retentionClass: "compliance",
            context: { complete: entry.complete, items: entry.items },
          },
        );
      },
    );
}

export function buildOffboardingService(input: OffboardingBindingInput): OffboardingService {
  const { db } = input;
  return createOffboardingService({
    standing: createDbStanding(db),
    audit: createAuditWriter(db),
    ...(input.warn ? { warn: input.warn } : {}),
    // Execution order: access first, then owned work, then personal leftovers (the item order the screen shows).
    steps: [
      sessionsDevicesStep({
        db,
        sessionDevices: input.sessionDevices,
        ...(input.now ? { now: input.now } : {}),
      }),
      channelMembershipsStep({ db, endMemberships: input.endMemberships }),
      tasksStep({ db, reassignTasks: input.reassignTasks }),
      handoffsStep({ db, resolveHandoffs: input.resolveHandoffs }),
      ackAssignedStep({
        db,
        ack: input.ack,
        attention: input.attention,
        ...(input.warn ? { warn: input.warn } : {}),
      }),
      ackSentStep({ db }),
      urgentUntrackedStep({ db, ...(input.now ? { now: input.now } : {}) }),
      onCallSeatsStep(),
      scheduledSendsStep({ db }),
      remindersSnoozesStep({ db }),
      draftsStep({ db }),
    ],
  });
}
