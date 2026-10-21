// apps/backend/src/modules/16-bereavement/outbox-consumers/m6-bereavement-eligible.ts — the §4.3.1
// bereavement intake, and the ONLY path by which a `bereavement_plan` row has ever been able to exist
// (F-105 / #103).
//
// ── WHAT WAS MISSING ─────────────────────────────────────────────────────────────────────────────────
//
// `decideEligibilityIntake` (../consumers/m6-eligibility.ts) is M16's complete §4.3.1 intake decider, and
// its own header says "the live outbox binding + the transactional insert land with the §4.9 workers in
// M16-T06". They did not. There was no `OutboxConsumerBinding` for `m6.bereavement.eligible` anywhere, and
// — one layer below that — there was NO INSERT INTO `bereavement_plan` ANYWHERE IN THE REPOSITORY. Not in
// the write service, not in a seed, not in a test. Nor is there a route that creates one: `POST
// /api/v1/bereavement/plans` does not exist (the collection path is a GET worklist), and all fifteen plan
// write routes are `/plans/:planId/…`. That is the design — this consumer is the only creation path — and
// it was absent.
//
// So no bereavement plan has ever existed in any deployment. CoP 418.64(d) requires a hospice to provide
// bereavement services to the decedent's family for THIRTEEN MONTHS after the death, and `bereavement_plan`
// is the root that carries that single clock. Every child hangs off `plan_id`: the bereaved-contact roster,
// the D4 outreach schedule, the anniversary reminders, the risk scores, the closure record. All of them
// were unreachable, and M30's `bereavement_coverage_rate` measure — bound, and computing — has been
// reading an empty table. The M15 `discipline_care_plan` and M20 `safety_check_in_schedule` lesson a third
// time: an empty compliance surface and a compliant one are indistinguishable.
//
// M6's side was never the problem. `m6.bereavement.eligible` is catalogued, is emitted from the death-
// discharge transition, and declares exactly one consumer — `m16`. So every emission has sat `pending`
// since M6 landed: routed to a module with no binding, the relay marks the event deferred, finalizes the
// row `pending` with `attemptCount - 1`, and re-claims it every thirty minutes for the life of the
// deployment. It never dead-letters and the retention purge never collects it.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────────────────────────────────
//
// It creates the plan `eligible` and emits NOTHING on that branch. `m16.bereavement.plan_opened` is not
// the creation event — ../lifecycle/plan.ts says so in as many words ("the signal is `plan_opened`, which
// fires at `active` — announcing an `eligible` row would…"): it fires from `seedRosterAndSchedule`, once a
// counselor is assigned and the roster and 13-month schedule exist, and its payload REQUIRES
// `assignedCounselorUserId` and `archivesAt`, neither of which exists yet here. Emitting it at intake would
// tell M22 to render a welcome packet for a family with no counselor and no schedule.
//
// The opt-out branch DOES emit `m16.bereavement.plan_skipped_per_patient_opt_out`, which is catalogued for
// exactly this and carries no `planId` precisely because nothing opened.
//
// ── THE §4.3.1 TOCTOU READ ───────────────────────────────────────────────────────────────────────────
//
// The decider takes `patientOptOut` and this consumer passes `null` — "could not be determined". That is
// the decider's own documented contract and its fail direction is OPEN, argued at length in its header: no
// published seam exposes `patient.bereavement_opt_out` (M5's `PatientReader` returns identity, not
// directives), M6's rule already evaluated the flag one transaction earlier, and §2.6 gives the flip a
// complete post-hoc path. Refusing to open a plan because a fact was unreadable would deny a grieving
// family a regulatory service to defend against a race the cascade already handles.
import { type DbClient, organizationTimezone, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { AdmissionId, IsoInstant, PatientId } from "@chartwarden/types";
import { and, eq } from "drizzle-orm";
import {
  type AdmissionAnchorResolver,
  decideEligibilityIntake,
  resolveDeathFact,
} from "../consumers/index";
import type { WriteOutboxPort } from "../routes/write-service";

const PLAN = schema.bereavementPlan;

/** §3.3 — a consumer-driven write names no acting membership. */
const CONSUMER_USER_ID = "";

/** The event M16 opens plans from, and the `(eventId, consumerName)` receipt identity. */
export const M16_BEREAVEMENT_ELIGIBLE_CONSUMER = {
  eventName: "m6.bereavement.eligible",
  consumerName: "m16.m6-bereavement-eligible",
} as const;

export interface BereavementIntakeDeps {
  readonly db: DbClient;
  /** The bound publisher — it `Value.Check`s `m16.*` against the boot catalog and rolls the tx back on a
   *  mismatch, so a skip cannot be recorded without its announcement. */
  readonly outbox: WriteOutboxPort;
  /** M6's org-explicit admission siting/anchor read. See ../consumers/death-discharge.ts for why the §4.7
   *  seam cannot be used from a relay tick. */
  readonly resolveAdmission: AdmissionAnchorResolver;
}

function factsOf(payload: unknown): {
  admissionId: AdmissionId;
  patientId: PatientId;
  eligibleAt: IsoInstant;
} {
  const p = (payload ?? {}) as Record<string, unknown>;
  const read = (key: string): string => {
    const value = p[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${M16_BEREAVEMENT_ELIGIBLE_CONSUMER.consumerName}: payload has no ${key}`);
    }
    return value;
  };
  return {
    admissionId: read("admissionId") as AdmissionId,
    patientId: read("patientId") as PatientId,
    eligibleAt: read("eligibleAt") as IsoInstant,
  };
}

/**
 * M16's live `m6.bereavement.eligible` binding — the §4.3.1 intake (D1, D4, D9, D16).
 *
 * Idempotent at two levels: the dispatcher's `(eventId, consumerName)` receipt, and — if a redelivery does
 * reach the handler — `berv_plan_unique_admission`, the D1 UNIQUE (org, admission) index. The conflict is
 * absorbed by the INDEX rather than by the decider's `existingPlan` pre-read alone: a pre-read races a
 * concurrent redelivery, and D1's "one program per death" is a structural claim the schema already makes.
 * The pre-read stays because it is what lets the decider answer `idempotent_skip` without a failed insert.
 */
export function buildM16BereavementIntakeConsumer(deps: BereavementIntakeDeps) {
  return {
    consumerName: M16_BEREAVEMENT_ELIGIBLE_CONSUMER.consumerName,
    consumerModule: "m16" as const,
    eventTypes: [M16_BEREAVEMENT_ELIGIBLE_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      const organizationId = event.organizationId;

      // D4 anchors `death_date` on the org's local calendar day, not UTC — a death at 11:45pm Pacific is
      // the FOLLOWING day in UTC, and the 13-month clock counts from this exact date.
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
            facts.eligibleAt,
            timezone,
            deps.resolveAdmission,
          );

      // Throws DEATH_FACT_UNRESOLVED / BEREAVEMENT_DEATH_DATE_MISMATCH — both dead-letter the delivery for
      // a human rather than opening a 13-month program on a guessed anchor.
      const action = decideEligibilityIntake(
        {
          admissionId: facts.admissionId,
          patientId: facts.patientId,
          eligibleAt: facts.eligibleAt,
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
                patientId: facts.patientId,
                admissionId: facts.admissionId,
                // The catalog requires a string; a skip decided before the death fact resolved has none.
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
