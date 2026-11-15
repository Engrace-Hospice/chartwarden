import { resolveActorPermissions } from "@chartwarden/auth";
import type { repositories } from "@chartwarden/billing";
import * as schema from "@chartwarden/db/schema";
// Durable M23 notice follow-up. Issue records are operational work items; DDE remains the
// authoritative FISS task lifecycle, and neither issue acknowledgment nor closure is filing evidence.
import type { AlertEmitter } from "@chartwarden/messaging";
import { CONSUMER_USER_ID } from "@chartwarden/shared/route-kit";
import { withOrgContext } from "@chartwarden/tenancy";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@chartwarden/types";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { M23ReadActor, M23WriteActor } from "../routes/actor";

export type MedicareNoticeIssueType = (typeof schema.MEDICARE_NOTICE_ISSUE_TYPES)[number];
export type MedicareNoticeIssueSeverity = "info" | "warning" | "critical";
export type MedicareNoticeIssueObservation = {
  readonly noticeType: MedicareNoticeIssueType;
  readonly noticeId: string;
  readonly issueCode: string;
  readonly occurrenceKey: string;
  readonly severity: MedicareNoticeIssueSeverity;
  readonly responsibleArea:
    | "billing"
    | "organization_administration"
    | "platform_integration"
    | "reconciliation";
  readonly ddeWorkItemId?: string | null;
};
export type MedicareNoticeIssueEvaluation = {
  readonly noticeType: MedicareNoticeIssueType;
  readonly noticeId: string;
  /** Stable version/digest of the authoritative evidence used by this evaluation. */
  readonly evidenceKey: string;
  /** Codes this evaluator is authoritative for. Other issue families are never closed by omission. */
  readonly evaluatedIssueCodes: readonly string[];
  readonly observations: readonly MedicareNoticeIssueObservation[];
};
export type MedicareNoticeIssueListProjection = {
  readonly id: string;
  readonly noticeType: MedicareNoticeIssueType;
  readonly noticeId: string;
  readonly issueCode: string;
  readonly status: string;
  readonly severity: string;
  readonly responsibleArea: string;
  readonly assignedMembershipId: string | null;
  readonly acknowledgedAt: Date | null;
  readonly ddeWorkItemId: string | null;
  readonly notificationDeliveryState: "pending" | "retry_exhausted" | null;
  readonly version: number;
  readonly updatedAt: Date;
};

export interface MedicareNoticeOperationalIssueService {
  list(
    actor: M23ReadActor,
    input?: {
      readonly status?: string;
      readonly limit?: number;
      readonly noticeTypes?: readonly MedicareNoticeIssueType[];
    },
  ): Promise<readonly unknown[]>;
  byNoticeReferences(
    actor: M23ReadActor,
    notices: readonly { readonly noticeType: MedicareNoticeIssueType; readonly noticeId: string }[],
  ): Promise<readonly MedicareNoticeIssueListProjection[]>;
  history(
    actor: M23ReadActor,
    issueId: string,
    permittedTypes: readonly MedicareNoticeIssueType[],
  ): Promise<readonly unknown[]>;
  synchronize(
    organizationId: string,
    observations: readonly MedicareNoticeIssueObservation[],
  ): Promise<void>;
  reconcile(
    organizationId: string,
    evaluations: readonly MedicareNoticeIssueEvaluation[],
  ): Promise<void>;
  flushNotifications(organizationId: string): Promise<number>;
  assign(
    actor: M23WriteActor,
    issueId: string,
    membershipId: string | null,
    expectedVersion: number,
    permittedTypes: readonly MedicareNoticeIssueType[],
  ): Promise<unknown>;
  acknowledge(
    actor: M23WriteActor,
    issueId: string,
    expectedVersion: number,
    permittedTypes: readonly MedicareNoticeIssueType[],
  ): Promise<unknown>;
}

const openStatuses = ["active", "acknowledged", "assigned"] as const;
const MAX_NOTIFICATION_ATTEMPTS = 12;
const cap = (value: string, max: number) => value.slice(0, max);
type IssueTx = Parameters<Parameters<repositories.BillingDb["transaction"]>[0]>[0];

