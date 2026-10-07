// apps/backend/src/modules/16-bereavement/outbox-consumers/m5-patient-opt-out-changed.ts — the §2.6 / D9
// M5 per-patient bereavement opt-out flip, live for the first time (F-159, #248).
//
// `decidePatientOptOutFlip` (`../lifecycle/cascades.ts`) has been a complete, pure, unit-tested decider
// since M16-T03 with no live binding anywhere — the `m5.patient.bereavement_opt_out_changed` → m16 pair
// sat in `scripts/outbox-deferred-consumers.ts`'s `handlers-unbound` group. Its own doc comment states the
// three live outcomes: `no_plan` (M6's own eligibility rule already suppresses `m6.bereavement.eligible`,
// nothing to do), `skip` (the plan is `eligible`/`initiating` — fire `skipPerPatientOptOut`, a cosign-EXEMPT
// completed close, no M36 channel was ever opened), and `close_early` (the plan is `active`/`paused` — fire
// the cosign-EXEMPT `closeEarly(patient_opt_out_post_creation)`, §2.6: honoring a directive the patient
// already gave is not a clinical judgment call, unlike the five D7 reasons that DO need a supervisor
// cosign). `already_closed` and a `false` flag are both no-ops per the decider's own contract.
//
// F-153's prior finding on this pair — "the `skip` branch has no route case to mirror at all and the
// `close_early` branch needs `cancelFutureOutreach`/`closeoutStats`, both private, unexported closures" —
// is checked here, not re-asserted. The characterization is factually accurate (neither function is
// exported from `write-service-drizzle.ts`, and no HTTP route calls `skipPerPatientOptOut` from an
// EXISTING plan — only M16's own intake decider calls it, before any plan row exists) but does not, on
// inspection, block a build: both closures are small, self-contained SQL over M16's own tables (a
// `scheduled`-outreach cancel-and-mark-cancelled UPDATE; two `count(*) FILTER` SELECTs), with no seam call,
// no membership requirement and no business judgment beyond what the pure decider already made. This file
// reimplements both locally (`cancelFutureOutreach`/`closeoutStats` below) rather than importing the
// private closures — the `m39-consent-revoked.ts` precedent, which already reimplements the same
// future-outreach cancellation inline for the identical reason.
//
// `bereavement_plan_closure.closed_by_user_id` is nullable with its own documented system-write precedent
// ("NULL for the 13-month auto-close cron (M2 membership otherwise)") — this consumer is the SECOND
// documented system writer, alongside that cron. `cosigned_by_user_id`/`cosigned_at` stay null and
// `reason_narrative_redacted` stays null for both `patient_opt_out_pre_death` and
// `patient_opt_out_post_creation`: neither reason is in `COSIGN_REQUIRED_CLOSURE_REASONS`
// (`@wardenx/bereavement`), so the §3.3.7 CHECK constraints requiring a cosign + a ≥40-char narrative on
// the five D7 reasons do not apply — matching `decidePatientOptOutFlip`'s own doc comment ("D7 does not
// apply: this is honoring a directive the patient already gave, not a clinical judgment call").
//
// A PATIENT MAY HAVE MORE THAN ONE `bereavement_plan` ROW, structurally: `berv_plan_unique_admission` is
// unique on (organization_id, admission_id), not patient_id, so this handler resolves every plan for the
// (org, patientId) pair and applies the decider per-plan rather than assuming exactly one — almost every
// deployment has zero or one, and any plan the flag does not apply to (already closed, or none at all)
// falls out of `decidePatientOptOutFlip` as a documented no-op with no seam read or write.
//
// NO CATALOG EDIT NEEDED: `m5.patient.bereavement_opt_out_changed` already declares
// `declaredConsumers: ["m16"]` (`apps/backend/src/modules/05-patient/events-by-m5.ts`), and both outbox
// events this handler emits (`m16.bereavement.plan_skipped_per_patient_opt_out`,
// `m16.bereavement.plan_closed_early`) are established M16-owned catalog entries — the `plan_closed_early`
// entry's own description already anticipates this exact call site: "`cosignedByUserId` is null ONLY on
// the D9 patient-opt-out-post-creation cascade, which §2.6 makes cosign-exempt."
//
// IDEMPOTENT BY CONSTRUCTION: `decidePatientOptOutFlip` reads `plan.status` fresh on every delivery and
// answers `already_closed` for any of the four closed/legal-hold states, so a redelivery after the first
// delivery already closed the plan is a silent no-op — no separate uniqueness guard is needed beyond
// `berv_closure_unique_plan` (a structural backstop, never expected to fire here).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { BereavementPlanClosureReason, IsoInstant, MembershipId } from "@wardenx/types";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { decidePatientOptOutFlip } from "../lifecycle/cascades";
import type { BereavementSideEffect } from "../lifecycle/effects";
import { transitionBereavementPlan } from "../lifecycle/index";
import { type EffectContext, runEffects } from "../routes/effects-runner";
import type { WriteOutboxPort } from "../routes/write-service";

