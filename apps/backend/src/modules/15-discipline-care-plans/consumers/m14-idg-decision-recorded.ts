// apps/backend/src/modules/15-discipline-care-plans/consumers/m14-idg-decision-recorded.ts — M15's live
// `idg.decision_recorded` binding (F-232 / #248; M15 spec §7.7 `idg-decision.worker`, §4.5 idempotency key
// `idgDecisionId`). It consumes only `kind: 'discipline_plan_update'`; every other decision arm belongs to
// M7/M11/M12/M16 and is a handled no-op (the additive arm sits inside `payloadSchemaVersion` 2026-01-v1, and
// the other four consumers each `return` on a kind they do not own — verified, not assumed).
//
// Reads ONLY the canonical event contract (string literals, no M14 import — M15 reads M14 through the outbox,
// never a `dependsOn` edge) and validates the consumed arm defensively before any write (§8.6 Tampering: a
// malformed or replayed event must not apply unauthorized mutations).
//
// ONE transaction per delivery, under the tenant's RLS (`withOrgContext`, system actor — no membership):
//   1. idempotency — a `discipline_plan_idg_decision_application` row for (org, decisionId) → no-op;
//   2. the patient's live plan of `planKind`, row-locked so two decisions for one plan serialize;
//   3. the pure decider (`./apply-idg-decision`) over the facts read here;
//   4. REFUSE → a terminal `refused` row, nothing else (no event, nothing applied) — or
//      APPLY → (open the plan's next version if none is open) → the goal/intervention writes → an `applied`
//      row → `m15.idg_decision.applied` through the catalog-validating publisher, all or nothing.
// Transient conditions THROW so the relay retries and, if they persist, dead-letters visibly: no plan has been
// bootstrapped for the patient yet, or the plan's open version is sealed `in_review`.
//
// The M7 IPOC parent-problem check is an INJECTED org-explicit port (bound at the composition root to M7's
// `activeProblemIdsForOrg`): `CarePlanReader`'s id-keyed reads need an ambient request scope a relay tick has
// not got, and M15 must not import M7's schema. The port runs BEFORE the transaction (its own `withOrgContext`).
import { randomUUID } from "node:crypto";
import { type AuditContext, audit } from "@wardenx/audit";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { DisciplineGoalSource, DisciplinePlanKind } from "@wardenx/types";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { transitionDisciplinePlan } from "../lifecycle/plan";
import { resolveRequiredSignerSet } from "../lifecycle/required-signer-set";
import type { WriteOutboxPort } from "../routes/write-service";
import {
  DISCIPLINE_PLAN_UPDATE_KIND,
  IDG_AUTHORING_DISCIPLINE,
  type IdgApplyFacts,
  type ParsedDisciplineMutation,
  decideDisciplinePlanDecision,
} from "./apply-idg-decision";

const PLAN = schema.disciplineCarePlan;
const VERSION = schema.disciplineCarePlanVersion;
const GOAL = schema.disciplineGoal;
const INTERVENTION = schema.disciplineIntervention;
const APPLICATION = schema.disciplinePlanIdgDecisionApplication;

/** §3.3 — a consumer-driven write names no acting membership. */
const CONSUMER_USER_ID = "";

/** The event M15 consumes, and the `(eventId, consumerName)` receipt identity. */
export const M15_IDG_DECISION_CONSUMER = {
  eventName: "idg.decision_recorded",
  consumerName: "m15.apply-idg-decision",
} as const;

const PLAN_KINDS: readonly DisciplinePlanKind[] = [
  "aide_poc",
  "msw_plan",
  "spiritual_plan",
  "volunteer_plan",
];
const GOAL_SOURCES: readonly DisciplineGoalSource[] = [
  "clinical",
  "patient_stated",
  "family_stated",
  "agent_stated",
];
const GOAL_EVENTS = ["start", "meet", "missTarget", "revise", "discontinue"] as const;

/** The org-explicit M7 read the consumer needs: the patient's ACTIVE IPOC problem ids. */
export type ActiveProblemIdsResolver = (
  organizationId: string,
  patientId: string,
) => Promise<readonly string[]>;

export interface DisciplinePlanIdgDecisionDeps {
  readonly db: DbClient;
  /** The catalog-validating publisher pinned to callerModule `m15`; rolls the tx back on a mismatch, so an
   *  applied decision can never be unannounced. */
  readonly outbox: WriteOutboxPort;
  readonly activeProblemIds: ActiveProblemIdsResolver;
}