export function shouldReopenResolvedOccurrence(
  resolvedOccurrenceKey: string | null | undefined,
  observedOccurrenceKey: string,
): boolean {
  return resolvedOccurrenceKey !== observedOccurrenceKey;
}

export function issueCodesClearedByEvaluation(
  evaluatedIssueCodes: readonly string[],
  observations: readonly Pick<MedicareNoticeIssueObservation, "issueCode">[],
): readonly string[] {
  const observed = new Set(observations.map((item) => item.issueCode));
  return [...new Set(evaluatedIssueCodes)].filter((issueCode) => !observed.has(issueCode));
}

/** Stable, bounded issue observation derived from the already-computed CMS Eastern-day distance. */
export function noticeDeadlineIssueObservation(input: {
  readonly noticeType: "noe" | "notr";
  readonly noticeId: string;
  readonly sourceVersion: number;
  readonly daysToDeadline: number;
}): MedicareNoticeIssueObservation | null {
  const { daysToDeadline } = input;
  if (daysToDeadline > 2) return null;
  const stage = daysToDeadline < 0 ? "overdue" : daysToDeadline === 0 ? "due_today" : "approaching";
  return {
    noticeType: input.noticeType,
    noticeId: input.noticeId,
    issueCode: `${input.noticeType}_deadline_follow_up`,
    occurrenceKey: `${input.sourceVersion}:${stage}`,
    severity: stage === "overdue" || stage === "due_today" ? "critical" : "warning",
    responsibleArea: "billing",
  };
}

