// apps/backend/src/modules/12-dosespot/history/ingest.ts — M12 `medicationHistoryService.ingestPullResult`
// (spec §4.3 / §2.8 D10 / §5.5 W-MR-05; F-230, #248).
//
// The persistence half of the MedHx pull. It is reached ONLY with a real `DoseSpotMedHistoryResponse` — i.e.
// only after `DoseSpotClient.pullMedicationHistory` resolved. With the production client unbound (no DoseSpot
// credentials) that call rejects and this file is never entered, so `m12.medication_history_pulled` is never
// emitted without a real ingested vendor payload (F-230 honesty rule).
//
// In ONE caller-supplied org-scoped transaction it (1) inserts the `medication_history_pull` ledger row —
// idempotent on `(organization_id, source_job_id)`, so a redelivered/re-run job is a no-op (no duplicate rows,
// no second event); (2) inserts one `medication_history_record` per returned entry, NEVER auto-linked to a
// `medication_order` (§2.8 "Why no auto-link"); (3) publishes `m12.medication_history_pulled` through the
// injected catalog-validating outbox in the SAME transaction (payload is id-only + a count: `patientId`,
// `rowsCreated`, `sourceJobId` — no drug-level detail, M14 pulls at consume time).
//
// A pull that returns ZERO entries is still ingested (ledger row, `rowsCreated: 0`, event emitted): that is
// the §5.5 edge "DoseSpot returns 0 entries — the M14 IDG packet shows 'No external medication history
// available' explicitly", which must be distinguishable from "never pulled".
import { type DbClient, schema } from "@wardenx/db";
import type { DoseSpotMedHistoryItem, DoseSpotMedHistoryResponse } from "@wardenx/dosespot";
import type { DoseSpotWriteOutboxPort } from "../dosespot-route-service-db";

const PULL = schema.medicationHistoryPulls;
const REC = schema.medicationHistoryRecords;

export interface IngestMedHistoryInput {
  readonly organizationId: string;
  readonly patientId: string;
  /** The vendor-side patient id the pull was keyed on (from `dosespot_patient_sync`). */
  readonly dosespotPatientId: string;
  /** The `dosespot_sync_queue` row id that drove the pull — the idempotency key. */
  readonly sourceJobId: string;
  readonly result: DoseSpotMedHistoryResponse;
}

export interface IngestMedHistoryOutcome {
  /** `false` when this `sourceJobId` had already been ingested (a redelivery — nothing written or emitted). */
  readonly ingested: boolean;
  readonly rowsCreated: number;
  readonly pullId: string | null;
}

function toRecordValues(
  input: IngestMedHistoryInput,
  pullId: string,
  item: DoseSpotMedHistoryItem,
  lineIndex: number,
): typeof REC.$inferInsert {
  return {
    organizationId: input.organizationId,
    patientId: input.patientId,
    pullId,
    sourceEventId: input.sourceJobId,
    lineIndex,
    rxnormRxcui: item.rxnormRxcui,
    ndc: item.ndc ?? null,
    drugName: item.drugName,
    strength: item.strength ?? null,
    doseForm: item.doseForm ?? null,
    sigText: item.sigText ?? null,
    prescribedAt: item.prescribedAt ? new Date(item.prescribedAt) : null,
    lastFillDate: item.lastFillDate,
    fillDates: [...(item.fillDates ?? [])],
    sourcePharmacy: item.sourcePharmacy,
    pharmacyNcpdp: item.pharmacyNcpdp ?? null,
    prescriberNpi: item.prescriberNpi ?? null,
  };
}

/**
 * `ingestPullResult`. `tx` MUST be an org-scoped transaction (`withOrgContext`); RLS then backstops tenancy.
 * Entries with a blank `drugName` are skipped (the column is NOT NULL and a nameless entry is unusable on the
 * reconciliation worksheet) and counted in `total_returned` but not `rows_created`.
 */
export async function ingestMedicationHistoryPull(
  tx: DbClient,
  outbox: DoseSpotWriteOutboxPort,
  input: IngestMedHistoryInput,
): Promise<IngestMedHistoryOutcome> {
  const usable = input.result.items
    .map((item, i) => ({ item, i }))
    .filter(({ item }) => item.drugName.trim().length > 0);

  const [pull] = await tx
    .insert(PULL)
    .values({
      organizationId: input.organizationId,
      patientId: input.patientId,
      sourceJobId: input.sourceJobId,
      dosespotPatientId: input.dosespotPatientId,
      totalReturned: input.result.items.length,
      rowsCreated: usable.length,
      pulledAt: new Date(input.result.pulledAt),
    })
    .onConflictDoNothing({ target: [PULL.organizationId, PULL.sourceJobId] })
    .returning({ id: PULL.id });
  if (!pull) return { ingested: false, rowsCreated: 0, pullId: null };

  if (usable.length > 0) {
    await tx
      .insert(REC)
      .values(usable.map(({ item, i }) => toRecordValues(input, pull.id, item, i)));
  }

  await outbox.publish(tx, {
    eventName: "m12.medication_history_pulled",
    organizationId: input.organizationId,
    aggregateKind: "medication_history_pull",
    aggregateId: pull.id,
    payload: {
      patientId: input.patientId,
      rowsCreated: usable.length,
      sourceJobId: input.sourceJobId,
    },
  });
  return { ingested: true, rowsCreated: usable.length, pullId: pull.id };
}
