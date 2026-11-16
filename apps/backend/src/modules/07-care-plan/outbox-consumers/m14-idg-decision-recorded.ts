import { randomUUID } from "node:crypto";
// M7's live `idg.decision_recorded` care-plan consumer. It reads only the canonical event contract,
// validates the consumed arm defensively, and commits a governed proposal plus a durable decision-id
// marker in one org-scoped transaction. Clinical rows are not mutated until the idg_review version
// reaches quorum and publishes.
import { type AuditContext, audit } from "@chartwarden/audit";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  OUTBOX_DEFERRAL_RETRY_MS,
  OutboxDeferral,
  withinDeferralHorizon,
} from "../../../bootstrap/outbox-dispatcher";
import { transitionIntervention } from "../lifecycle";
import { resolveRequiredSignerSet } from "../lifecycle/required-signer-set";
import {
  IdgProposalRefusal,
  guardGoalStatus,
  guardProblemStatus,
  guardTransition,
  invalidPayload,
  notFound,
} from "./m14-idg-proposal-guards";

const CP = schema.carePlans;
const CPV = schema.carePlanVersions;
const PROBLEM = schema.problems;
const GOAL = schema.goals;
const INTERVENTION = schema.interventions;
const APPLICATION = schema.carePlanIdgDecisionApplications;
const PROPOSED_CHANGE = schema.carePlanIdgProposedChanges;

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
  /** The outbox row's creation instant (the relay always supplies it); bounds how long a decision may wait. */
  readonly createdAt?: Date;
}

/**
 * A decision refused only because of a condition that clears on its own (a plan not yet signed, a revision
 * awaiting signatures) WAITS instead of being recorded as refused: the relay retries it without consuming an
 * attempt, so it applies once the blocker is gone and nobody has to re-record it. Past the horizon the caller
 * records its durable refusal as before, so a blocker that never clears still leaves a human-visible trace.
 */
function deferWhileYoung(event: M7IdgDispatchEvent, reason: string): void {
  if (event.createdAt === undefined || !withinDeferralHorizon({ createdAt: event.createdAt }))
    return;
  throw new OutboxDeferral(`m7.apply-idg-decision: ${reason}`, OUTBOX_DEFERRAL_RETRY_MS);
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
    throw invalidPayload(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringOf(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw invalidPayload(`'${key}' must be a non-empty string`);
  }
  return value;
}

function nullableStringOf(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw invalidPayload(`'${key}' must be a string or null`);
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
      throw invalidPayload("unsupported problem kind");
  }
}

function problemStatusOf(value: unknown): (typeof schema.problemStatus.enumValues)[number] {
  switch (value) {
    case "active":
    case "resolved":
    case "inactive":
      return value;
    default:
      throw invalidPayload("unsupported problem status");
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
      throw invalidPayload("unsupported goal source");
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
      throw invalidPayload("unsupported goal status");
  }
}

function requireNonEmptyPatch(
  updates: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const keys = Object.keys(updates);
  if (keys.length === 0 || keys.some((key) => !allowedKeys.includes(key))) {
    throw invalidPayload(`${label} must contain only supported update fields`);
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
      // M14's schema accepts any discipline string (decision-payload-schema.ts); M7's enum is narrower.
      throw new IdgProposalRefusal(
        "unsupported_intervention_discipline",
        "unsupported intervention discipline (not an M7 interventionDiscipline value)",
      );
  }
}

async function requireProblem(tx: DbClient, planId: string, problemId: string): Promise<void> {
  const [row] = await tx
    .select({ id: PROBLEM.id })
    .from(PROBLEM)
    .where(and(eq(PROBLEM.carePlanId, planId), eq(PROBLEM.id, problemId)))
    .limit(1);
  if (!row) {
    throw new IdgProposalRefusal(
      "element_not_found",
      `problem '${problemId}' is not on plan '${planId}'`,
    );
  }
}

const iso = (d: Date | string | null): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : d;