export function buildMedicareNoticeOperationalIssueService(
  db: repositories.BillingDb,
  alerts?: Pick<AlertEmitter, "emit">,
): MedicareNoticeOperationalIssueService {
  return {
    async byNoticeReferences(actor, notices) {
      const pairs = [
        ...new Map(notices.map((item) => [`${item.noticeType}:${item.noticeId}`, item])).values(),
      ];
      if (!pairs.length) return [];
      return withOrgContext(
        db,
        { organizationId: actor.organizationId, userId: actor.userId },
        async (tx) => {
          const all = await tx
            .select()
            .from(schema.medicareNoticeOperationalIssue)
            .where(
              and(
                eq(schema.medicareNoticeOperationalIssue.organizationId, actor.organizationId),
                inArray(
                  schema.medicareNoticeOperationalIssue.noticeId,
                  pairs.map((x) => x.noticeId),
                ),
                inArray(schema.medicareNoticeOperationalIssue.noticeType, [
                  ...new Set(pairs.map((x) => x.noticeType)),
                ]),
              ),
            );
          const allowed = new Set(pairs.map((x) => `${x.noticeType}:${x.noticeId}`));
          const pendingNotifications = all.length
            ? await tx
                .select({
                  issueId: schema.medicareNoticeOperationalIssueEvent.issueId,
                  attempts: schema.medicareNoticeOperationalIssueNotification.attempts,
                })
                .from(schema.medicareNoticeOperationalIssueNotification)
                .innerJoin(
                  schema.medicareNoticeOperationalIssueEvent,
                  and(
                    eq(
                      schema.medicareNoticeOperationalIssueEvent.organizationId,
                      schema.medicareNoticeOperationalIssueNotification.organizationId,
                    ),
                    eq(
                      schema.medicareNoticeOperationalIssueEvent.id,
                      schema.medicareNoticeOperationalIssueNotification.issueEventId,
                    ),
                  ),
                )
                .where(
                  and(
                    eq(
                      schema.medicareNoticeOperationalIssueNotification.organizationId,
                      actor.organizationId,
                    ),
                    eq(schema.medicareNoticeOperationalIssueNotification.state, "pending"),
                    inArray(
                      schema.medicareNoticeOperationalIssueEvent.issueId,
                      all.map((row) => row.id),
                    ),
                  ),
                )
            : [];
          const deliveryByIssue = new Map<string, "pending" | "retry_exhausted">();
          for (const pending of pendingNotifications) {
            const state =
              pending.attempts >= MAX_NOTIFICATION_ATTEMPTS ? "retry_exhausted" : "pending";
            if (
              state === "retry_exhausted" ||
              deliveryByIssue.get(pending.issueId) !== "retry_exhausted"
            ) {
              deliveryByIssue.set(pending.issueId, state);
            }
          }
          return all
            .filter((row) => allowed.has(`${row.noticeType}:${row.noticeId}`))
            .map((row) => ({
              id: row.id,
              noticeType: row.noticeType,
              noticeId: row.noticeId,
              issueCode: row.issueCode,
              status: row.status,
              severity: row.severity,
              responsibleArea: row.responsibleArea,
              assignedMembershipId: row.assignedMembershipId,
              acknowledgedAt: row.acknowledgedAt,
              ddeWorkItemId: row.ddeWorkItemId,
              notificationDeliveryState: deliveryByIssue.get(row.id) ?? null,
              version: row.version,
              updatedAt: row.updatedAt,
            }));
        },
      );
    },
    async list(actor, input) {
      return withOrgContext(
        db,
        { organizationId: actor.organizationId, userId: actor.userId },
        async (tx) => {
          const filters = [
            eq(schema.medicareNoticeOperationalIssue.organizationId, actor.organizationId),
          ];
          if (input?.status)
            filters.push(eq(schema.medicareNoticeOperationalIssue.status, input.status as never));
          if (input?.noticeTypes?.length)
            filters.push(
              inArray(schema.medicareNoticeOperationalIssue.noticeType, [...input.noticeTypes]),
            );
          const where = and(...filters);
          return tx
            .select()
            .from(schema.medicareNoticeOperationalIssue)
            .where(where)
            .orderBy(
              desc(schema.medicareNoticeOperationalIssue.severity),
              desc(schema.medicareNoticeOperationalIssue.lastEvaluatedAt),
              desc(schema.medicareNoticeOperationalIssue.id),
            )
            .limit(Math.min(Math.max(input?.limit ?? 50, 1), 100));
        },
      );
    },

    async history(actor, issueId, permittedTypes) {
      return withOrgContext(
        db,
        { organizationId: actor.organizationId, userId: actor.userId },
        async (tx) => {
          const issue = await tx
            .select({ id: schema.medicareNoticeOperationalIssue.id })
            .from(schema.medicareNoticeOperationalIssue)
            .where(
              and(
                eq(schema.medicareNoticeOperationalIssue.organizationId, actor.organizationId),
                eq(schema.medicareNoticeOperationalIssue.id, issueId),
                inArray(schema.medicareNoticeOperationalIssue.noticeType, [...permittedTypes]),
              ),
            )
            .limit(1);
          if (!issue[0]) throw new NotFoundError("Medicare notice operational issue not found");
          const events = await tx
            .select({
              eventType: schema.medicareNoticeOperationalIssueEvent.eventType,
              reasonCode: schema.medicareNoticeOperationalIssueEvent.reasonCode,
              occurredAt: schema.medicareNoticeOperationalIssueEvent.occurredAt,
            })
            .from(schema.medicareNoticeOperationalIssueEvent)
            .where(
              and(
                eq(schema.medicareNoticeOperationalIssueEvent.organizationId, actor.organizationId),
                eq(schema.medicareNoticeOperationalIssueEvent.issueId, issueId),
              ),
            )
            .orderBy(
              schema.medicareNoticeOperationalIssueEvent.occurredAt,
              schema.medicareNoticeOperationalIssueEvent.id,
            );
          return events;
        },
      );
    },

    async synchronize(organizationId, observations) {
      for (const observation of observations) {
        if (
          !/^[a-z][a-z0-9_.-]{1,79}$/.test(observation.issueCode) ||
          !/^[A-Za-z0-9:_.-]{1,160}$/.test(observation.occurrenceKey)
        ) {
          throw new ValidationError("Operational issue identity is invalid", [
            { code: "invalid", message: "issue identity is invalid" },
          ]);
        }
        await withOrgContext(db, { organizationId, userId: CONSUMER_USER_ID }, async (tx) => {
          const table = schema.medicareNoticeOperationalIssue;
          const dde =
            observation.noticeType === "noe" || observation.noticeType === "notr"
              ? (
                  await tx
                    .select({ id: schema.ddeWorkItem.id })
                    .from(schema.ddeWorkItem)
                    .where(
                      and(
                        eq(schema.ddeWorkItem.organizationId, organizationId),
                        eq(schema.ddeWorkItem.subjectId, observation.noticeId),
                        eq(
                          schema.ddeWorkItem.subjectKind,
                          observation.noticeType === "noe" ? "noe_record" : "notr_record",
                        ),
                        eq(schema.ddeWorkItem.itemType, observation.noticeType),
                        inArray(schema.ddeWorkItem.state, [
                          "queued",
                          "assigned",
                          "in_progress",
                          "submitted",
                          "returned",
                        ]),
                      ),
                    )
                    .limit(1)
                )[0]
              : undefined;
          const ddeWorkItemId = observation.ddeWorkItemId ?? dde?.id ?? null;
          const existing = await tx
            .select()
            .from(table)
            .where(
              and(
                eq(table.organizationId, organizationId),
                eq(table.noticeType, observation.noticeType),
                eq(table.noticeId, observation.noticeId),
                eq(table.issueCode, observation.issueCode),
                inArray(table.status, [...openStatuses]),
              ),
            )
            .limit(1);
          const prior = existing[0];
          if (!prior) {
            const resolvedHistory = await tx
              .select({ id: table.id, occurrenceKey: table.occurrenceKey })
              .from(table)
              .where(
                and(
                  eq(table.organizationId, organizationId),
                  eq(table.noticeType, observation.noticeType),
                  eq(table.noticeId, observation.noticeId),
                  eq(table.issueCode, observation.issueCode),
                  eq(table.status, "resolved"),
                ),
              )
              .orderBy(desc(table.createdAt), desc(table.id))
              .limit(1);
            // A delayed watchdog page must not reopen the exact occurrence that authoritative
            // evidence already resolved. A genuinely recurring condition carries a new evidence key.
            if (
              !shouldReopenResolvedOccurrence(
                resolvedHistory[0]?.occurrenceKey,
                observation.occurrenceKey,
              )
            )
              return;
            const inserted = await tx
              .insert(table)
              .values({
                organizationId,
                noticeType: observation.noticeType,
                noticeId: observation.noticeId,
                issueCode: observation.issueCode,
                occurrenceKey: observation.occurrenceKey,
                severity: observation.severity,
                responsibleArea: observation.responsibleArea,
                ddeWorkItemId,
              })
              .onConflictDoNothing()
              .returning();
            const issue =
              inserted[0] ??
              (
                await tx
                  .select()
                  .from(table)
                  .where(
                    and(
                      eq(table.organizationId, organizationId),
                      eq(table.noticeType, observation.noticeType),
                      eq(table.noticeId, observation.noticeId),
                      eq(table.issueCode, observation.issueCode),
                      inArray(table.status, [...openStatuses]),
                    ),
                  )
                  .limit(1)
              )[0];
            if (!issue) throw new ConflictError("Operational issue could not be synchronized");
            if (inserted[0])
              await appendIssueEvent(tx, {
                organizationId,
                issueId: issue.id,
                eventKey: `${issue.id}:${resolvedHistory.length ? "reopened" : "detected"}:${observation.occurrenceKey}`,
                eventType: resolvedHistory.length ? "reopened" : "detected",
                reasonCode: cap(observation.issueCode, 100),
                nextState: issue.status,
              });
            return { issue, created: Boolean(inserted[0]) };
          }
          if (
            prior.occurrenceKey !== observation.occurrenceKey ||
            prior.severity !== observation.severity
          ) {
            // The logical problem persists while its evidence changes; retain one open issue and append an event.
            const updated = await tx
              .update(table)
              .set({
                occurrenceKey: observation.occurrenceKey,
                severity: observation.severity,
                responsibleArea: observation.responsibleArea,
                ddeWorkItemId: ddeWorkItemId ?? prior.ddeWorkItemId,
                lastEvaluatedAt: new Date(),
                updatedAt: new Date(),
                version: prior.version + 1,
              })
              .where(
                and(
                  eq(table.id, prior.id),
                  eq(table.organizationId, organizationId),
                  eq(table.version, prior.version),
                ),
              )
              .returning();
            if (!updated[0]) throw new ConflictError("Operational issue changed concurrently");
            await appendIssueEvent(tx, {
              organizationId,
              issueId: prior.id,
              eventKey: `${prior.id}:severity:${prior.version + 1}`,
              eventType: prior.severity !== observation.severity ? "severity_changed" : "escalated",
              actorMembershipId: null,
              reasonCode: cap(observation.issueCode, 100),
              previousState: `${prior.severity}:${prior.occurrenceKey}`,
              nextState: `${observation.severity}:${observation.occurrenceKey}`,
            });
            return { issue: updated[0], created: false };
          }
          await tx
            .update(table)
            .set({ lastEvaluatedAt: new Date() })
            .where(and(eq(table.id, prior.id), eq(table.organizationId, organizationId)));
          return { issue: prior, created: false };
        });
      }
    },

    async reconcile(organizationId, evaluations) {
      for (const evaluation of evaluations) {
        if (!/^[A-Za-z0-9:_.-]{1,160}$/.test(evaluation.evidenceKey)) {
          throw new ValidationError("Operational issue evidence identity is invalid", [
            { code: "invalid", message: "evidence identity is invalid" },
          ]);
        }
        if (
          evaluation.observations.some(
            (item) =>
              item.noticeType !== evaluation.noticeType || item.noticeId !== evaluation.noticeId,
          )
        ) {
          throw new ValidationError("Operational issue evaluation does not match its notice", [
            { code: "invalid", message: "observation notice identity is inconsistent" },
          ]);
        }
        await this.synchronize(organizationId, evaluation.observations);
        const managed = issueCodesClearedByEvaluation(
          evaluation.evaluatedIssueCodes,
          evaluation.observations,
        );
        if (!managed.length) continue;
        await withOrgContext(db, { organizationId, userId: CONSUMER_USER_ID }, async (tx) => {
          const table = schema.medicareNoticeOperationalIssue;
          const candidates = await tx
            .select()
            .from(table)
            .where(
              and(
                eq(table.organizationId, organizationId),
                eq(table.noticeType, evaluation.noticeType),
                eq(table.noticeId, evaluation.noticeId),
                inArray(table.issueCode, managed),
                inArray(table.status, [...openStatuses]),
              ),
            );
          for (const prior of candidates) {
            const now = new Date();
            const updated = await tx
              .update(table)
              .set({
                status: "resolved",
                resolvedAt: now,
                resolvedByMembershipId: null,
                lastEvaluatedAt: now,
                updatedAt: now,
                version: prior.version + 1,
              })
              .where(
                and(
                  eq(table.organizationId, organizationId),
                  eq(table.id, prior.id),
                  eq(table.version, prior.version),
                  inArray(table.status, [...openStatuses]),
                ),
              )
              .returning({ id: table.id, version: table.version });
            if (!updated[0]) continue;
            await appendIssueEvent(tx, {
              organizationId,
              issueId: prior.id,
              eventKey: `${prior.id}:resolved:${evaluation.evidenceKey}`,
              eventType: "resolved",
              actorMembershipId: null,
              reasonCode: "authoritative_condition_cleared",
              previousState: prior.status,
              nextState: "resolved",
            });
          }
        });
      }
    },

    async flushNotifications(organizationId) {
      return alerts ? flushPendingNotifications(db, organizationId, alerts) : 0;
    },

    async assign(actor, issueId, membershipId, expectedVersion, permittedTypes) {
      const assigned = await transition(db, actor, issueId, expectedVersion, async (tx, prior) => {
        if (!permittedTypes.includes(prior.noticeType))
          throw new NotFoundError("Medicare notice operational issue not found");
        if (membershipId) {
          const target = (
            await tx
              .select({ userId: schema.memberships.userId })
              .from(schema.memberships)
              .where(
                and(
                  eq(schema.memberships.id, membershipId),
                  eq(schema.memberships.organizationId, actor.organizationId),
                  eq(schema.memberships.status, "active"),
                ),
              )
              .limit(1)
          )[0];
          if (!target)
            throw new ValidationError("Assignee must be an active member of this organization", [
              { code: "invalid", message: "assignee is not active in this organization" },
            ]);
          const permissions = await resolveActorPermissions({
            organizationId: actor.organizationId,
            userId: target.userId,
          });
          const requiredPermission =
            prior.noticeType === "notr" ? "billing.notr.read" : "billing.noe.read";
          if (!permissions.has(requiredPermission)) {
            throw new ForbiddenError("Assignee is not authorized to work Medicare notices");
          }
        }
        const now = new Date();
        const status = membershipId
          ? "assigned"
          : prior.status === "assigned"
            ? "active"
            : prior.status;
        const rows = await tx
          .update(schema.medicareNoticeOperationalIssue)
          .set({
            assignedMembershipId: membershipId,
            status,
            updatedAt: now,
            version: prior.version + 1,
          })
          .where(
            and(
              eq(schema.medicareNoticeOperationalIssue.id, issueId),
              eq(schema.medicareNoticeOperationalIssue.organizationId, actor.organizationId),
              eq(schema.medicareNoticeOperationalIssue.version, expectedVersion),
              inArray(schema.medicareNoticeOperationalIssue.status, [...openStatuses]),
            ),
          )
          .returning();
        if (!rows[0]) throw new ConflictError("Operational issue changed or is no longer active");
        await appendIssueEvent(tx, {
          organizationId: actor.organizationId,
          issueId,
          eventKey: `${issueId}:assignment:${rows[0].version}`,
          eventType: prior.assignedMembershipId ? "reassigned" : "assigned",
          actorMembershipId: actor.membershipId,
          reasonCode: "operator_assignment",
          previousState: prior.status,
          nextState: status,
        });
        return rows[0];
      });
      if (alerts) await flushPendingNotifications(db, actor.organizationId, alerts).catch(() => 0);
      return assigned;
    },

    async acknowledge(actor, issueId, expectedVersion, permittedTypes) {
      return transition(db, actor, issueId, expectedVersion, async (tx, prior) => {
        if (!permittedTypes.includes(prior.noticeType))
          throw new NotFoundError("Medicare notice operational issue not found");
        if (prior.status === "resolved" || prior.status === "superseded")
          throw new ConflictError("Resolved operational issues cannot be acknowledged");
        const now = new Date();
        const rows = await tx
          .update(schema.medicareNoticeOperationalIssue)
          .set({
            status: prior.assignedMembershipId ? "assigned" : "acknowledged",
            acknowledgedByMembershipId: actor.membershipId,
            acknowledgedAt: now,
            updatedAt: now,
            version: prior.version + 1,
          })
          .where(
            and(
              eq(schema.medicareNoticeOperationalIssue.id, issueId),
              eq(schema.medicareNoticeOperationalIssue.organizationId, actor.organizationId),
              eq(schema.medicareNoticeOperationalIssue.version, expectedVersion),
              inArray(schema.medicareNoticeOperationalIssue.status, [...openStatuses]),
            ),
          )
          .returning();
        if (!rows[0]) throw new ConflictError("Operational issue changed concurrently");
        await appendIssueEvent(
          tx,
          {
            organizationId: actor.organizationId,
            issueId,
            eventKey: `${issueId}:acknowledged:${rows[0].version}`,
            eventType: "acknowledged",
            actorMembershipId: actor.membershipId,
            reasonCode: "operator_acknowledged",
            previousState: prior.status,
            nextState: rows[0].status,
          },
          false,
        );
        return rows[0];
      });
    },
  };
}