const fail = (message: string): never => {
  throw new Error(`${M15_IDG_DECISION_CONSUMER.consumerName}: ${message}`);
};

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringOf(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    return fail(`'${key}' must be a non-empty string`);
  }
  return value;
}

function optionalStringOf(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    return fail(`'${key}' must be a non-empty string when present`);
  }
  return value;
}

function nullableStringOf(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return fail(`'${key}' must be a string or null`);
  return value;
}

const FREQUENCY_PATTERN =
  /^[0-9]+:(visit|day|week|month|prn|continuous):(day|week|month|episode|prn)$/;

/** Parse one wire mutation; an unknown op or a missing field is a THROW (a tampered/garbled event). */
function parseMutation(raw: unknown): ParsedDisciplineMutation {
  const m = recordOf(raw, "mutation");
  const op = stringOf(m, "op");
  switch (op) {
    case "goal_add": {
      const source = stringOf(m, "source") as DisciplineGoalSource;
      if (!GOAL_SOURCES.includes(source)) return fail(`unsupported goal source '${source}'`);
      return {
        op,
        parentProblemId: stringOf(m, "parentProblemId"),
        source,
        originalText: stringOf(m, "originalText"),
        measurableOutcome: nullableStringOf(m, "measurableOutcome"),
      };
    }
    case "goal_update": {
      const event = stringOf(m, "event") as (typeof GOAL_EVENTS)[number];
      if (!GOAL_EVENTS.includes(event)) return fail(`unsupported goal event '${event}'`);
      const revisedText = optionalStringOf(m, "revisedText");
      const reason = optionalStringOf(m, "reason");
      return {
        op,
        goalId: stringOf(m, "goalId"),
        event,
        ...(revisedText !== undefined ? { revisedText } : {}),
        ...(reason !== undefined ? { reason } : {}),
      };
    }
    case "intervention_add": {
      const goalRefs = m.goalRefs;
      if (!Array.isArray(goalRefs) || goalRefs.some((g) => typeof g !== "string")) {
        return fail("'goalRefs' must be an array of ids");
      }
      const frequencyValue = stringOf(m, "frequencyValue");
      if (!FREQUENCY_PATTERN.test(frequencyValue)) return fail("malformed frequencyValue");
      return {
        op,
        goalRefs: goalRefs as string[],
        discipline: stringOf(m, "discipline"),
        scopeText: stringOf(m, "scopeText"),
        frequencyText: stringOf(m, "frequencyText"),
        frequencyValue,
      };
    }
    case "intervention_discontinue":
      return {
        op,
        interventionId: stringOf(m, "interventionId"),
        reason: stringOf(m, "reason"),
      };
    default:
      return fail(`unsupported discipline-plan mutation '${op}'`);
  }
}

/** Parse the consumed arm of an `idg.decision_recorded` envelope; null when it is another module's arm. */
export function parseDisciplinePlanDecision(
  organizationId: string,
  rawPayload: unknown,
): {
  readonly decisionId: string;
  readonly meetingId: string;
  readonly patientId: string;
  readonly recordedByMembershipId: string;
  readonly planKind: DisciplinePlanKind;
  readonly mutations: readonly ParsedDisciplineMutation[];
} | null {
  const envelope = recordOf(rawPayload, "event payload");
  if (stringOf(envelope, "organizationId") !== organizationId) {
    return fail("payload organization does not match the outbox tenant");
  }
  if (stringOf(envelope, "payloadSchemaVersion") !== "2026-01-v1") {
    return fail("unsupported payload schema version");
  }
  const payload = recordOf(envelope.payload, "decision payload");
  if (stringOf(payload, "kind") !== DISCIPLINE_PLAN_UPDATE_KIND) return null;
  const planKind = stringOf(payload, "planKind") as DisciplinePlanKind;
  if (!PLAN_KINDS.includes(planKind)) return fail(`unsupported planKind '${planKind}'`);
  const rawMutations = payload.mutations;
  if (!Array.isArray(rawMutations) || rawMutations.length === 0) {
    return fail("discipline_plan_update requires mutations");
  }
  return {
    decisionId: stringOf(envelope, "decisionId"),
    meetingId: stringOf(envelope, "meetingId"),
    patientId: stringOf(envelope, "patientId"),
    recordedByMembershipId: stringOf(envelope, "recordedByMembershipId"),
    planKind,
    mutations: rawMutations.map(parseMutation),
  };
}