async function captureBaselineSnapshot(tx: DbClient, planId: string) {
  const [probRows, goalRows, intvRows] = await Promise.all([
    tx.select().from(PROBLEM).where(eq(PROBLEM.carePlanId, planId)).orderBy(asc(PROBLEM.id)),
    tx.select().from(GOAL).where(eq(GOAL.carePlanId, planId)).orderBy(asc(GOAL.id)),
    tx
      .select()
      .from(INTERVENTION)
      .where(eq(INTERVENTION.carePlanId, planId))
      .orderBy(asc(INTERVENTION.id)),
  ]);
  return {
    schemaVersion: "2026-08-m7-v1",
    problems: probRows.map((p) => ({
      id: p.id,
      icd10Code: p.icd10Code ?? null,
      snomedCode: p.snomedCode ?? null,
      description: p.description,
      kind: p.kind,
      source: p.source,
      sudRelated: p.sudRelated,
      status: p.status,
      onsetAt: iso(p.onsetAt),
      resolvedAt: iso(p.resolvedAt),
      resolutionNote: p.resolutionNote ?? null,
      version: Number(p.version),
    })),
    goals: goalRows.map((g) => ({
      id: g.id,
      problemId: g.problemId,
      originalText: g.originalText,
      revisedText: g.revisedText ?? null,
      source: g.source,
      actingConsentId: g.actingConsentId ?? null,
      measurableOutcome: g.measurableOutcome ?? null,
      targetAt: iso(g.targetAt),
      status: g.status,
      statusNote: g.statusNote ?? null,
      version: Number(g.version),
    })),
    interventions: intvRows.map((i) => ({
      id: i.id,
      problemId: i.problemId,
      goalRefs: (i.goalRefs as string[]) ?? [],
      scopeText: i.scopeText,
      frequencyText: i.frequencyText,
      frequencyValue: i.frequencyValue,
      discipline: i.discipline,
      responsibleRole: i.responsibleRole ?? null,
      linkedOrderId: i.linkedOrderId ?? null,
      status: i.status,
      discontinueReason: i.discontinueReason ?? null,
      version: Number(i.version),
    })),
  };
}

/**
 * Turn one M14 care-plan mutation into a governed proposed-change row (reads only: no clinical row is
 * written, and `carePlanVersionId` is attached by the caller once the idg_review version is known, so a
 * refused decision never opens a version). Throws {@link IdgProposalRefusal} for anything non-transient.
 */