async function transition<T>(
  db: repositories.BillingDb,
  actor: M23WriteActor,
  issueId: string,
  expectedVersion: number,
  change: (tx: IssueTx, prior: schema.MedicareNoticeOperationalIssueRow) => Promise<T>,
): Promise<T> {
  return withOrgContext(
    db,
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => {
      const prior = (
        await tx
          .select()
          .from(schema.medicareNoticeOperationalIssue)
          .where(
            and(
              eq(schema.medicareNoticeOperationalIssue.organizationId, actor.organizationId),
              eq(schema.medicareNoticeOperationalIssue.id, issueId),
            ),
          )
          .limit(1)
      )[0];
      if (!prior) throw new NotFoundError("Medicare notice operational issue not found");
      if (prior.version !== expectedVersion)
        throw new ConflictError("Operational issue changed concurrently");
      await assertIssueProviderScope(tx as IssueTx, actor, prior);
      return change(tx as IssueTx, prior);
    },
  );
}

type IssueEventInsert = typeof schema.medicareNoticeOperationalIssueEvent.$inferInsert;
async function appendIssueEvent(
  tx: IssueTx,
  event: IssueEventInsert,
  notify = event.eventType !== "acknowledged",
): Promise<void> {
  const inserted = await tx
    .insert(schema.medicareNoticeOperationalIssueEvent)
    .values(event)
    .onConflictDoNothing()
    .returning({ id: schema.medicareNoticeOperationalIssueEvent.id });
  const existing =
    inserted[0] ??
    (
      await tx
        .select({ id: schema.medicareNoticeOperationalIssueEvent.id })
        .from(schema.medicareNoticeOperationalIssueEvent)
        .where(
          and(
            eq(schema.medicareNoticeOperationalIssueEvent.organizationId, event.organizationId),
            eq(schema.medicareNoticeOperationalIssueEvent.eventKey, event.eventKey),
          ),
        )
        .limit(1)
    )[0];
  if (notify && existing)
    await tx
      .insert(schema.medicareNoticeOperationalIssueNotification)
      .values({
        organizationId: event.organizationId,
        issueEventId: existing.id,
      })
      .onConflictDoNothing();
}