/** M15's live `idg.decision_recorded` binding. */
export function buildM15IdgDecisionConsumer(deps: DisciplinePlanIdgDecisionDeps) {
  return {
    consumerName: M15_IDG_DECISION_CONSUMER.consumerName,
    consumerModule: "m15" as const,
    eventTypes: [M15_IDG_DECISION_CONSUMER.eventName] as const,
    async handle(event: {
      readonly id: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const organizationId = event.organizationId;
      const decision = parseDisciplinePlanDecision(organizationId, event.payload);
      if (decision === null) return; // another module's decision arm

      // The M7 read opens its own tenant transaction, so it runs before ours.
      const activeProblemIds = new Set(
        await deps.activeProblemIds(organizationId, decision.patientId),
      );

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;

          const [already] = await tx
            .select({ id: APPLICATION.id })
            .from(APPLICATION)
            .where(
              and(
                eq(APPLICATION.organizationId, organizationId),
                eq(APPLICATION.idgDecisionId, decision.decisionId),
              ),
            )
            .limit(1);
          if (already) return; // idempotent on idgDecisionId (§4.5)

          // The patient's live plan of this kind; locked so concurrent decisions on one plan serialize.
          const [plan] = await tx
            .select()
            .from(PLAN)
            .where(
              and(
                eq(PLAN.organizationId, organizationId),
                eq(PLAN.patientId, decision.patientId),
                eq(PLAN.kind, decision.planKind),
                ne(PLAN.status, "discharged"),
              ),
            )
            .limit(1)
            .for("update");

          const inherit = (p: typeof PLAN.$inferSelect) => ({
            organizationId,
            providerEntityId: p.providerEntityId,
            locationId: p.locationId,
          });
          const baseRow = (p: typeof PLAN.$inferSelect) => ({
            ...inherit(p),
            patientId: decision.patientId,
            planId: p.id,
            idgDecisionId: decision.decisionId,
            idgMeetingId: decision.meetingId,
            sourceOutboxEventId: event.id,
          });
          const auditContext: AuditContext = {
            organizationId,
            userId: null,
            actorKind: "system",
            correlationId: `idg-decision:${decision.decisionId}`,
          };

          if (!plan) {
            // A discharged plan is a permanent refusal (record it against the most recent plan of that
            // kind); no plan at all means M15's bootstrap has not run yet — transient, THROW so it retries.
            const [discharged] = await tx
              .select()
              .from(PLAN)
              .where(
                and(
                  eq(PLAN.organizationId, organizationId),
                  eq(PLAN.patientId, decision.patientId),
                  eq(PLAN.kind, decision.planKind),
                ),
              )
              .orderBy(sql`${PLAN.createdAt} desc`)
              .limit(1);
            if (!discharged) {
              return fail(
                `no ${decision.planKind} plan for patient '${decision.patientId}' (not bootstrapped yet)`,
              );
            }
            await tx.insert(APPLICATION).values({
              ...baseRow(discharged),
              status: "refused",
              refusalReason: "plan_discharged",
            });
            await audit(tx, auditContext, {
              eventType: "m15.idg_decision.refused",
              resourceKind: "discipline_care_plan",
              resourceId: discharged.id,
              outcome: "denied",
              context: { decisionId: decision.decisionId, reason: "plan_discharged" },
            });
            return;
          }

          const [openVersion] = await tx
            .select({ id: VERSION.id, status: VERSION.status })
            .from(VERSION)
            .where(
              and(eq(VERSION.planId, plan.id), inArray(VERSION.status, ["draft", "in_review"])),
            )
            .limit(1);
          if (openVersion?.status === "in_review") {
            // The snapshot is sealed (§2.3); applying now would edit a document awaiting signatures.
            return fail(
              `plan '${plan.id}' has a version in review; retry after it is signed/rejected`,
            );
          }

          const [goalRows, interventionRows] = await Promise.all([
            tx
              .select({ id: GOAL.id, status: GOAL.status, sudRelated: GOAL.sudRelated })
              .from(GOAL)
              .where(eq(GOAL.planId, plan.id)),
            tx
              .select({ id: INTERVENTION.id, status: INTERVENTION.status })
              .from(INTERVENTION)
              .where(eq(INTERVENTION.planId, plan.id)),
          ]);
          const facts: IdgApplyFacts = {
            planStatus: plan.status,
            openVersion: openVersion ? { id: openVersion.id, status: "draft" } : null,
            goals: new Map(
              goalRows.map((g) => [g.id, { status: g.status, sudRelated: g.sudRelated }]),
            ),
            interventions: new Map(interventionRows.map((i) => [i.id, { status: i.status }])),
            activeProblemIds,
          };

          const action = decideDisciplinePlanDecision(decision.mutations, facts);
          if (action.kind === "refuse") {
            await tx.insert(APPLICATION).values({
              ...baseRow(plan),
              status: "refused",
              refusalReason: action.reason,
            });
            await audit(tx, auditContext, {
              eventType: "m15.idg_decision.refused",
              resourceKind: "discipline_care_plan",
              resourceId: plan.id,
              outcome: "denied",
              context: { decisionId: decision.decisionId, reason: action.reason },
            });
            return;
          }

          // ── apply ──────────────────────────────────────────────────────────────────────────────────
          let versionId: string;
          if (action.openNewVersion) {
            const [{ maxSeq } = { maxSeq: 0 }] = await tx
              .select({ maxSeq: sql<number>`coalesce(max(${VERSION.sequence}), 0)::int` })
              .from(VERSION)
              .where(eq(VERSION.planId, plan.id));
            const [created] = await tx
              .insert(VERSION)
              .values({
                ...inherit(plan),
                planId: plan.id,
                sequence: Number(maxSeq) + 1,
                kind: "idg_review",
                status: "draft",
                idgMeetingId: decision.meetingId,
                requiredSignerSet: resolveRequiredSignerSet(plan.kind, "idg_review"),
              })
              .returning({ id: VERSION.id });
            if (!created) return fail("version insert returned no row");
            versionId = created.id;
            // §2.2.1 — an IDG decision opens the next version: active → draft_revising. The previously
            // signed version stays current until this one signs.
            if (plan.status === "active") {
              const next = transitionDisciplinePlan(plan.status, { type: "openNextVersion" });
              await tx
                .update(PLAN)
                .set({ status: next.to, updatedAt: new Date(), version: plan.version + 1 })
                .where(and(eq(PLAN.id, plan.id), eq(PLAN.version, plan.version)));
            }
          } else {
            versionId = openVersion?.id ?? fail("expected an open draft version");
          }

          const now = new Date();
          for (const m of action.mutations) {
            switch (m.op) {
              case "goal_add":
                await tx.insert(GOAL).values({
                  ...inherit(plan),
                  planId: plan.id,
                  parentProblemId: m.parentProblemId,
                  source: m.source,
                  originalText: m.originalText,
                  measurableOutcome: m.measurableOutcome,
                  addedByMembershipId: decision.recordedByMembershipId,
                  addedByDiscipline: IDG_AUTHORING_DISCIPLINE,
                });
                break;
              case "goal_update":
                await tx
                  .update(GOAL)
                  .set({
                    status: m.to,
                    ...(m.revisedText !== null ? { revisedText: m.revisedText } : {}),
                    updatedAt: now,
                    version: sql`${GOAL.version} + 1`,
                  })
                  .where(and(eq(GOAL.id, m.goalId), eq(GOAL.planId, plan.id)));
                break;
              case "intervention_add":
                await tx.insert(INTERVENTION).values({
                  ...inherit(plan),
                  planId: plan.id,
                  goalRefs: [...m.goalRefs],
                  scopeText: m.scopeText,
                  frequencyText: m.frequencyText,
                  frequencyValue: m.frequencyValue,
                  discipline: m.discipline,
                  addedByMembershipId: decision.recordedByMembershipId,
                  addedByDiscipline: IDG_AUTHORING_DISCIPLINE,
                });
                break;
              case "intervention_discontinue":
                await tx
                  .update(INTERVENTION)
                  .set({
                    status: "discontinued",
                    discontinuationReason: m.reason,
                    updatedAt: now,
                    version: sql`${INTERVENTION.version} + 1`,
                  })
                  .where(
                    and(eq(INTERVENTION.id, m.interventionId), eq(INTERVENTION.planId, plan.id)),
                  );
                break;
            }
          }

          await tx.insert(APPLICATION).values({
            id: randomUUID(),
            ...baseRow(plan),
            versionId,
            status: "applied",
            mutationsApplied: action.mutations.length,
          });
          await deps.outbox.publish(tx, {
            organizationId,
            eventName: "m15.idg_decision.applied",
            aggregateKind: "discipline_care_plan_version",
            aggregateId: versionId,
            payload: {
              planId: plan.id,
              versionId,
              idgDecisionId: decision.decisionId,
              mutationsApplied: action.mutations.length,
            },
          });
          await audit(tx, auditContext, {
            eventType: "m15.idg_decision.applied",
            resourceKind: "discipline_care_plan_version",
            resourceId: versionId,
            outcome: "success",
            context: {
              decisionId: decision.decisionId,
              meetingId: decision.meetingId,
              mutationCount: action.mutations.length,
            },
          });
        },
      );
    },
  };
}