export async function buildProposedChange(
  tx: DbClient,
  input: {
    readonly organizationId: string;
    readonly plan: typeof CP.$inferSelect;
    readonly mutation: unknown;
    readonly applicationId: string;
    readonly decisionId: string;
    readonly meetingId: string;
    readonly ordinal: number;
  },
): Promise<Omit<typeof PROPOSED_CHANGE.$inferInsert, "carePlanVersionId">> {
  const mutation = recordOf(input.mutation, "care-plan mutation");
  const op = stringOf(mutation, "op");
  const common = {
    organizationId: input.organizationId,
    providerEntityId: input.plan.providerEntityId,
    locationId: input.plan.locationId,
    applicationId: input.applicationId,
    carePlanId: input.plan.id,
    idgDecisionId: input.decisionId,
    idgMeetingId: input.meetingId,
    ordinal: input.ordinal,
    operation: op,
  };

  switch (op) {
    case "problem_add": {
      const proposed = {
        id: randomUUID(),
        icd10Code: nullableStringOf(mutation, "icd10Code"),
        snomedCode: nullableStringOf(mutation, "snomedCode"),
        description: stringOf(mutation, "description"),
        kind: problemKindOf(mutation.problemKind),
        source: "clinical",
        sudRelated: false,
        status: "active",
      };
      return {
        ...common,
        entityType: "problem",
        targetEntityId: proposed.id,
        before: null,
        proposed,
      };
    }
    case "problem_update": {
      const id = stringOf(mutation, "problemId");
      const updates = recordOf(mutation.updates, "problem updates");
      requireNonEmptyPatch(updates, ["status", "description"], "problem updates");
      const [before] = await tx
        .select()
        .from(PROBLEM)
        .where(and(eq(PROBLEM.carePlanId, input.plan.id), eq(PROBLEM.id, id)))
        .limit(1);
      if (!before) throw notFound("problem", id);
      const proposed: Record<string, unknown> = {};
      const toStatus = updates.status !== undefined ? problemStatusOf(updates.status) : undefined;
      // Always guard: a resolved/inactive problem refuses every edit, not only a status change.
      guardProblemStatus(before, toStatus);
      if (toStatus !== undefined) proposed.status = toStatus;
      if (updates.description !== undefined)
        proposed.description = stringOf(updates, "description");
      return { ...common, entityType: "problem", targetEntityId: id, before, proposed };
    }
    case "goal_add": {
      const problemId = stringOf(mutation, "problemId");
      await requireProblem(tx, input.plan.id, problemId);
      const proposed = {
        id: randomUUID(),
        problemId,
        originalText: stringOf(mutation, "originalText"),
        revisedText: nullableStringOf(mutation, "revisedText"),
        source: goalSourceOf(mutation.source),
        measurableOutcome: stringOf(mutation, "measurableOutcome"),
      };
      return {
        ...common,
        entityType: "goal",
        targetEntityId: proposed.id,
        before: null,
        proposed,
      };
    }
    case "goal_update": {
      const id = stringOf(mutation, "goalId");
      const updates = recordOf(mutation.updates, "goal updates");
      requireNonEmptyPatch(updates, ["revisedText", "status", "statusNote"], "goal updates");
      const [before] = await tx
        .select()
        .from(GOAL)
        .where(and(eq(GOAL.carePlanId, input.plan.id), eq(GOAL.id, id)))
        .limit(1);
      if (!before) throw notFound("goal", id);
      const proposed: Record<string, unknown> = {};
      if (updates.revisedText !== undefined)
        proposed.revisedText = stringOf(updates, "revisedText");
      const toStatus = updates.status !== undefined ? goalStatusOf(updates.status) : undefined;
      // Always guard: a met / not_met / discontinued goal refuses every edit, not only a status change.
      guardGoalStatus(before.status, toStatus);
      if (toStatus !== undefined) proposed.status = toStatus;
      if (updates.statusNote !== undefined) proposed.statusNote = stringOf(updates, "statusNote");
      return { ...common, entityType: "goal", targetEntityId: id, before, proposed };
    }
    case "intervention_add": {
      const problemId = stringOf(mutation, "problemId");
      await requireProblem(tx, input.plan.id, problemId);
      const rawGoalRefs = mutation.goalRefs;
      if (!Array.isArray(rawGoalRefs) || rawGoalRefs.some((id) => typeof id !== "string")) {
        throw invalidPayload("'goalRefs' must be an array of ids");
      }
      const goalRefs = rawGoalRefs.filter((id): id is string => typeof id === "string");
      if (goalRefs.length > 0) {
        const found = await tx
          .select({ id: GOAL.id })
          .from(GOAL)
          .where(and(eq(GOAL.carePlanId, input.plan.id), inArray(GOAL.id, goalRefs)));
        if (found.length !== new Set(goalRefs).size) {
          throw new IdgProposalRefusal(
            "element_not_found",
            "one or more intervention goalRefs are off-plan",
          );
        }
      }
      const proposed = {
        id: randomUUID(),
        problemId,
        goalRefs,
        discipline: disciplineOf(mutation.discipline),
        scopeText: stringOf(mutation, "scopeText"),
        frequencyText: stringOf(mutation, "frequencyText"),
        frequencyValue: stringOf(mutation, "frequencyValue"),
      };
      return {
        ...common,
        entityType: "intervention",
        targetEntityId: proposed.id,
        before: null,
        proposed,
      };
    }
    case "intervention_discontinue": {
      const id = stringOf(mutation, "interventionId");
      const [before] = await tx
        .select()
        .from(INTERVENTION)
        .where(and(eq(INTERVENTION.carePlanId, input.plan.id), eq(INTERVENTION.id, id)))
        .limit(1);
      if (!before) throw notFound("intervention", id);
      const reason = stringOf(mutation, "reason");
      guardTransition(() => transitionIntervention(before.status, { type: "discontinue", reason }));
      return {
        ...common,
        entityType: "intervention",
        targetEntityId: id,
        before,
        proposed: {
          status: "discontinued",
          discontinueReason: reason,
        },
      };
    }
    default:
      throw new IdgProposalRefusal("invalid_mutation", "unsupported care-plan mutation");
  }
}

interface RefusedDecision {
  readonly organizationId: string;
  readonly plan: typeof CP.$inferSelect;
  readonly decisionId: string;
  readonly meetingId: string;
  readonly sourceEventId: string;
}

