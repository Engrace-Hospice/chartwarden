// apps/backend/src/modules/15-discipline-care-plans/consumers/m6-admission-activated.ts — the §1.1 D10
// plan-stub bootstrap, and the WRITE PATH M15 has never had (F-103 / #103).
//
// ── WHAT WAS MISSING ─────────────────────────────────────────────────────────────────────────────────
//
// `bootstrapDisciplinePlan` is M15's §2.2.1 `[*] → draft` factory and its own doc comment says it is
// "called by the `m6.admission.activated` consumer for the three always-bootstrapped kinds". THERE WAS NO
// SUCH CONSUMER. `../consumers/` was a seam-READING layer (M7 care-plan elements, M8 signed encounters,
// volunteer visits) with no `OutboxConsumerBinding` in it, m15 was not in `m6.admission.activated`'s
// `declaredConsumers`, and — one layer below both of those — there was NO INSERT INTO
// `discipline_care_plan` ANYWHERE IN THE REPOSITORY: not in the write service, not in a seed, not in a
// test. Nor is there a route that creates one. Every M15 write route is `/discipline-plans/:planId/…`,
// which is the design: the bootstrap consumer is the ONLY creation path, and it did not exist.
//
// So the aide plan of care (CoP 418.76), the MSW plan (418.64(c)) and the spiritual plan (418.64(d)) — and
// with them every goal, intervention, discipline assessment and 14-day aide supervisory visit, all of
// which hang off `plan_id` rather than a version — were unreachable in every deployment that has ever
// run. The §7.1/§7.2/§7.3 initial-assessment clocks count from `initial_assessment_clock_started_at`, and
// nothing set it, so no clock ever started and no alert ever fired. An empty compliance surface and a
// compliant one are indistinguishable, which is the M20 `safety_check_in_schedule` lesson one module over.
//
// ── WHAT THIS DELIBERATELY DOES NOT CREATE ───────────────────────────────────────────────────────────
//
// A `discipline_care_plan_version`. §7.1 assigns v1 to a person — "the supervising RN … creates Aide POC
// v1 with the task list + frequencies, finalizes, and signs" — so a stub version authored by the relay
// would put a draft on the record nobody wrote. That table has no writer either, and no route creates one
// (`/versions` is a GET; only `finalize` and `sign` are POSTs), so authoring a plan still cannot be
// completed. That is a route-layer gap in M15's own §4.1 surface, reported rather than smuggled in here:
// inventing a version inside a bootstrap consumer would make the relay the author of a clinical document.
//
// ── SITING ───────────────────────────────────────────────────────────────────────────────────────────
//
// `provider_entity_id` and `location_id` are NOT NULL on the plan, "denormalized from the admission at
// bootstrap so the §4.3 compliance seams can aggregate per-PE/location without joining through M5/M6".
// The event payload carries neither, so the consumer reads them — through an INJECTED port the
// composition root binds to M6's org-explicit `admissionSchedulingContextForOrg`, the same shape M10's
// scheduling consumer takes. M6's §4.7 `AdmissionStatusReader` cannot be used: its id-keyed reads open
// `withOrgContextFromRequest` and a relay tick has no ambient request scope, so every delivery would
// dead-letter with `no ambient request context`.
//
// An admission with no location is a THROW, not a skip. The row is retried and eventually dead-lettered,
// which is visible; silently creating nothing would be a CoP clock that never starts and a queue nobody
// is watching — the exact failure this file exists to end.
import { type DbClient, schema } from "@wardenx/db";
import { BOOTSTRAP_ON_ADMISSION_ACTIVATED, requiredSignersFor } from "@wardenx/discipline-plans";
import { withOrgContext } from "@wardenx/tenancy";
import type { DisciplinePlanKind } from "@wardenx/types";
import { bootstrapDisciplinePlan } from "../lifecycle/index";
import type { WriteOutboxPort } from "../routes/write-service";

const PLAN = schema.disciplineCarePlan;

/** §3.3 — a consumer-driven write names no acting membership. */
const CONSUMER_USER_ID = "";

/** The event M15 bootstraps from, and the `(eventId, consumerName)` receipt identity. */
export const M15_PLAN_BOOTSTRAP_CONSUMER = {
  eventName: "m6.admission.activated",
  consumerName: "m15.m6-admission-activated",
} as const;

/** The `m6.admission.activated` facts M15 reads. M6 owns the canonical wire shape; this leaf-typed
 *  projection is the single point to reconcile if M6 renames anything. */
export interface AdmissionActivatedFacts {
  readonly admissionId: string;
  readonly patientId: string;
  /** The D10 clock anchor. Taken from the EVENT rather than the row so a redelivery replays the fact as
   *  it was announced (the M10 scheduling consumer's rule). */
  readonly activatedAt: string;
}

/** The admission siting the plan denormalizes. Bound to M6's org-explicit reader at the composition root;
 *  injectable so the unit tests drive the same consumer through a double. */
