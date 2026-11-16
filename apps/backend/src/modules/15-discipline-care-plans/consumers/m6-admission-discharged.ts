import { type AuditContext, audit } from "@chartwarden/audit";
import { type DbClient, schema } from "@chartwarden/db";
// apps/backend/src/modules/15-discipline-care-plans/consumers/m6-admission-discharged.ts — M15's live
// `m6.admission.discharged` binding: the §7.11 discharge transition (`m15.discharge.apply`, idempotency
// key `(planId + admissionId + 'discharge')`).
//
// ── WHAT WAS MISSING ─────────────────────────────────────────────────────────────────────────────────
//
// `transitionDisciplinePlan`'s `discharge` event (§2.2.1) had a definition, a doc comment and unit tests,
// and NOTHING dispatched it: m15 was not in `m6.admission.discharged`'s `declaredConsumers`, so no plan was
// ever set to `discharged`, no `discharge` version was ever sealed, `m15.plan.discharged` was never produced,
// the M15 crons (which filter `status <> 'discharged'`) kept alerting for patients who had left care, and a
// readmission left two non-discharged plans of one kind for the same patient.
//
// ── WHAT IT DOES (one transaction per delivery, under the tenant's RLS, system actor) ────────────────
//
// For EVERY non-discharged plan of the admission (the §7.11 "each of the four plans" — `volunteer_plan`
// only if it was ever created):
//   1. the signed version(s) → `superseded` (the chain ends in exactly one signed version);
//   2. a `discharge`-kind version is inserted ALREADY `signed` by the system actor: it carries the final
//      goal/intervention snapshot and the EMPTY D11 quorum for that kind (no human signer, so no
//      `discipline_care_plan_signature` row). It is inserted directly as `signed` rather than walked through
//      draft/in_review because an open (draft/in_review) version is RETAINED on the record untouched and
//      `discipline_care_plan_version_plan_open_uq` allows only one such row per plan;
//   3. the plan root → `discharged` (+ `discharged_at`), through the §2.2.1 machine;
//   4. `m15.plan.discharged` through the catalog-validating publisher, and an audit row.
//
// An open draft is retained but no longer writable: `checkPlanWritable` refuses every write on a
// `discharged` plan.
//
// ── IDEMPOTENCY ──────────────────────────────────────────────────────────────────────────────────────
//
// The dispatcher's `(eventId, consumerName)` receipt, and structurally: the decider skips plans that are
// already `discharged`, and the rows are locked `FOR UPDATE`, so a redelivery (or a concurrent one) finds
// nothing left to do and emits nothing — `m15.plan.discharged` is announced exactly once per plan.
//
// An admission with no plans at all is a handled no-op, not a throw: a patient with no discipline plans
// (e.g. admitted before M15's bootstrap existed) has nothing to seal.
import { CONSUMER_USER_ID } from "@chartwarden/shared/route-kit";
import { withOrgContext } from "@chartwarden/tenancy";
import type { DisciplinePlanKind, IsoInstant } from "@chartwarden/types";
import { and, eq, sql } from "drizzle-orm";
import {
  type DisciplinePlanDischargeReason,
  type DisciplinePlanLifecycleState,
  type DisciplinePlanTransition,
  transitionDisciplinePlan,
} from "../lifecycle/plan";
import { resolveRequiredSignerSet } from "../lifecycle/required-signer-set";
import { redactDisciplineSnapshot } from "../routes/snapshot-redaction";
import type { WriteOutboxPort } from "../routes/write-service";

const PLAN = schema.disciplineCarePlan;
const VERSION = schema.disciplineCarePlanVersion;
const GOAL = schema.disciplineGoal;
const INTERVENTION = schema.disciplineIntervention;

/** The event M15 discharges from, and the `(eventId, consumerName)` receipt identity. */
export const M15_PLAN_DISCHARGE_CONSUMER = {
  eventName: "m6.admission.discharged",
  consumerName: "m15.m6-admission-discharged",
} as const;

/** M6's `reason` is never free text (the narrative lives on the discharge row, not the event): it is the
 *  §4.2.7 `DischargeReason` (`death`, `moved_out_of_service_area`, `no_longer_terminal`, `for_cause`, `other`),
 *  or `revocation` / `transfer` for those two endings (`ev.reason ?? ev.dischargeType`, proved per reason by
 *  `m6-discharge-reason-matrix.live`). M15 only distinguishes the three admission-end causes it names (§7.11)
 *  and treats everything else as `discharge`. */
const NAMED_REASONS: readonly DisciplinePlanDischargeReason[] = ["death", "revocation", "transfer"];

export function dischargeReasonOf(reason: string): DisciplinePlanDischargeReason {
  return NAMED_REASONS.find((r) => r === reason) ?? "discharge";
}