/**
 * Persist a refused decision as a durable `conflict` application (reason in `conflict_reason`) plus an audit
 * event, so the IDG decision leaves a human-visible trace and the outbox row is acked rather than retried
 * into the dead-letter queue. The row is anchored on a NON-idg_review version: finalize/sign read every
 * application of an idg_review version and treat any that is not 'proposed' as a conflict that blocks publish.
 */
async function recordRefusal(
  tx: DbClient,
  input: RefusedDecision,
  refusal: IdgProposalRefusal,
): Promise<void> {
  const [anchor] = await tx
    .select({ id: CPV.id })
    .from(CPV)
    .where(and(eq(CPV.carePlanId, input.plan.id), ne(CPV.kind, "idg_review")))
    .orderBy(desc(CPV.sequence))
    .limit(1);
  if (!anchor) {
    // Every bootstrapped plan has its initial version; a plan without one is mid-bootstrap, so retry.
    throw new Error(`m7.apply-idg-decision: care plan '${input.plan.id}' has no version yet`);
  }
  const inserted = await tx
    .insert(APPLICATION)
    .values({
      organizationId: input.organizationId,
      providerEntityId: input.plan.providerEntityId,
      locationId: input.plan.locationId,
      idgDecisionId: input.decisionId,
      idgMeetingId: input.meetingId,
      sourceOutboxEventId: input.sourceEventId,
      carePlanId: input.plan.id,
      carePlanVersionId: anchor.id,
      status: "conflict",
      conflictReason: `${refusal.code}: ${refusal.reason}`,
    })
    .onConflictDoNothing({ target: [APPLICATION.organizationId, APPLICATION.idgDecisionId] })
    .returning({ id: APPLICATION.id });
  if (inserted.length === 0) return;
  await audit(
    tx,
    {
      organizationId: input.organizationId,
      userId: null,
      actorKind: "system",
      correlationId: `idg-decision:${input.decisionId}`,
    },
    {
      eventType: "m7.care_plan.idg_proposal_refused",
      resourceKind: "care_plan",
      resourceId: input.plan.id,
      outcome: "denied",
      context: { decisionId: input.decisionId, meetingId: input.meetingId, reason: refusal.code },
    },
  );
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

          const refused = (plan: typeof CP.$inferSelect): RefusedDecision => ({
            organizationId: event.organizationId,
            plan,
            decisionId,
            meetingId,
            sourceEventId: event.id,
          });

          const [plan] = await t
            .select()
            .from(CP)
            .where(and(eq(CP.patientId, patientId), eq(CP.status, "active")))
            .limit(1);
          if (!plan) {
            // A plan that exists but is not active (draft/unsigned, discharged) can never take this decision:
            // record it. No plan at all means the M6 bootstrap has not run yet: transient, so throw and retry.
            const [latest] = await t
              .select()
              .from(CP)
              .where(eq(CP.patientId, patientId))
              .orderBy(desc(CP.createdAt))
              .limit(1);
            if (!latest) {
              throw new Error(
                `m7.apply-idg-decision: no care plan for patient '${patientId}' (not bootstrapped yet)`,
              );
            }
            // A draft plan becomes active when its initial version is signed: wait for that.
            if (latest.status !== "discharged") {
              deferWhileYoung(
                event,
                `care plan '${latest.id}' is '${latest.status}', not active yet`,
              );
            }
            await recordRefusal(
              t,
              refused(latest),
              new IdgProposalRefusal(
                latest.status === "discharged" ? "plan_discharged" : "plan_not_active",
                `care plan '${latest.id}' is '${latest.status}', not active, so the IDG decision was not applied`,
              ),
            );
            return;
          }

          // Build every proposed change before opening a version, so a refused decision opens nothing.
          const applicationId = randomUUID();
          const drafts: Awaited<ReturnType<typeof buildProposedChange>>[] = [];
          try {
            for (const [ordinal, mutation] of mutations.entries()) {
              drafts.push(
                await buildProposedChange(t, {
                  organizationId: event.organizationId,
                  plan,
                  mutation,
                  applicationId,
                  decisionId,
                  meetingId,
                  ordinal,
                }),
              );
            }
          } catch (error) {
            if (!(error instanceof IdgProposalRefusal)) throw error;
            await recordRefusal(t, refused(plan), error);
            return;
          }

          // Each mutation was guarded alone against the LIVE row, but finalize applies a version's changes in
          // sequence: a terminal move (goal `met`, problem `inactive`, intervention discontinued) followed by
          // another change to the same element would pass the builder and then fail `finalizeVersion` for good,
          // wedging the plan's single open-version slot. So an element is changed at most once per version.
          const targets = drafts.flatMap((draft) =>
            typeof draft.targetEntityId === "string" ? [draft.targetEntityId] : [],
          );
          const repeated = targets.find((id, index) => targets.indexOf(id) !== index);
          if (repeated !== undefined) {
            await recordRefusal(
              t,
              refused(plan),
              new IdgProposalRefusal(
                "element_targeted_twice",
                `two mutations of this decision target element '${repeated}'; send one mutation per element`,
              ),
            );
            return;
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
          if (version && targets.length > 0) {
            // Another decision of this meeting already proposes a change to one of these elements. Waiting
            // until that version is finalized and applied lets this decision be judged against the result.
            const [clash] = await t
              .select({ id: PROPOSED_CHANGE.id })
              .from(PROPOSED_CHANGE)
              .where(
                and(
                  eq(PROPOSED_CHANGE.carePlanVersionId, version.id),
                  inArray(PROPOSED_CHANGE.targetEntityId, targets),
                ),
              )
              .limit(1);
            if (clash) {
              deferWhileYoung(
                event,
                `care-plan version '${version.id}' already carries a pending change to an element of this decision`,
              );
              await recordRefusal(
                t,
                refused(plan),
                new IdgProposalRefusal(
                  "element_has_pending_change",
                  `care-plan version '${version.id}' already carries a pending IDG change to an element of this decision; finalize or return it, then re-record the IDG decision`,
                ),
              );
              return;
            }
          }
          if (!version) {
            const [open] = await t
              .select()
              .from(CPV)
              .where(and(eq(CPV.carePlanId, plan.id), inArray(CPV.status, ["draft", "in_review"])))
              .limit(1);
            if (open) {
              // The open revision is signed (or abandoned) sooner or later: wait for the slot to free up.
              deferWhileYoung(
                event,
                `care-plan version '${open.id}' (${open.kind}, ${open.status}) is already open`,
              );
              await recordRefusal(
                t,
                refused(plan),
                new IdgProposalRefusal(
                  "version_already_open",
                  `care-plan version '${open.id}' (${open.kind}, ${open.status}) is already open; finish or return it, then re-record the IDG decision`,
                ),
              );
              return;
            }
          }
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
          const versionId = version.id;

          const baselineSnapshot = await captureBaselineSnapshot(t, plan.id);
          const inserted = await t
            .insert(APPLICATION)
            .values({
              id: applicationId,
              organizationId: event.organizationId,
              providerEntityId: plan.providerEntityId,
              locationId: plan.locationId,
              idgDecisionId: decisionId,
              idgMeetingId: meetingId,
              sourceOutboxEventId: event.id,
              carePlanId: plan.id,
              carePlanVersionId: versionId,
              status: "proposed",
              baselineSnapshot,
            })
            .onConflictDoNothing({
              target: [APPLICATION.organizationId, APPLICATION.idgDecisionId],
            })
            .returning({ id: APPLICATION.id });
          if (inserted.length === 0) return;

          const proposedChanges = drafts.map((draft) => ({
            ...draft,
            carePlanVersionId: versionId,
          }));
          await t.insert(PROPOSED_CHANGE).values(proposedChanges);
          await deps.outbox.publish(t, {
            eventName: "m7.care_plan.idg_proposal_created",
            organizationId: event.organizationId,
            aggregateKind: "care_plan_version",
            aggregateId: versionId,
            payload: {
              planId: plan.id,
              versionId,
              decisionId,
              meetingId,
              changeCount: proposedChanges.length,
            },
          });
          const auditContext: AuditContext = {
            organizationId: event.organizationId,
            userId: null,
            actorKind: "system",
            correlationId: `idg-decision:${decisionId}`,
          };
          await audit(t, auditContext, {
            eventType: "m7.care_plan.idg_proposal_created",
            resourceKind: "care_plan_version",
            resourceId: versionId,
            outcome: "success",
            context: { decisionId, meetingId, mutationCount: proposedChanges.length },
          });
        },
      );
    },
  };
}