async function flushPendingNotifications(
  db: repositories.BillingDb,
  organizationId: string,
  alerts: Pick<AlertEmitter, "emit">,
): Promise<number> {
  const pending = await withOrgContext(
    db,
    { organizationId, userId: CONSUMER_USER_ID },
    async (tx) =>
      tx
        .select({
          id: schema.medicareNoticeOperationalIssueNotification.id,
          eventId: schema.medicareNoticeOperationalIssueEvent.id,
          eventType: schema.medicareNoticeOperationalIssueEvent.eventType,
          issueId: schema.medicareNoticeOperationalIssue.id,
          noticeType: schema.medicareNoticeOperationalIssue.noticeType,
          noticeId: schema.medicareNoticeOperationalIssue.noticeId,
          issueCode: schema.medicareNoticeOperationalIssue.issueCode,
          severity: schema.medicareNoticeOperationalIssue.severity,
          ddeWorkItemId: schema.medicareNoticeOperationalIssue.ddeWorkItemId,
          assigneeUserId: schema.memberships.userId,
        })
        .from(schema.medicareNoticeOperationalIssueNotification)
        .innerJoin(
          schema.medicareNoticeOperationalIssueEvent,
          and(
            eq(
              schema.medicareNoticeOperationalIssueEvent.organizationId,
              schema.medicareNoticeOperationalIssueNotification.organizationId,
            ),
            eq(
              schema.medicareNoticeOperationalIssueEvent.id,
              schema.medicareNoticeOperationalIssueNotification.issueEventId,
            ),
          ),
        )
        .innerJoin(
          schema.medicareNoticeOperationalIssue,
          and(
            eq(
              schema.medicareNoticeOperationalIssue.organizationId,
              schema.medicareNoticeOperationalIssueEvent.organizationId,
            ),
            eq(
              schema.medicareNoticeOperationalIssue.id,
              schema.medicareNoticeOperationalIssueEvent.issueId,
            ),
          ),
        )
        .leftJoin(
          schema.memberships,
          and(
            eq(
              schema.memberships.organizationId,
              schema.medicareNoticeOperationalIssue.organizationId,
            ),
            eq(schema.memberships.id, schema.medicareNoticeOperationalIssue.assignedMembershipId),
          ),
        )
        .where(
          and(
            eq(schema.medicareNoticeOperationalIssueNotification.organizationId, organizationId),
            eq(schema.medicareNoticeOperationalIssueNotification.state, "pending"),
            lt(
              schema.medicareNoticeOperationalIssueNotification.attempts,
              MAX_NOTIFICATION_ATTEMPTS,
            ),
          ),
        )
        .orderBy(schema.medicareNoticeOperationalIssueNotification.createdAt)
        .limit(100),
  );
  let published = 0;
  for (const item of pending) {
    const startedAt = new Date();
    await withOrgContext(db, { organizationId, userId: CONSUMER_USER_ID }, async (tx) => {
      await tx
        .update(schema.medicareNoticeOperationalIssueNotification)
        .set({
          attempts: sql`${schema.medicareNoticeOperationalIssueNotification.attempts} + 1`,
          lastAttemptAt: startedAt,
        })
        .where(
          and(
            eq(schema.medicareNoticeOperationalIssueNotification.id, item.id),
            eq(schema.medicareNoticeOperationalIssueNotification.state, "pending"),
          ),
        );
    });
    try {
      const result = await alerts.emit(organizationId, {
        eventType:
          item.severity === "critical"
            ? "m23.notice.operational_issue.critical"
            : "m23.notice.operational_issue.warning",
        severity:
          item.severity === "critical" ? "critical" : item.severity === "warning" ? "warn" : "info",
        correlationId: `m23-notice-issue-event:${item.eventId}`,
        payload: {
          issueId: item.issueId,
          noticeType: item.noticeType,
          noticeId: item.noticeId,
          issueCode: item.issueCode,
          issueEvent: item.eventType,
          message: noticeIssueNotificationMessage(item.eventType, item.severity),
          deepLink: noticeIssueDeepLink({
            noticeType: item.noticeType,
            noticeId: item.noticeId,
            issueCode: item.issueCode,
            ddeWorkItemId: item.ddeWorkItemId,
          }),
          ...(item.assigneeUserId ? { assigneeUserId: item.assigneeUserId } : {}),
        },
      });
      // A rule with no eligible same-tenant recipient is a delivery gap, not a successful publish.
      // Keep the outbox row pending (within the bounded retry budget) for operator/role repair.
      if (result.resolvedRecipientCount === 0) continue;
      await withOrgContext(db, { organizationId, userId: CONSUMER_USER_ID }, async (tx) => {
        await tx
          .update(schema.medicareNoticeOperationalIssueNotification)
          .set({ state: "published", publishedAt: new Date() })
          .where(
            and(
              eq(schema.medicareNoticeOperationalIssueNotification.id, item.id),
              eq(schema.medicareNoticeOperationalIssueNotification.state, "pending"),
            ),
          );
      });
      published++;
    } catch {
      // Leave pending. The watchdog replays the same M36 correlation ID, so crash/error retries are deduplicated.
    }
  }
  return published;
}

