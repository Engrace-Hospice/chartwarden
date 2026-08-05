// M8's live M17 visit-publication consumer. M17's canonical trigger is `m17.visit.published`;
// draft insertion and the m8.encounter.created event commit together, guarded by the unique
// `(organization_id, visit_id)` index so a crash/retry cannot mint a second note.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { EncounterDiscipline, EncounterType, LocalDate } from "@wardenx/types";
import type {
  VisitPublishedPayload,
  VisitSeedingAction,
  VisitSeedingFacts,
} from "../consumers/seed-visit-encounter";
import { decideVisitSeeding } from "../consumers/seed-visit-encounter";

const ENCOUNTER = schema.encounters;

export interface M8VisitConsumerOutboxPort {
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

/** The canonical event-to-consumer binding for M17 publication (§4.7). */
export const M8_VISIT_PUBLISHED_CONSUMER = {
  eventName: "m17.visit.published",
  consumerName: "m8.seed-visit-encounter",
} as const;

export const M8_VISIT_PUBLISHED_CONSUMER_DEFERRED = false;
/** @deprecated Use M8_VISIT_PUBLISHED_CONSUMER. */
export const M8_VISIT_SCHEDULED_CONSUMER = M8_VISIT_PUBLISHED_CONSUMER;
/** @deprecated Use M8_VISIT_PUBLISHED_CONSUMER_DEFERRED. */
export const M8_VISIT_SCHEDULED_CONSUMER_DEFERRED = M8_VISIT_PUBLISHED_CONSUMER_DEFERRED;

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("m8.seed-visit-encounter: payload must be an object");
  }
  return value as Record<string, unknown>;
}

function stringOf(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`m8.seed-visit-encounter: '${key}' must be a non-empty string`);
  }
  return value;
}

function encounterTypeOf(value: string): EncounterType {
  switch (value) {
    case "routine_visit":
    case "admission_visit":
    case "recert_visit":
    case "face_to_face":
    case "telephonic":
    case "lpn_visit":
    case "chha_visit":
    case "msw_assessment":
    case "msw_followup":
    case "chaplain_assessment":
    case "chaplain_visit":
    case "volunteer_visit":
    case "bereavement_contact":
    case "idg_followup":
      return value;
    default:
      throw new Error(`m8.seed-visit-encounter: unsupported encounter type '${value}'`);
  }
}

function disciplineOf(value: string): EncounterDiscipline {
  switch (value) {
    case "rn":
    case "lpn":
    case "chha":
    case "msw":
    case "chaplain":
    case "volunteer":
    case "md":
    case "np":
      return value;
    default:
      throw new Error(`m8.seed-visit-encounter: unsupported discipline '${value}'`);
  }
}

function localDateOf(value: string): LocalDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`m8.seed-visit-encounter: invalid service date '${value}'`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`m8.seed-visit-encounter: invalid service date '${value}'`);
  }
  return value as LocalDate;
}

/** Build the production M8 binding over M8's table and M6's worker-safe active-service reader. */
export function buildM8VisitPublishedConsumer(deps: {
  readonly db: DbClient;
  readonly outbox: M8VisitConsumerOutboxPort;
  isAdmissionActive(organizationId: string, admissionId: string): Promise<boolean>;
}): {
  readonly consumerName: "m8.seed-visit-encounter";
  readonly consumerModule: "m8";
  readonly eventTypes: readonly ["m17.visit.published"];
  handle(event: { readonly organizationId: string; readonly payload: unknown }): Promise<void>;
} {
  return {
    consumerName: "m8.seed-visit-encounter",
    consumerModule: "m8",
    eventTypes: ["m17.visit.published"],
    async handle(event) {
      const payload = recordOf(event.payload);
      if (stringOf(payload, "organizationId") !== event.organizationId) {
        throw new Error(
          "m8.seed-visit-encounter: payload organization does not match outbox tenant",
        );
      }
      const visitId = stringOf(payload, "visitId");
      const patientId = stringOf(payload, "patientId");
      const admissionId = stringOf(payload, "admissionId");
      const authorMembershipId = stringOf(payload, "assignedMembershipId");
      const encounterType = encounterTypeOf(stringOf(payload, "encounterType"));
      const discipline = disciplineOf(stringOf(payload, "assignedDiscipline"));
      const serviceDate = localDateOf(stringOf(payload, "serviceDate"));

      if (!(await deps.isAdmissionActive(event.organizationId, admissionId))) {
        throw new Error(
          `m8.seed-visit-encounter: admission '${admissionId}' is not active; preserving event for reconciliation`,
        );
      }

      await withOrgContext(
        deps.db,
        { organizationId: event.organizationId, userId: "" },
        async (tx) => {
          const t = tx as DbClient;
          const [inserted] = await t
            .insert(ENCOUNTER)
            .values({
              organizationId: event.organizationId,
              providerEntityId:
                typeof payload.providerEntityId === "string" ? payload.providerEntityId : null,
              locationId: typeof payload.locationId === "string" ? payload.locationId : null,
              patientId,
              admissionId,
              visitId,
              encounterType,
              discipline,
              authoredByMembershipId: authorMembershipId,
              serviceDate,
              status: "draft",
            })
            .onConflictDoNothing()
            .returning({ id: ENCOUNTER.id });
          if (!inserted) return;
          await deps.outbox.publish(t, {
            eventName: "m8.encounter.created",
            organizationId: event.organizationId,
            aggregateKind: "encounter",
            aggregateId: inserted.id,
            payload: {
              encounterId: inserted.id,
              patientId,
              admissionId,
              visitId,
              encounterType,
              discipline,
              authoredByMembershipId: authorMembershipId,
              serviceDate,
            },
          });
        },
      );
    },
  };
}

/**
 * The pure decision the live (Wave-F) handler runs per delivery: resolve {@link VisitSeedingFacts} from
 * M8's `encounter` table (idempotency) + the M6 `AdmissionStatusReader` (active service), then call this
 * to get the {@link VisitSeedingAction} to execute through `EncounterCreator`. Kept as a one-line
 * re-export so the boot wiring (when M17 lands) reads `decideVisitScheduled(payload, facts)`.
 */
export function decideVisitScheduled(
  payload: VisitPublishedPayload,
  facts: VisitSeedingFacts,
): VisitSeedingAction {
  return decideVisitSeeding(payload, facts);
}