const PLAN = schema.bereavementPlan;
const CLOSURE = schema.bereavementPlanClosure;
const OUTREACH = schema.bereavementOutreach;
const CONTACT = schema.bereavedContact;
const COP_CREDIT = schema.bereavementCopOptOutCredit;

/** §3.3 — a consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

export const M16_PATIENT_OPT_OUT_CHANGED_CONSUMER = {
  eventName: "m5.patient.bereavement_opt_out_changed",
  consumerName: "m16.m5-patient-opt-out-changed",
} as const;

export interface PatientOptOutChangedDeps {
  readonly db: DbClient;
  /** The bound publisher — `Value.Check`s `m16.*` against the boot catalog. */
  readonly outbox: WriteOutboxPort;
}

function factsOf(payload: unknown): { patientId: string; optedOut: boolean } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const patientId = p.patientId;
  const optedOut = p.optedOut;
  if (typeof patientId !== "string" || patientId.length === 0) {
    throw new Error(
      `${M16_PATIENT_OPT_OUT_CHANGED_CONSUMER.consumerName}: payload has no patientId`,
    );
  }
  if (typeof optedOut !== "boolean") {
    throw new Error(
      `${M16_PATIENT_OPT_OUT_CHANGED_CONSUMER.consumerName}: payload has no optedOut flag`,
    );
  }
  return { patientId, optedOut };
}

/**
 * M16's live `m5.patient.bereavement_opt_out_changed` binding — the §2.6 / D9 patient-level directive
 * cascade. `optedOut === false` is a no-op on every plan (the flag going back to `false` never re-opens a
 * closed program — re-enrolment needs a counselor and fresh M39 consent, per the decider's own doc).
 */
export function buildM16PatientOptOutChangedConsumer(deps: PatientOptOutChangedDeps) {
  return {
    consumerName: M16_PATIENT_OPT_OUT_CHANGED_CONSUMER.consumerName,
    consumerModule: "m16" as const,
    eventTypes: [M16_PATIENT_OPT_OUT_CHANGED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly id: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      if (!facts.optedOut) return;

      const organizationId = event.organizationId;

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;

          const plans = await tx
            .select()
            .from(PLAN)
            .where(
              and(eq(PLAN.organizationId, organizationId), eq(PLAN.patientId, facts.patientId)),
            );

          for (const plan of plans) {
            const action = decidePatientOptOutFlip(plan.status, facts.optedOut);
            if (action.kind === "no_plan" || action.kind === "already_closed") continue;

            const at = new Date().toISOString() as IsoInstant;

            if (action.kind === "skip") {
              const transition = transitionBereavementPlan(plan.status, {
                type: "skipPerPatientOptOut",
                at,
              });
              await closePlan(tx, deps.outbox, plan, transition.to, transition.effects, at, {
                reason: "patient_opt_out_pre_death",
                closeKind: "cascade",
                cosignedByUserId: null,
                outboxPayload: {
                  "m16.bereavement.plan_skipped_per_patient_opt_out": {
                    patientId: plan.patientId,
                    admissionId: plan.admissionId,
                    deathDate: plan.deathDate,
                  },
                },
                cancelOutreach: false,
              });
              // F-206 (#248) — the user's own decision: a pre-death patient opt-out counts as CoP 418.64(d)
              // coverage SATISFIED, not silently absent from `copOutreachCounts`'s denominator. Idempotent
              // via the (organizationId, sourceEventId) unique index — a redelivery of this same outbox
              // event inserts nothing a second time.
              await tx
                .insert(COP_CREDIT)
                .values({
                  organizationId: plan.organizationId,
                  providerEntityId: plan.providerEntityId,
                  locationId: plan.locationId,
                  patientId: plan.patientId,
                  admissionId: plan.admissionId,
                  deathDate: plan.deathDate,
                  sourceEventId: event.id,
                })
                .onConflictDoNothing();
              continue;
            }

            // action.kind === "close_early"
            const transition = transitionBereavementPlan(plan.status, {
              type: "closeEarly",
              reason: "patient_opt_out_post_creation" as BereavementPlanClosureReason,
              narrative: "",
              at,
              cosignedByUserId: null as MembershipId | null,
              legalHoldActive: plan.legalHoldId !== null,
            });
            await closePlan(tx, deps.outbox, plan, transition.to, transition.effects, at, {
              reason: "patient_opt_out_post_creation",
              closeKind: "cascade",
              cosignedByUserId: null,
              outboxPayload: {
                "m16.bereavement.plan_closed_early": {
                  planId: plan.id,
                  reason: "patient_opt_out_post_creation",
                  closedAt: at,
                  cosignedByUserId: null,
                },
              },
              cancelOutreach: true,
            });
          }
        },
      );
    },
  };
}