export function noticeIssueDeepLink(input: {
  readonly noticeType: MedicareNoticeIssueType;
  readonly noticeId: string;
  readonly issueCode: string;
  readonly ddeWorkItemId?: string | null;
}): string {
  if (input.ddeWorkItemId) return "/billing/dde";
  if (input.issueCode.startsWith("exception_review") && input.noticeType === "noe") {
    return `/billing/noe/${input.noticeId}/exception-review`;
  }
  if (input.noticeType === "noe") return `/billing/noe/${input.noticeId}`;
  if (input.noticeType === "notr") return `/billing/notr/${input.noticeId}`;
  const kind = input.noticeType === "cancellation" ? "&kind=cancellation" : "";
  return `/billing/transfer-notices?notice=${input.noticeId}${kind}`;
}

export function noticeIssueNotificationMessage(eventType: string, severity: string): string {
  if (eventType === "assigned" || eventType === "reassigned") {
    return "A Medicare notice operational issue was assigned and requires review.";
  }
  if (eventType === "resolved") {
    return "A Medicare notice operational issue was resolved from authoritative evidence.";
  }
  if (eventType === "severity_changed" || eventType === "escalated") {
    return "A Medicare notice operational issue escalated and requires review.";
  }
  return severity === "critical"
    ? "An urgent Medicare notice operational issue requires review."
    : "A Medicare notice operational issue requires review.";
}

async function assertIssueProviderScope(
  tx: IssueTx,
  actor: M23WriteActor,
  issue: schema.MedicareNoticeOperationalIssueRow,
): Promise<void> {
  if (!actor.providerEntityScope?.length) return;
  const table =
    issue.noticeType === "noe"
      ? schema.noeRecord
      : issue.noticeType === "notr"
        ? schema.notrRecord
        : schema.transferNoticeRecord;
  const row = await tx
    .select({ providerEntityId: table.providerEntityId })
    .from(table)
    .where(and(eq(table.organizationId, actor.organizationId), eq(table.id, issue.noticeId)))
    .limit(1);
  if (!row[0] || !actor.providerEntityScope.includes(row[0].providerEntityId)) {
    throw new ForbiddenError("Medicare notice is outside the authorized provider scope");
  }
}
