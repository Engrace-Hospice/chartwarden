// apps/backend/src/modules/16-bereavement/outbox-consumers/m6-admission-discharged-death.ts —
// the §4.5 "secondary verifier (redundant safety net)" on `m6.admission.discharged` (F-134/#248).
//
// M16's §4.5 outbox-subscriptions table names this event explicitly, and not as a second creation path:
// the ONLY path by which a `bereavement_plan` row can exist is `m6.bereavement.eligible`
// (../outbox-consumers/m6-bereavement-eligible.ts, F-105) — the post-rule check M6 runs on its own
// `discharge.death` transition. This consumer exists for the case that rule FAILS to fire (a defect in
// M6's own eligibility check, or a delivery of `bereavement.eligible` that never lands) and a death
// discharge still needs to open the program: it filters `reason === 'death'` and runs the exact same
// §4.3.1 intake decider a second time, off a DIFFERENT source event.
//
// This is deliberately NOT a second decider. `decideEligibilityIntake` is idempotent on `existingPlan`
// (the D1 `berv_plan_unique_admission` backstop), and neither `payload.patientId` nor `payload.eligibleAt`
// is read by its decision logic — only `payload.admissionId` is, plus the facts resolved through M6's own
// seams (`resolveDeathFact`, keyed on `admissionId` and windowed around the instant the caller supplies).
// So running the identical decider off `m6.admission.discharged`'s `{admissionId, dischargeDate}` payload,
// with `eligibleAt` reconstructed from `dischargeDate`, produces the exact same `open_plan`/`idempotent_skip`
// verdict `m6.bereavement.eligible`'s own consumer would — and when the primary path already ran, this
// consumer's `existingPlan` check makes it a true no-op, never a second plan or a second `plan_opened`-
// adjacent emission (opening a plan emits nothing itself — see the primary consumer's header).
//
// WHY `eligibleAt` IS RECONSTRUCTED RATHER THAN LEFT UNRESOLVED. `resolveDeathFact` needs an instant to
// window `DeathDischargeReader.listDeathDischargesInPeriod` around (180 days back, 1ms forward — see
// death-discharge.ts's `INCLUSIVE_BOUND_EPSILON_MS` note on why the window's upper bound must be
// INCLUSIVE). `discharge_event.death_at` is set from `dischargeDate` in the same statement that emits
// THIS event (F-105's `deathCalendarDate` header explains M6 never models a time of death — every value
// is midnight UTC of the date entered), so `new Date(dischargeDate).toISOString()` reconstructs the exact
// instant the primary path's `eligibleAt` carries on M6's real emit path, not an approximation.
//
// NON-DEATH DISCHARGES ARE A NO-OP BEFORE ANY SEAM READ. `reason !== 'death'` returns immediately — this
// consumer never asks M6's death census about a discharge that was not one.
import { type DbClient, organizationTimezone, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { AdmissionId } from "@wardenx/types";
import { and, eq } from "drizzle-orm";
import {
  type AdmissionAnchorResolver,
  decideEligibilityIntake,
  resolveDeathFact,
} from "../consumers/index";
import type { WriteOutboxPort } from "../routes/write-service";

const PLAN = schema.bereavementPlan;

/** §3.3 — a consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

export const M16_DISCHARGE_DEATH_SECONDARY_CONSUMER = {
  eventName: "m6.admission.discharged",
  consumerName: "m16.m6-admission-discharged-death-secondary",
} as const;

export interface DischargeDeathSecondaryDeps {
  readonly db: DbClient;
  /** The bound publisher — `Value.Check`s `m16.*` against the boot catalog. */
  readonly outbox: WriteOutboxPort;
  /** Same org-explicit admission-siting port the primary intake consumer uses — see
   *  ../consumers/death-discharge.ts for why the request-scoped §4.7 seam cannot be used here. */
  readonly resolveAdmission: AdmissionAnchorResolver;
}

function factsOf(payload: unknown): { admissionId: AdmissionId; reason: string; dischargeDate: string } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const read = (key: string): string => {
    const value = p[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `${M16_DISCHARGE_DEATH_SECONDARY_CONSUMER.consumerName}: payload has no ${key}`,
      );
    }
    return value;
  };
  return {
    admissionId: read("admissionId") as AdmissionId,
    reason: read("reason"),
    dischargeDate: read("dischargeDate"),
  };
}

/**
 * M16's live `m6.admission.discharged` binding — the §4.5 secondary verifier for a death discharge.
 *
 * A non-death discharge is a no-op with no seam read at all. A death discharge re-runs the identical
 * §4.3.1 decider `m6.bereavement.eligible`'s own consumer runs, so a delivery that lands AFTER the primary
 * path already opened the plan is a true no-op (`existingPlan` true → `idempotent_skip`), and a delivery
 * that lands when the primary path never fired opens the plan exactly as it would have.
 */
export function buildM16DischargeDeathSecondaryConsumer(deps: DischargeDeathSecondaryDeps) {
  return {
    consumerName: M16_DISCHARGE_DEATH_SECONDARY_CONSUMER.consumerName,
    consumerModule: "m16" as const,
    eventTypes: [M16_DISCHARGE_DEATH_SECONDARY_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      if (facts.reason !== "death") return;

      const organizationId = event.organizationId;
      const eligibleAt = new Date(facts.dischargeDate).toISOString();

      const timezone = await organizationTimezone(deps.db, organizationId);

      const existingPlan = await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          const rows = await tx
            .select({ id: PLAN.id })
            .from(PLAN)
            .where(
              and(eq(PLAN.organizationId, organizationId), eq(PLAN.admissionId, facts.admissionId)),
            )
            .limit(1);
          return rows.length > 0;
        },
      );

      const deathFact = existingPlan
        ? null
        : await resolveDeathFact(
            organizationId,
            facts.admissionId,
            eligibleAt as never,
            timezone,
            deps.resolveAdmission,
          );

      // Throws DEATH_FACT_UNRESOLVED / BEREAVEMENT_DEATH_DATE_MISMATCH when the primary path never fired
      // AND M6's own death census has no matching row either — both dead-letter for a human rather than
      // opening a 13-month program on a guessed anchor. A real, upstream-fired death always resolves here,
      // since this consumer reads the SAME `DeathDischargeReader` window the primary intake does.
      const action = decideEligibilityIntake(
        {
          admissionId: facts.admissionId,
          // Neither field is read by the decider's own logic (only `deathFact.patientId` is, on the
          // `open_plan` branch) — see this file's header. Present for type shape only.
          patientId: (deathFact?.patientId ?? facts.admissionId) as never,
          eligibleAt: eligibleAt as never,
        },
        { existingPlan, deathFact, patientOptOut: null },
      );

      if (action.kind === "idempotent_skip") return;

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;

          if (action.kind === "skip_per_patient_opt_out") {
            await deps.outbox.publish(tx, {
              organizationId,
              eventName: "m16.bereavement.plan_skipped_per_patient_opt_out",
              aggregateKind: "admission",
              aggregateId: facts.admissionId,
              payload: {
                patientId: deathFact?.patientId ?? "",
                admissionId: facts.admissionId,
                deathDate: action.deathDate ?? "",
              },
            });
            return;
          }

          await tx
            .insert(PLAN)
            .values({
              organizationId,
              patientId: action.patientId,
              admissionId: action.admissionId,
              providerEntityId: action.providerEntityId,
              locationId: deathFact?.locationId ?? null,
              status: "eligible",
              deathDate: action.deathDate,
              deathTime: new Date(action.deathAt),
              externalSourceMetadata: action.externalSourceMetadata,
            })
            .onConflictDoNothing();
        },
      );
    },
  };
}
