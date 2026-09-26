import { type DbClient, organizationTimezone, schema } from "@wardenx/db";
import type { AlertEmitter } from "@wardenx/messaging";
import { localDateInTimeZone } from "@wardenx/shared/dates";
import { withOrgContext } from "@wardenx/tenancy";
import type { CosignatureStatus } from "@wardenx/types";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { and, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import { transitionCosignature } from "../cosignature/cosignature";
import { decideCosignatureSlaStage, hoursBetween } from "../cosignature/sla-clock";
import type { EncounterWriteOutboxPort } from "../encounters-route-service-db";
import { M8_JOB_SCHEDULES, M8_QUEUES, M8_QUEUE_PARAMS } from "./index";

const M8_WORKER_SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000008";

export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

export interface M8WorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly outbox: EncounterWriteOutboxPort;
  readonly activeOrgs?: ActiveOrgListPort;
  readonly alerts?: AlertEmitter;
  now?: () => Date;
}

function unbound<T>(port: string): Promise<T> {
  return Promise.reject(new Error(`M8_WORKER_PORT_UNBOUND: ${port}`));
}

function activeOrgsOf(deps: M8WorkerDeps): ActiveOrgListPort {
  return deps.activeOrgs ?? { listActiveOrgs: () => unbound("activeOrgs.listActiveOrgs") };
}

function alertEmitterOf(deps: M8WorkerDeps): AlertEmitter {
  return deps.alerts ?? { emit: async () => ({ alertId: "noop", resolvedRecipientCount: 0 }) };
}