/** The `m6.admission.discharged` facts M15 reads (M6 owns the wire shape). */
export interface AdmissionDischargedFacts {
  readonly admissionId: string;
  readonly reason: DisciplinePlanDischargeReason;
  readonly dischargedAt: Date;
}

export function parseAdmissionDischarged(payload: unknown): AdmissionDischargedFacts {
  const fail = (message: string): never => {
    throw new Error(`${M15_PLAN_DISCHARGE_CONSUMER.consumerName}: ${message}`);
  };
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return fail("payload must be an object");
  }
  const p = payload as Record<string, unknown>;
  const read = (key: string): string => {
    const value = p[key];
    return typeof value === "string" && value.length > 0 ? value : fail(`payload has no ${key}`);
  };
  const dischargedAt = new Date(read("dischargeDate"));
  if (Number.isNaN(dischargedAt.getTime())) return fail("dischargeDate is not a valid date");
  return {
    admissionId: read("admissionId"),
    reason: dischargeReasonOf(read("reason")),
    dischargedAt,
  };
}

/** What the decider needs of a plan row. */
export interface DischargeablePlan {
  readonly id: string;
  readonly kind: DisciplinePlanKind;
  readonly status: DisciplinePlanLifecycleState;
}

export interface PlanDischargeStep {
  readonly planId: string;
  readonly kind: DisciplinePlanKind;
  readonly transition: DisciplinePlanTransition;
}

/**
 * The pure §7.11 decision: one `discharge` step per plan that is not already `discharged`, through the
 * §2.2.1 machine (legal from `draft` too — a spiritual plan the patient declined never left `draft`).
 * A plan that is already `discharged` is skipped, which is what makes a replay a no-op.
 */
export function decideAdmissionDischarge(
  plans: readonly DischargeablePlan[],
  reason: DisciplinePlanDischargeReason,
  at: Date,
): readonly PlanDischargeStep[] {
  return plans
    .filter((p) => p.status !== "discharged")
    .map((p) => ({
      planId: p.id,
      kind: p.kind,
      transition: transitionDisciplinePlan(p.status, {
        type: "discharge",
        reason,
        at: at.toISOString() as IsoInstant,
      }),
    }));
}

