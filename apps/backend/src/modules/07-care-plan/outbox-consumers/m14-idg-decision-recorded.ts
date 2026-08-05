// M7's live `idg.decision_recorded` care-plan consumer. It reads only the canonical leaf contract from
// @wardenx/types, validates the consumed arm defensively, and commits mutations plus a durable
// decision-id marker in one org-scoped transaction. Other decision kinds are legitimate no-ops for M7.
import { type AuditContext, audit } from "@wardenx/audit";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { IdgDecisionPayload } from "@wardenx/types";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { IdgApplyAction, IdgApplyFacts } from "../consumers/apply-idg-decision";
import { decideIdgDecision } from "../consumers/apply-idg-decision";
import { resolveRequiredSignerSet } from "../lifecycle/required-signer-set";

const CP = schema.carePlans;
const CPV = schema.carePlanVersions;
const PROBLEM = schema.problems;
const GOAL = schema.goals;
const INTERVENTION = schema.interventions;
const APPLICATION = schema.carePlanIdgDecisionApplications;

export interface M7IdgConsumerOutboxPort {
  publish(
    tx: DbClient,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

interface M7IdgDispatchEvent {
  readonly id: string;
  readonly organizationId: string;
  readonly payload: unknown;
}

/** The forward-declared (event → consumer) binding M14 dispatches to once it lands (Wave F, §7.9). */
export const M7_IDG_DECISION_CONSUMER = {
  eventName: "idg.decision_recorded",
  consumerName: "m7.apply-idg-decision",
} as const;

/** The M7 arm is live; the source event can remain pending for other declared modules. */
export const M7_IDG_DECISION_CONSUMER_DEFERRED = false;

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`m7.apply-idg-decision: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringOf(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`m7.apply-idg-decision: '${key}' must be a non-empty string`);
  }
  return value;
}

function nullableStringOf(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`m7.apply-idg-decision: '${key}' must be a string or null`);
  }
  return value;
}

function problemKindOf(value: unknown): (typeof schema.problemKind.enumValues)[number] {
  switch (value) {
    case "terminal":
    case "related":
    case "unrelated":
      return value;
    default:
      throw new Error(`m7.apply-idg-decision: unsupported problem kind '${String(value)}'`);
  }
}

function problemStatusOf(value: unknown): (typeof schema.problemStatus.enumValues)[number] {
  switch (value) {
    case "active":
    case "resolved":
    case "inactive":
      return value;
    default:
      throw new Error(`m7.apply-idg-decision: unsupported problem status '${String(value)}'`);
  }
}

function goalSourceOf(value: unknown): (typeof schema.goalSource.enumValues)[number] {
  switch (value) {
    case "clinical":
    case "patient_stated":
    case "family_stated":
    case "agent_stated":
      return value;
    default:
      throw new Error(`m7.apply-idg-decision: unsupported goal source '${String(value)}'`);
  }
}

function goalStatusOf(value: unknown): (typeof schema.goalStatus.enumValues)[number] {
  switch (value) {
    case "not_started":
    case "in_progress":
    case "met":
    case "not_met":
    case "revised":
    case "discontinued":
      return value;
    default:
      throw new Error(`m7.apply-idg-decision: unsupported goal status '${String(value)}'`);
  }
}

function requireNonEmptyPatch(
  updates: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const keys = Object.keys(updates);
  if (keys.length === 0 || keys.some((key) => !allowedKeys.includes(key))) {
    throw new Error(`m7.apply-idg-decision: ${label} must contain only supported update fields`);
  }
}

function disciplineOf(value: unknown): (typeof schema.interventionDiscipline.enumValues)[number] {
  switch (value) {
    case "rn":
    case "lpn":
    case "chha":
    case "msw":
    case "chaplain":
    case "volunteer":
    case "bereavement":
    case "md_np":
    case "pt":
    case "ot":
    case "st":
    case "music_therapy":
    case "dietitian":
      return value;
    case "md":
    case "np":
      return "md_np";
    default:
      throw new Error(
        `m7.apply-idg-decision: unsupported intervention discipline '${String(value)}'`,
      );
  }
}

async function requireProblem(tx: DbClient, planId: string, problemId: string): Promise<void> {
  const [row] = await tx
    .select({ id: PROBLEM.id })
    .from(PROBLEM)
    .where(and(eq(PROBLEM.carePlanId, planId), eq(PROBLEM.id, problemId)))
    .limit(1);
  if (!row)
    throw new Error(`m7.apply-idg-decision: problem '${problemId}' is not on plan '${planId}'`);
}

async function applyMutation(
  tx: DbClient,
  input: {
    readonly organizationId: string;
    readonly plan: typeof CP.$inferSelect;
    readonly actorMembershipId: string;
    readonly mutation: unknown;
  },
): Promise<void> {
  const mutation = recordOf(input.mutation, "care-plan mutation");
  const op = stringOf(mutation, "op");
  const common = {
    organizationId: input.organizationId,
    providerEntityId: input.plan.providerEntityId,
    locationId: input.plan.locationId,
    carePlanId: input.plan.id,
  };

  switch (op) {
    case "problem_add":
      await tx.insert(PROBLEM).values({
        ...common,
        icd10Code: nullableStringOf(mutation, "icd10Code"),
        snomedCode: nullableStringOf(mutation, "snomedCode"),
        description: stringOf(mutation, "description"),
        kind: problemKindOf(mutation.problemKind),
        source: "clinical",
        status: "active",
        addedByMembershipId: input.actorMembershipId,
      });
      return;
    case "problem_update": {
      const id = stringOf(mutation, "problemId");
      const updates = recordOf(mutation.updates, "problem updates");
      requireNonEmptyPatch(updates, ["status", "description"], "problem updates");
      const patch: Partial<typeof PROBLEM.$inferInsert> = { updatedAt: new Date() };
      if (updates.status !== undefined) patch.status = problemStatusOf(updates.status);
      if (updates.description !== undefined) patch.description = stringOf(updates, "description");
      const rows = await tx
        .update(PROBLEM)
        .set({ ...patch, version: sql`${PROBLEM.version} + 1` })
        .where(and(eq(PROBLEM.carePlanId, input.plan.id), eq(PROBLEM.id, id)))
        .returning({ id: PROBLEM.id });
      if (rows.length !== 1) throw new Error(`m7.apply-idg-decision: problem '${id}' not found`);
      return;
    }
    case "goal_add": {
      const problemId = stringOf(mutation, "problemId");
      await requireProblem(tx, input.plan.id, problemId);
      await tx.insert(GOAL).values({
        ...common,
        problemId,
        originalText: stringOf(mutation, "originalText"),
        revisedText: nullableStringOf(mutation, "revisedText"),
        source: goalSourceOf(mutation.source),
        measurableOutcome: stringOf(mutation, "measurableOutcome"),
        addedByMembershipId: input.actorMembershipId,
      });
      return;
    }
    case "goal_update": {
      const id = stringOf(mutation, "goalId");
      const updates = recordOf(mutation.updates, "goal updates");
      requireNonEmptyPatch(updates, ["revisedText", "status", "statusNote"], "goal updates");
      const patch: Partial<typeof GOAL.$inferInsert> = { updatedAt: new Date() };
      if (updates.revisedText !== undefined) patch.revisedText = stringOf(updates, "revisedText");
      if (updates.status !== undefined) patch.status = goalStatusOf(updates.status);
      if (updates.statusNote !== undefined) patch.statusNote = stringOf(updates, "statusNote");
      const rows = await tx
        .update(GOAL)
        .set({ ...patch, version: sql`${GOAL.version} + 1` })
        .where(and(eq(GOAL.carePlanId, input.plan.id), eq(GOAL.id, id)))
        .returning({ id: GOAL.id });
      if (rows.length !== 1) throw new Error(`m7.apply-idg-decision: goal '${id}' not found`);
      return;
    }
    case "intervention_add": {
      const problemId = stringOf(mutation, "problemId");
      await requireProblem(tx, input.plan.id, problemId);
      const rawGoalRefs = mutation.goalRefs;
      if (!Array.isArray(rawGoalRefs) || rawGoalRefs.some((id) => typeof id !== "string")) {
        throw new Error("m7.apply-idg-decision: 'goalRefs' must be an array of ids");
      }
      const goalRefs = rawGoalRefs.filter((id): id is string => typeof id === "string");
      if (goalRefs.length > 0) {
        const found = await tx
          .select({ id: GOAL.id })
          .from(GOAL)
          .where(and(eq(GOAL.carePlanId, input.plan.id), inArray(GOAL.id, goalRefs)));
        if (found.length !== new Set(goalRefs).size) {
          throw new Error("m7.apply-idg-decision: one or more intervention goalRefs are off-plan");
        }
      }
      await tx.insert(INTERVENTION).values({
        ...common,
        problemId,
        goalRefs,
        discipline: disciplineOf(mutation.discipline),
        scopeText: stringOf(mutation, "scopeText"),
        frequencyText: stringOf(mutation, "frequencyText"),
        frequencyValue: stringOf(mutation, "frequencyValue"),
        addedByMembershipId: input.actorMembershipId,
      });
      return;
    }
    case "intervention_discontinue": {
      const id = stringOf(mutation, "interventionId");
      const rows = await tx
        .update(INTERVENTION)
        .set({
          status: "discontinued",
          discontinueReason: stringOf(mutation, "reason"),
          updatedAt: new Date(),
          version: sql`${INTERVENTION.version} + 1`,
        })
        .where(and(eq(INTERVENTION.carePlanId, input.plan.id), eq(INTERVENTION.id, id)))
        .returning({ id: INTERVENTION.id });
      if (rows.length !== 1) {
        throw new Error(`m7.apply-idg-decision: intervention '${id}' not found`);
      }
      return;
    }
    default:
      throw new Error(`m7.apply-idg-decision: unsupported care-plan mutation '${op}'`);
  }
}

/** Build the production M7 binding. Source events for other decision arms are valid handled no-ops. */
export function buildM7IdgDecisionConsumer(deps: {
  readonly db: DbClient;
  readonly outbox: M7IdgConsumerOutboxPort;
}): {
  readonly consumerName: "m7.apply-idg-decision";
  readonly consumerModule: "m7";
  readonly eventTypes: readonly ["idg.decision_recorded"];
  handle(event: M7IdgDispatchEvent): Promise<void>;
} {
  return {
    consumerName: "m7.apply-idg-decision",
    consumerModule: "m7",
    eventTypes: ["idg.decision_recorded"],
    async handle(event) {
      const envelope = recordOf(event.payload, "event payload");
      if (stringOf(envelope, "organizationId") !== event.organizationId) {
        throw new Error("m7.apply-idg-decision: payload organization does not match outbox tenant");
      }
      if (stringOf(envelope, "payloadSchemaVersion") !== "2026-01-v1") {
        throw new Error("m7.apply-idg-decision: unsupported payload schema version");
      }
      const payload = recordOf(envelope.payload, "decision payload");
      if (stringOf(payload, "kind") !== "care_plan_update") return;
      if (!Array.isArray(payload.mutations) || payload.mutations.length === 0) {
        throw new Error("m7.apply-idg-decision: care_plan_update requires mutations");
      }
      const mutations = payload.mutations;
      const decisionId = stringOf(envelope, "decisionId");
      const meetingId = stringOf(envelope, "meetingId");
      const patientId = stringOf(envelope, "patientId");
      const actorMembershipId = stringOf(envelope, "recordedByMembershipId");

      await withOrgContext(
        deps.db,
        { organizationId: event.organizationId, userId: "" },
        async (tx) => {
          const t = tx as DbClient;
          const [already] = await t
            .select({ id: APPLICATION.id })
            .from(APPLICATION)
            .where(
              and(
                eq(APPLICATION.organizationId, event.organizationId),
                eq(APPLICATION.idgDecisionId, decisionId),
              ),
            )
            .limit(1);
          if (already) return;

          const [plan] = await t
            .select()
            .from(CP)
            .where(and(eq(CP.patientId, patientId), eq(CP.status, "active")))
            .limit(1);
          if (!plan) {
            throw new Error(
              `m7.apply-idg-decision: no active care plan for patient '${patientId}'`,
            );
          }

          let [version] = await t
            .select()
            .from(CPV)
            .where(
              and(
                eq(CPV.carePlanId, plan.id),
                eq(CPV.kind, "idg_review"),
                eq(CPV.idgMeetingId, meetingId),
                eq(CPV.status, "draft"),
              ),
            )
            .limit(1);
          if (!version) {
            const [{ maxSeq } = { maxSeq: 0 }] = await t
              .select({ maxSeq: sql<number>`coalesce(max(${CPV.sequence}), 0)::int` })
              .from(CPV)
              .where(eq(CPV.carePlanId, plan.id));
            [version] = await t
              .insert(CPV)
              .values({
                organizationId: event.organizationId,
                providerEntityId: plan.providerEntityId,
                locationId: plan.locationId,
                carePlanId: plan.id,
                sequence: Number(maxSeq) + 1,
                kind: "idg_review",
                status: "draft",
                idgMeetingId: meetingId,
                requiredSignerSet: resolveRequiredSignerSet("idg_review"),
                draftedByMembershipId: actorMembershipId,
              })
              .returning();
            if (!version) throw new Error("m7.apply-idg-decision: version insert returned no row");
            await deps.outbox.publish(t, {
              eventName: "m7.care_plan.version_drafted",
              organizationId: event.organizationId,
              aggregateKind: "care_plan_version",
              aggregateId: version.id,
              payload: {
                planId: plan.id,
                versionId: version.id,
                kind: "idg_review",
                sequence: version.sequence,
              },
            });
          }

          for (const mutation of mutations) {
            await applyMutation(t, {
              organizationId: event.organizationId,
              plan,
              actorMembershipId,
              mutation,
            });
          }

          await t.insert(APPLICATION).values({
            organizationId: event.organizationId,
            providerEntityId: plan.providerEntityId,
            locationId: plan.locationId,
            idgDecisionId: decisionId,
            sourceOutboxEventId: event.id,
            carePlanId: plan.id,
            carePlanVersionId: version.id,
          });
          const auditContext: AuditContext = {
            organizationId: event.organizationId,
            userId: null,
            actorKind: "system",
            correlationId: `idg-decision:${decisionId}`,
          };
          await audit(t, auditContext, {
            eventType: "m7.care_plan.idg_decision_applied",
            resourceKind: "care_plan_version",
            resourceId: version.id,
            outcome: "success",
            context: { decisionId, meetingId, mutationCount: mutations.length },
          });
        },
      );
    },
  };
}

/**
 * The pure decision helper retained for policy tests: resolve {@link IdgApplyFacts} from the
 * idempotency audit log + the care-plan aggregate, then call this to get the {@link IdgApplyAction} to
 * execute. Kept as a one-line compatibility re-export.
 */
export function decideIdgDecisionRecorded(
  payload: IdgDecisionPayload,
  facts: IdgApplyFacts,
): IdgApplyAction {
  return decideIdgDecision(payload, facts);
}