// ── shared close-and-record-closure helper (skip and close_early share everything but the reason /
//    cancel-outreach behavior — skip fires before any outreach was ever scheduled, per §2.2) ────────────

type PlanRow = typeof PLAN.$inferSelect;

interface CloseOptions {
  readonly reason: BereavementPlanClosureReason;
  readonly closeKind: "cascade";
  readonly cosignedByUserId: null;
  readonly outboxPayload: Record<string, Record<string, unknown>>;
  readonly cancelOutreach: boolean;
}

async function closePlan(
  tx: DbClient,
  outbox: WriteOutboxPort,
  plan: PlanRow,
  toStatus: PlanRow["status"],
  effects: ReadonlyArray<BereavementSideEffect>,
  at: string,
  opts: CloseOptions,
): Promise<void> {
  const effectCtx: EffectContext = {
    organizationId: plan.organizationId,
    at: new Date(at),
    outbox,
    aggregateKind: "bereavement_plan",
    aggregateId: plan.id,
    payloads: opts.outboxPayload,
  };
  // F-159 — `runEffects` returns the accumulated column patch (e.g. `skipPerPatientOptOut`'s `opened_at`
  // stamp); it must be applied to the final UPDATE below, not discarded.
  const patch = await runEffects(tx, effects, effectCtx);

  if (opts.cancelOutreach) {
    await cancelFutureOutreach(tx, plan.id, at, "patient opt-out (D9)");
  }

  const stats = await closeoutStats(tx, plan.id);

  await tx.insert(CLOSURE).values({
    organizationId: plan.organizationId,
    providerEntityId: plan.providerEntityId,
    locationId: plan.locationId,
    planId: plan.id,
    reason: opts.reason,
    reasonNarrativeRedacted: null,
    closedAt: new Date(at),
    closedByUserId: null,
    closeKind: opts.closeKind,
    cosignedByUserId: opts.cosignedByUserId,
    cosignedAt: null,
    ...stats,
  });

  await tx
    .update(PLAN)
    .set({
      status: toStatus,
      closedAt: patch.closedAt ?? new Date(at),
      ...(patch.openedAt ? { openedAt: patch.openedAt } : {}),
      version: plan.version + 1,
      updatedAt: new Date(at),
    })
    .where(eq(PLAN.id, plan.id));
}

/** Local reimplementation of `write-service-drizzle.ts`'s private `cancelFutureOutreach` (plan scope only —
 *  this handler never needs the per-contact overload). */
async function cancelFutureOutreach(
  tx: DbClient,
  planId: string,
  at: string,
  reason: string,
): Promise<void> {
  const rows = await tx
    .select({ id: OUTREACH.id })
    .from(OUTREACH)
    .where(
      and(
        eq(OUTREACH.planId, planId),
        eq(OUTREACH.status, "scheduled"),
        gte(OUTREACH.dueAt, new Date(at)),
      ),
    );
  if (rows.length === 0) return;
  await tx
    .update(OUTREACH)
    .set({
      status: "cancelled",
      cancelledAt: new Date(at),
      cancellationReasonRedacted: reason,
      version: sql`${OUTREACH.version} + 1`, // §2.5 (GAP-194)
      updatedAt: new Date(at),
    })
    .where(
      inArray(
        OUTREACH.id,
        rows.map((r) => r.id),
      ),
    );
}

/** Local reimplementation of `write-service-drizzle.ts`'s private `closeoutStats` — the §7.11 closeout
 *  counts frozen onto the closure row. */
async function closeoutStats(tx: DbClient, planId: string) {
  const [outreach] = await tx
    .select({
      completed: sqlCount(OUTREACH.status, ["completed", "declined"]),
      missed: sqlCount(OUTREACH.status, ["missed"]),
    })
    .from(OUTREACH)
    .where(eq(OUTREACH.planId, planId));
  const [contacts] = await tx
    .select({
      active: sqlCount(CONTACT.status, ["active"]),
      optedOut: sqlCount(CONTACT.status, ["opted_out"]),
    })
    .from(CONTACT)
    .where(eq(CONTACT.planId, planId));
  return {
    outreachCompletedCount: outreach?.completed ?? 0,
    outreachMissedCount: outreach?.missed ?? 0,
    contactsActiveCount: contacts?.active ?? 0,
    contactsOptedOutCount: contacts?.optedOut ?? 0,
  };
}

// Small local `count(*) filter (where col in (...))` builder — the same `sql` template drizzle-orm's own
// callers use platform-wide for this shape.
function sqlCount(column: AnyPgColumn, values: readonly string[]) {
  return sql<number>`count(*) filter (where ${column} in (${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}))::int`;
}