export interface DisciplinePlanDischargeDeps {
  readonly db: DbClient;
  /** The catalog-validating publisher pinned to callerModule `m15`; rolls the tx back on a mismatch, so a
   *  plan can never be discharged without its announcement. */
  readonly outbox: WriteOutboxPort;
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** The sealed-snapshot projection of a goal row — the same shape `finalizeVersion` seals. */
const snapshotGoal = (r: typeof GOAL.$inferSelect) => ({
  goalId: r.id,
  parentProblemId: r.parentProblemId ?? null,
  parentGoalId: r.parentGoalId ?? null,
  source: r.source,
  status: r.status,
  originalText: r.originalText,
  revisedText: r.revisedText ?? null,
  measurableOutcome: r.measurableOutcome ?? null,
  targetAt: iso(r.targetAt),
  frequencyText: r.frequencyText ?? null,
  frequencyValue: r.frequencyValue ?? null,
  modalityText: r.modalityText ?? null,
  sudRelated: r.sudRelated,
  addedByDiscipline: r.addedByDiscipline,
  addedAt: iso(r.addedAt),
  version: r.version,
});

const snapshotIntervention = (r: typeof INTERVENTION.$inferSelect) => ({
  interventionId: r.id,
  parentInterventionId: r.parentInterventionId ?? null,
  goalRefs: strings(r.goalRefs),
  scopeText: r.scopeText,
  frequencyText: r.frequencyText,
  frequencyValue: r.frequencyValue,
  discipline: r.discipline,
  responsibleRoles: strings(r.responsibleRoles),
  status: r.status,
  discontinuationReason: r.discontinuationReason ?? null,
  addedByDiscipline: r.addedByDiscipline,
  addedAt: iso(r.addedAt),
  version: r.version,
});

/** M15's live `m6.admission.discharged` binding. */
export function buildM15AdmissionDischargedConsumer(deps: DisciplinePlanDischargeDeps) {
  return {
    consumerName: M15_PLAN_DISCHARGE_CONSUMER.consumerName,
    consumerModule: "m15" as const,
    eventTypes: [M15_PLAN_DISCHARGE_CONSUMER.eventName] as const,
    async handle(event: {
      /** The outbox row id (the relay passes it); recorded on the audit trail to trace back to M6's event. */
      readonly id?: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const organizationId = event.organizationId;
      const facts = parseAdmissionDischarged(event.payload);

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          // Every plan of the admission, locked so a concurrent delivery serializes behind this one and
          // then finds them discharged.
          const plans = await tx
            .select()
            .from(PLAN)
            .where(
              and(eq(PLAN.organizationId, organizationId), eq(PLAN.admissionId, facts.admissionId)),
            )
            .for("update");
          const steps = decideAdmissionDischarge(plans, facts.reason, facts.dischargedAt);
          if (steps.length === 0) return; // replay, or an admission with no discipline plans

          const auditContext: AuditContext = {
            organizationId,
            userId: null,
            actorKind: "system",
            correlationId: `admission-discharged:${facts.admissionId}`,
          };
          const sealedAt = new Date();

          for (const step of steps) {
            const plan = plans.find((p) => p.id === step.planId);
            if (!plan) throw new Error(`plan ${step.planId} vanished under lock`);

            // 1. the chain ends in exactly one signed version.
            await tx
              .update(VERSION)
              .set({
                status: "superseded",
                supersededAt: sealedAt,
                updatedAt: sealedAt,
                version: sql`${VERSION.version} + 1`,
              })
              .where(and(eq(VERSION.planId, plan.id), eq(VERSION.status, "signed")));

            // 2. the system-signed `discharge` version over the FINAL goal/intervention state.
            const [goals, interventions, [{ maxSeq } = { maxSeq: 0 }]] = await Promise.all([
              tx.select().from(GOAL).where(eq(GOAL.planId, plan.id)),
              tx.select().from(INTERVENTION).where(eq(INTERVENTION.planId, plan.id)),
              tx
                .select({ maxSeq: sql<number>`coalesce(max(${VERSION.sequence}), 0)::int` })
                .from(VERSION)
                .where(eq(VERSION.planId, plan.id)),
            ]);
            const dischargeSnapshot = {
              sealedAt: sealedAt.toISOString(),
              planKind: step.kind,
              versionKind: "discharge",
              systemSigned: true,
              dischargeReason: facts.reason,
              goals: goals.map(snapshotGoal),
              interventions: interventions.map(snapshotIntervention),
            };
            const [created] = await tx
              .insert(VERSION)
              .values({
                organizationId,
                providerEntityId: plan.providerEntityId,
                locationId: plan.locationId,
                planId: plan.id,
                sequence: Number(maxSeq) + 1,
                kind: "discharge",
                status: "signed",
                requiredSignerSet: resolveRequiredSignerSet(step.kind, "discharge"),
                stateSnapshot: dischargeSnapshot,
                finalizedAt: sealedAt,
                signedAt: sealedAt,
              })
              .returning({ id: VERSION.id });
            if (!created)
              throw new Error(`discharge version insert returned no row for ${plan.id}`);

            // 3. the plan root, through the §2.2.1 machine. The row lock makes the version guard a backstop.
            const updated = await tx
              .update(PLAN)
              .set({
                status: step.transition.to,
                dischargedAt: facts.dischargedAt,
                updatedAt: sealedAt,
                version: plan.version + 1,
              })
              .where(and(eq(PLAN.id, plan.id), eq(PLAN.version, plan.version)))
              .returning({ id: PLAN.id });
            if (updated.length === 0) {
              throw new Error(`plan ${plan.id} changed concurrently during discharge`);
            }

            // 4. announce + audit, same transaction. First the discharge version itself: it is signed (by the
            // system) like any other, so M22 renders the plan's FINAL PDF from this event (audit D-6). Its
            // snapshot is the Part 2-redacted one (audit D-13): no viewer decides who reads a rendered PDF.
            // A plan that never had a goal or an intervention (a spiritual plan the family declined, a draft that
            // was never used) has nothing to render: no blank PDF, only the discharge announcement below.
            if (goals.length + interventions.length > 0)
              await deps.outbox.publish(tx, {
                organizationId,
                eventName: "m15.plan.version_signed",
                aggregateKind: "discipline_care_plan_version",
                aggregateId: created.id,
                payload: {
                  planId: plan.id,
                  versionId: created.id,
                  patientId: plan.patientId,
                  kind: step.kind,
                  versionKind: "discharge",
                  snapshot: redactDisciplineSnapshot(dischargeSnapshot, false),
                  signers: [],
                },
              });
            await deps.outbox.publish(tx, {
              organizationId,
              eventName: "m15.plan.discharged",
              aggregateKind: "discipline_care_plan",
              aggregateId: plan.id,
              payload: {
                planId: plan.id,
                admissionId: facts.admissionId,
                kind: step.kind,
                finalSnapshotVersionId: created.id,
              },
            });
            await audit(tx, auditContext, {
              eventType: "m15.plan.discharged",
              resourceKind: "discipline_care_plan",
              resourceId: plan.id,
              outcome: "success",
              context: {
                admissionId: facts.admissionId,
                reason: facts.reason,
                finalSnapshotVersionId: created.id,
                ...(event.id === undefined ? {} : { sourceEventId: event.id }),
              },
            });
          }
        },
      );
    },
  };
}