export type AdmissionSitingResolver = (
  organizationId: string,
  admissionId: string,
) => Promise<{
  readonly providerEntityId: string | null;
  readonly locationId: string | null;
} | null>;

export interface DisciplinePlanBootstrapDeps {
  readonly db: DbClient;
  /** The bound publisher — it `Value.Check`s `m15.plan.bootstrapped` against the boot catalog and rolls
   *  the tx back on a mismatch, so a plan cannot be created without its announcement. */
  readonly outbox: WriteOutboxPort;
  readonly resolveSiting: AdmissionSitingResolver;
}

function factsOf(payload: unknown): AdmissionActivatedFacts {
  const p = (payload ?? {}) as Record<string, unknown>;
  const read = (key: string): string => {
    const value = p[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${M15_PLAN_BOOTSTRAP_CONSUMER.consumerName}: payload has no ${key}`);
    }
    return value;
  };
  return {
    admissionId: read("admissionId"),
    patientId: read("patientId"),
    activatedAt: read("activatedAt"),
  };
}

/**
 * M15's live `m6.admission.activated` binding — creates the three CoP plan stubs in `draft` (§1.1 D10).
 *
 * `volunteer_plan` is NOT created here: §1.1 D10 makes it lazy on the first volunteer assignment, because
 * not every patient gets a volunteer and an empty volunteer plan on every admission is survey clutter.
 * The kinds come from `BOOTSTRAP_ON_ADMISSION_ACTIVATED` rather than a literal here, so the two cannot
 * drift.
 *
 * Idempotent at two levels: the dispatcher's `(eventId, consumerName)` receipt, and — if a redelivery
 * does reach the handler — `discipline_care_plan_admission_kind_active_uq`, the §3.3 partial unique index
 * on (org, admission, kind) WHERE status <> 'discharged'. The conflict is absorbed by the index rather
 * than by a pre-read: a pre-read races a concurrent redelivery, and the index is the structural backstop
 * the schema comment already calls it. A row that conflicts emits NOTHING — `m15.plan.bootstrapped` is
 * documented "idempotency key `planId`", and announcing a plan that was not created would hand M14's
 * packet builder an id it cannot resolve.
 */
export function buildM15PlanBootstrapConsumer(deps: DisciplinePlanBootstrapDeps) {
  return {
    consumerName: M15_PLAN_BOOTSTRAP_CONSUMER.consumerName,
    consumerModule: "m15" as const,
    eventTypes: [M15_PLAN_BOOTSTRAP_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      const organizationId = event.organizationId;

      const siting = await deps.resolveSiting(organizationId, facts.admissionId);
      if (!siting) {
        throw new Error(
          `${M15_PLAN_BOOTSTRAP_CONSUMER.consumerName}: admission ${facts.admissionId} not found in org`,
        );
      }
      // Both columns are NOT NULL and the §4.3 per-PE/location compliance rollups are what they exist
      // for. An unsited admission is a real defect upstream; failing the delivery keeps it visible in the
      // outbox instead of turning it into three plans that cannot be aggregated — or into silence.
      if (!siting.providerEntityId || !siting.locationId) {
        throw new Error(
          `${M15_PLAN_BOOTSTRAP_CONSUMER.consumerName}: admission ${facts.admissionId} has no ` +
            `${siting.providerEntityId ? "location" : "provider entity"} to site the plan against`,
        );
      }
      const providerEntityId = siting.providerEntityId;
      const locationId = siting.locationId;

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          for (const kind of BOOTSTRAP_ON_ADMISSION_ACTIVATED) {
            const stub = bootstrapDisciplinePlan(kind, facts.activatedAt as never);
            const inserted = await tx
              .insert(PLAN)
              .values({
                organizationId,
                patientId: facts.patientId,
                admissionId: facts.admissionId,
                providerEntityId,
                locationId,
                kind: kind as DisciplinePlanKind,
                status: stub.status,
                // The `set_timestamp` effect the factory returns: the D10 anchor the §7.1 supervisory
                // clock and the §7.2/§7.3 five-day initial-assessment gates all count from.
                initialAssessmentClockStartedAt: new Date(stub.initialAssessmentClockStartedAt),
              })
              .onConflictDoNothing()
              .returning({ id: PLAN.id });
            const planId = inserted[0]?.id;
            if (!planId) continue; // a live plan for this (admission, kind) already exists

            await deps.outbox.publish(tx, {
              organizationId,
              eventName: "m15.plan.bootstrapped",
              aggregateKind: "discipline_care_plan",
              aggregateId: planId,
              payload: {
                planId,
                admissionId: facts.admissionId,
                patientId: facts.patientId,
                kind,
                // §3.5 / D11 — the quorum the first version will have to satisfy, resolved from the
                // shared constant rather than restated, so M14's packet builder reads what M15 enforces.
                requiredSignerSet: requiredSignersFor(kind, "initial") as never,
              },
            });
          }
        },
      );
    },
  };
}