export function buildM8WorkerDeps(deps: {
  connection: ConnectionOptions;
  db: DbClient;
  outbox: EncounterWriteOutboxPort;
  activeOrgs?: ActiveOrgListPort;
  alerts?: AlertEmitter;
}): M8WorkerDeps {
  return { ...deps, now: () => new Date() };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

async function supervisorMembershipId(
  db: DbClient,
  organizationId: string,
): Promise<string | null> {
  const M = schema.memberships;
  const MR = schema.membershipRoles;
  const R = schema.roles;
  return withOrgContext(db, { organizationId, userId: M8_WORKER_SYSTEM_USER_ID }, async (tx) => {
    const [row] = await tx
      .select({ membershipId: M.id })
      .from(M)
      .innerJoin(MR, eq(MR.membershipId, M.id))
      .innerJoin(R, eq(R.id, MR.roleId))
      .where(
        and(
          eq(M.organizationId, organizationId),
          eq(M.status, "active"),
          inArray(R.key, ["clinical_lead", "don", "org_admin"]),
          eq(R.enabled, true),
          or(isNull(MR.expiresAt), gt(MR.expiresAt, new Date())),
        ),
      )
      .limit(1);
    return row?.membershipId ?? null;
  });
}

export async function runEncounterAttentionCron(deps: M8WorkerDeps): Promise<void> {
  const alerts = alertEmitterOf(deps);
  const now = (deps.now ?? (() => new Date()))();
  for (const { organizationId } of await activeOrgsOf(deps).listActiveOrgs()) {
    await withOrgContext(
      deps.db,
      { organizationId, userId: M8_WORKER_SYSTEM_USER_ID },
      async (txRaw) => {
        const tx = txRaw as DbClient;
        const E = schema.encounters;
        const timezone = await organizationTimezone(tx, organizationId);
        const today = localDateInTimeZone(now, timezone);
        const unsigned = await tx
          .select({
            id: E.id,
            patientId: E.patientId,
            admissionId: E.admissionId,
            authoredByMembershipId: E.authoredByMembershipId,
          })
          .from(E)
          .where(and(eq(E.organizationId, organizationId), eq(E.status, "finalized")));
        for (const e of unsigned) {
          await alerts.emit(organizationId, {
            eventType: "m8.encounter.unsigned",
            severity: "warn",
            correlationId: `m8:unsigned:${e.id}`,
            payload: {
              encounterId: e.id,
              patientId: e.patientId,
              admissionId: e.admissionId,
              assignedMembershipId: e.authoredByMembershipId,
              deepLink: `/patients/${e.patientId}/encounters/${e.id}`,
            },
          });
        }
        const lateDrafts = await tx
          .select({
            id: E.id,
            patientId: E.patientId,
            admissionId: E.admissionId,
            authoredByMembershipId: E.authoredByMembershipId,
          })
          .from(E)
          .where(
            and(
              eq(E.organizationId, organizationId),
              eq(E.status, "draft"),
              lt(E.serviceDate, today),
            ),
          );
        for (const e of lateDrafts) {
          await alerts.emit(organizationId, {
            eventType: "m8.encounter.documentation_late",
            severity: "warn",
            correlationId: `m8:late-documentation:${e.id}:${today}`,
            payload: {
              encounterId: e.id,
              patientId: e.patientId,
              admissionId: e.admissionId,
              assignedMembershipId: e.authoredByMembershipId,
              deepLink: `/patients/${e.patientId}/encounters/${e.id}`,
            },
          });
        }
      },
    );
  }
}

export async function runCosignatureSlaCron(deps: M8WorkerDeps): Promise<void> {
  const alerts = alertEmitterOf(deps);
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  for (const { organizationId } of await activeOrgsOf(deps).listActiveOrgs()) {
    const supervisorId = await supervisorMembershipId(deps.db, organizationId);
    await withOrgContext(
      deps.db,
      { organizationId, userId: M8_WORKER_SYSTEM_USER_ID },
      async (txRaw) => {
        const tx = txRaw as DbClient;
        const CR = schema.cosignatureRequests;
        const requests = await tx
          .select()
          .from(CR)
          .where(
            and(
              eq(CR.organizationId, organizationId),
              inArray(CR.status, ["routed", "acknowledged", "escalated"]),
            ),
          );
        for (const req of requests) {
          const routedAt = iso(req.routedAt);
          const stage = decideCosignatureSlaStage({
            routedAtInstant: routedAt,
            asOfInstant: nowIso,
            currentStatus: req.status as CosignatureStatus,
          });
          if (stage === "none") continue;
          if (stage === "overdue") {
            await alerts.emit(organizationId, {
              eventType: "m8.encounter.cosignature_overdue",
              severity: "warn",
              correlationId: `m8:cosign-overdue:${req.id}`,
              payload: {
                encounterId: req.encounterId,
                routedToMembershipId: req.routedToMembershipId,
                hoursOverdue: Math.floor(hoursBetween(routedAt, nowIso)),
                deepLink: "/work/cosignatures",
              },
            });
            continue;
          }
          if (supervisorId === null) {
            await alerts.emit(organizationId, {
              eventType: "m8.encounter.cosignature_overdue",
              severity: "critical",
              correlationId: `m8:cosign-supervisor-missing:${req.id}`,
              payload: {
                encounterId: req.encounterId,
                routedToMembershipId: req.routedToMembershipId,
                deepLink: "/work/cosignatures",
              },
            });
            continue;
          }
          const transition = transitionCosignature(req.status as CosignatureStatus, {
            type: stage === "escalate" ? "escalate" : "reachHardCap",
            supervisorMembershipId: supervisorId,
            at: nowIso,
          });
          await tx
            .update(CR)
            .set({
              status: transition.to,
              escalatedAt: stage === "escalate" ? now : req.escalatedAt,
              hardCapAt: stage === "hard_cap" ? now : req.hardCapAt,
              version: Number(req.version) + 1,
              updatedAt: now,
            })
            .where(and(eq(CR.id, req.id), eq(CR.status, req.status)));
          await deps.outbox.publish(tx, {
            eventName:
              stage === "escalate"
                ? "m8.encounter.cosignature_escalated"
                : "m8.encounter.cosignature_hard_cap_reached",
            organizationId,
            aggregateKind: "cosignature_request",
            aggregateId: req.id,
            payload: {
              encounterId: req.encounterId,
              routedToMembershipId: req.routedToMembershipId,
              supervisorMembershipId: supervisorId,
            },
          });
        }
      },
    );
  }
}

export function registerM8CronWorkers(deps: M8WorkerDeps): Worker[] {
  return [
    new Worker(M8_QUEUES.encounterAttention, async () => runEncounterAttentionCron(deps), {
      connection: deps.connection,
      concurrency: M8_QUEUE_PARAMS.encounterAttention.concurrency,
    }),
    new Worker(M8_QUEUES.cosignatureSla, async () => runCosignatureSlaCron(deps), {
      connection: deps.connection,
      concurrency: M8_QUEUE_PARAMS.cosignatureSla.concurrency,
    }),
  ];
}

export async function scheduleM8Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const attention = new Queue(M8_QUEUES.encounterAttention, { connection });
  await attention.add(
    "scheduled",
    {},
    {
      repeat: { pattern: M8_JOB_SCHEDULES.encounterAttention },
      priority: M8_QUEUE_PARAMS.encounterAttention.priority,
      attempts: M8_QUEUE_PARAMS.encounterAttention.attempts,
      backoff: M8_QUEUE_PARAMS.encounterAttention.backoff,
      removeOnComplete: M8_QUEUE_PARAMS.encounterAttention.removeOnComplete,
      removeOnFail: M8_QUEUE_PARAMS.encounterAttention.removeOnFail,
    },
  );
  const cosignature = new Queue(M8_QUEUES.cosignatureSla, { connection });
  await cosignature.add(
    "scheduled",
    {},
    {
      repeat: { pattern: M8_JOB_SCHEDULES.cosignatureSla },
      priority: M8_QUEUE_PARAMS.cosignatureSla.priority,
      attempts: M8_QUEUE_PARAMS.cosignatureSla.attempts,
      backoff: M8_QUEUE_PARAMS.cosignatureSla.backoff,
      removeOnComplete: M8_QUEUE_PARAMS.cosignatureSla.removeOnComplete,
      removeOnFail: M8_QUEUE_PARAMS.cosignatureSla.removeOnFail,
    },
  );
  return [attention, cosignature];
}
