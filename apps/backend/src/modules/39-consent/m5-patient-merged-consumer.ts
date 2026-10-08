// apps/backend/src/modules/39-consent/m5-patient-merged-consumer.ts — M39 spec §4.6 / GAP-067.
//
// `m5.patient.merged` → every consent row keyed on the merged-away chart (`sourcePatientId`) is re-pointed to
// the SURVIVOR (`patientId`) in ONE transaction, and one `m39.consent.repointed` rides the same tx.
//
// WHY A PUSH. Consent is the control that gates PHI egress, and a 42 CFR Part 2 release (or its revocation)
// that stays on the folded-away chart is invisible to every evaluation of the survivor: a revocation would
// stop restricting, a release would stop authorizing. `consumers.ts` carried the pure decision since M39-T08
// but nothing bound it, so the rows never moved.
//
// WHAT MOVES: `consent_record` (recipients, DPOA agents, revocations, document links hang off the record id
// and follow it), `delegated_access` and `consent_renewal_cycle`. WHAT DOES NOT: `consent_eval_audit` is an
// INSERT-only evidence log (DB trigger) of what was evaluated against the id at the time; rewriting it would
// falsify the record.
//
// THE PAYLOAD IS A TRIGGER, NOT A DATA FEED. The org id comes from the M1 outbox envelope; a payload org id
// that disagrees dead-letters the delivery. Rows are re-pointed under RLS in the envelope org only.
//
// IDEMPOTENT. The UPDATEs are keyed on `patient_id = source`, so a redelivery finds nothing, moves nothing and
// emits nothing.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../bootstrap/outbox-dispatcher";
import type { ConsentWriteOutboxPort } from "./consent-store-db";
import { decidePatientMergeRepoint } from "./consumers";

const CR = schema.consentRecord;
const DA = schema.delegatedAccess;
const RC = schema.consentRenewalCycle;

export const M39_PATIENT_MERGED_CONSUMER_NAME = "m39-m5-patient-merged";

export interface MergeRepointResult {
  readonly consentRecordIds: readonly string[];
  readonly delegatedAccessCount: number;
  readonly renewalCycleCount: number;
}

/** The consent writes the consumer needs, scoped to ONE org transaction. */
export interface MergeRepointTx {
  repoint(fromPatientId: string, toPatientId: string): Promise<MergeRepointResult>;
  publishRepointed(payload: Record<string, unknown>, aggregateId: string): Promise<void>;
}

export interface MergeRepointUnitOfWork {
  run<T>(organizationId: string, fn: (tx: MergeRepointTx) => Promise<T>): Promise<T>;
}

/** Validate the delivery. Throws (dead-letters) on a malformed, self-merge or cross-org event. */
export function parseMergedEvent(event: {
  readonly organizationId: string;
  readonly payload: unknown;
}): {
  readonly organizationId: string;
  readonly survivorPatientId: string;
  readonly sourcePatientId: string;
} {
  const name = M39_PATIENT_MERGED_CONSUMER_NAME;
  const payload =
    typeof event.payload === "object" && event.payload !== null
      ? (event.payload as Record<string, unknown>)
      : null;
  if (payload === null) throw new Error(`${name}: payload missing`);
  const { patientId, sourcePatientId } = payload;
  if (typeof patientId !== "string" || patientId.length === 0)
    throw new Error(`${name}: 'patientId' (the survivor) must be a non-empty string`);
  if (typeof sourcePatientId !== "string" || sourcePatientId.length === 0)
    throw new Error(`${name}: 'sourcePatientId' must be a non-empty string`);
  if (patientId === sourcePatientId)
    throw new Error(`${name}: survivor and source must be distinct patients`);
  if (payload.organizationId !== undefined && payload.organizationId !== event.organizationId)
    throw new Error(`${name}: payload organization does not match the outbox envelope`);
  return { organizationId: event.organizationId, survivorPatientId: patientId, sourcePatientId };
}

/** Execute the §4.6 re-point for one delivery. Returns what it moved. */
export async function applyPatientMerged(
  uow: MergeRepointUnitOfWork,
  event: { readonly organizationId: string; readonly payload: unknown },
): Promise<MergeRepointResult> {
  const { organizationId, survivorPatientId, sourcePatientId } = parseMergedEvent(event);
  const plan = decidePatientMergeRepoint({
    organizationId,
    patientId: survivorPatientId,
    sourcePatientId,
  });
  return uow.run(organizationId, async (tx) => {
    const moved = await tx.repoint(plan.repointFrom, plan.repointTo);
    if (
      moved.consentRecordIds.length === 0 &&
      moved.delegatedAccessCount === 0 &&
      moved.renewalCycleCount === 0
    )
      return moved;
    await tx.publishRepointed(
      {
        organizationId,
        patientId: plan.repointTo,
        sourcePatientId: plan.repointFrom,
        consentRecordIds: moved.consentRecordIds,
        delegatedAccessCount: moved.delegatedAccessCount,
        renewalCycleCount: moved.renewalCycleCount,
      },
      plan.repointTo,
    );
    return moved;
  });
}

/** The Drizzle unit of work: an explicit-org, system-actor transaction (a relay delivery is not a request). */
export function createDrizzleMergeRepointUow(
  db: DbClient,
  outbox: ConsentWriteOutboxPort,
): MergeRepointUnitOfWork {
  return {
    run: (organizationId, fn) =>
      withOrgContext(db, { organizationId, userId: "", systemActor: true }, async (scoped) => {
        const tx = scoped as unknown as DbClient;
        return fn({
          async repoint(fromPatientId, toPatientId) {
            const now = new Date();
            const records = await tx
              .update(CR)
              .set({ patientId: toPatientId, updatedAt: now })
              .where(and(eq(CR.organizationId, organizationId), eq(CR.patientId, fromPatientId)))
              .returning({ id: CR.id });
            const access = await tx
              .update(DA)
              .set({ patientId: toPatientId })
              .where(and(eq(DA.organizationId, organizationId), eq(DA.patientId, fromPatientId)))
              .returning({ id: DA.id });
            const cycles = await tx
              .update(RC)
              .set({ patientId: toPatientId })
              .where(and(eq(RC.organizationId, organizationId), eq(RC.patientId, fromPatientId)))
              .returning({ id: RC.id });
            return {
              consentRecordIds: records.map((r) => r.id),
              delegatedAccessCount: access.length,
              renewalCycleCount: cycles.length,
            };
          },
          async publishRepointed(payload, aggregateId) {
            await outbox.publish(tx, {
              eventName: "m39.consent.repointed",
              payload,
              organizationId,
              aggregateKind: "patient",
              aggregateId,
            });
          },
        });
      }),
  };
}

/** The live `m5.patient.merged` → consent re-point binding. */
export function buildM39PatientMergedConsumer(deps: {
  readonly db: DbClient;
  readonly outbox: ConsentWriteOutboxPort;
}): OutboxConsumerBinding {
  const uow = createDrizzleMergeRepointUow(deps.db, deps.outbox);
  return {
    consumerName: M39_PATIENT_MERGED_CONSUMER_NAME,
    consumerModule: "m39",
    eventTypes: ["m5.patient.merged"],
    async handle(event) {
      await applyPatientMerged(uow, event);
    },
  };
}
