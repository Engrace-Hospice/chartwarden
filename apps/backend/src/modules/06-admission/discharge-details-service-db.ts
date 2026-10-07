// apps/backend/src/modules/06-admission/discharge-details-service-db.ts — the Drizzle implementation of the
// after-the-fact discharge details (routes/discharge-details-routes.ts). Every call runs in ONE
// `withOrgContext` transaction (RLS-scoped to the caller's org; a cross-tenant id reads as absent).
//
// WRITE RULES (discharge/discharge-details.ts `decideDetailUpdate`):
//   - the place of death is only recorded on a COMPLETED `death` discharge_event; the receiving care setting only
//     on a transfer OUT (422 DISCHARGE_DETAIL_NOT_APPLICABLE otherwise — and migration 0370's CHECKs back it);
//   - `ifVersion` must equal the row version (409 VERSION_MISMATCH), and the UPDATE re-checks it;
//   - NULL → value needs no reason; value → different value needs `correctionReason` (persisted in the 0372
//     column so the M4 write-audit trigger records old value, new value and reason in one audit row);
//   - the same value again is a no-op (no version bump, no event).
// Each change publishes `m6.discharge.details_recorded` on the same transaction (outbox); M23 re-validates the
// admission's open claims from it.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, desc, eq, sql } from "drizzle-orm";
import type { AdmissionWriteOutboxPort } from "./admission-route-service-db";
import {
  type DischargeDetailKind,
  PLACE_OF_DEATH_STATUS,
  type PlaceOfDeath,
  RECEIVING_CARE_SETTING_STATUS,
  type ReceivingCareSetting,
  correctionReasonRequiredMessage,
  decideDetailUpdate,
  missingDischargeDetail,
} from "./discharge";
import type {
  DischargeDetailsService,
  DischargeDetailsView,
  RecordDetailInput,
  RecordDetailResult,
} from "./routes/discharge-details-service";
import { ResourceNotFoundError, VersionMismatchError } from "./routes/service";
import { AdmissionStateError } from "./state-machines/errors";

const ADM = schema.admissions;
const DE = schema.dischargeEvents;
const TE = schema.transferEvents;

export const DISCHARGE_DETAILS_RECORDED_EVENT = "m6.discharge.details_recorded" as const;

type Tx = DbClient;

const NOOP_OUTBOX: AdmissionWriteOutboxPort = { async publish() {} };

/** The event payload (catalogued in events-by-m6.ts). Codes and ids only — the correction reason stays on the row. */
function detailsRecordedPayload(args: {
  readonly admissionId: string;
  readonly patientId: string;
  readonly detail: DischargeDetailKind;
  readonly eventRowId: string;
  readonly value: string;
  readonly previousValue: string | null;
}): Record<string, unknown> {
  return {
    admissionId: args.admissionId,
    patientId: args.patientId,
    detail: args.detail,
    ...(args.detail === "place_of_death"
      ? { dischargeEventId: args.eventRowId }
      : { transferEventId: args.eventRowId }),
    value: args.value,
    previousValue: args.previousValue,
    corrected: args.previousValue !== null,
  };
}

export function createDbDischargeDetailsService(
  db: DbClient,
  outbox: AdmissionWriteOutboxPort = NOOP_OUTBOX,
  now: () => Date = () => new Date(),
): DischargeDetailsService {
  const inOrg = <T>(organizationId: string, userId: string, fn: (tx: Tx) => Promise<T>) =>
    withOrgContext(db, { organizationId, userId }, fn);
  /** Reads carry no acting user (the M6 read convention, `userId: ""`). */
  const READER = "";

  async function patientOf(tx: Tx, admissionId: string): Promise<string> {
    const [row] = await tx
      .select({ patientId: ADM.patientId })
      .from(ADM)
      .where(eq(ADM.id, admissionId))
      .limit(1);
    if (!row) throw new ResourceNotFoundError(admissionId);
    return row.patientId;
  }

  async function emit(
    tx: Tx,
    organizationId: string,
    aggregateKind: "discharge_event" | "transfer_event",
    payload: Record<string, unknown> & { readonly admissionId: string },
    aggregateId: string,
  ): Promise<void> {
    await outbox.publish(tx, {
      eventName: DISCHARGE_DETAILS_RECORDED_EVENT,
      payload,
      organizationId,
      aggregateKind,
      aggregateId,
    });
  }

  function refuseWithoutReason(kind: DischargeDetailKind, current: string): never {
    throw new AdmissionStateError(
      "DISCHARGE_DETAIL_CORRECTION_REASON_REQUIRED",
      correctionReasonRequiredMessage(kind, current),
      [
        {
          field: "correctionReason",
          code: "DISCHARGE_DETAIL_CORRECTION_REASON_REQUIRED",
          message: correctionReasonRequiredMessage(kind, current),
        },
      ],
    );
  }

  return {
    async getForAdmission(organizationId, admissionId) {
      return inOrg(organizationId, READER, async (tx): Promise<DischargeDetailsView | null> => {
        const [adm] = await tx
          .select({ id: ADM.id, patientId: ADM.patientId, status: ADM.status })
          .from(ADM)
          .where(and(eq(ADM.id, admissionId), eq(ADM.organizationId, organizationId)))
          .limit(1);
        if (!adm) return null;
        const [de] = await tx
          .select({
            id: DE.id,
            dischargeType: DE.dischargeType,
            status: DE.status,
            effectiveAt: DE.effectiveAt,
            placeOfDeath: DE.placeOfDeath,
            reason: DE.placeOfDeathCorrectionReason,
            version: DE.version,
          })
          .from(DE)
          .where(and(eq(DE.admissionId, admissionId), eq(DE.status, "completed")))
          .limit(1);
        const [te] = await tx
          .select({
            id: TE.id,
            effectiveAt: TE.effectiveAt,
            name: TE.receivingOrSendingName,
            setting: TE.receivingCareSetting,
            reason: TE.receivingCareSettingCorrectionReason,
            version: TE.version,
          })
          .from(TE)
          .where(and(eq(TE.admissionId, admissionId), eq(TE.direction, "out")))
          .orderBy(desc(TE.effectiveAt))
          .limit(1);
        const discharge = de
          ? {
              dischargeEventId: de.id,
              reason: String(de.dischargeType),
              status: String(de.status),
              effectiveDate: String(de.effectiveAt),
              placeOfDeath: (de.placeOfDeath ?? null) as PlaceOfDeath | null,
              placeOfDeathCorrectionReason: de.reason ?? null,
              version: Number(de.version),
            }
          : null;
        const transferOut = te
          ? {
              transferEventId: te.id,
              effectiveDate: String(te.effectiveAt),
              receivingHospiceName: te.name ?? null,
              receivingCareSetting: (te.setting ?? null) as ReceivingCareSetting | null,
              receivingCareSettingCorrectionReason: te.reason ?? null,
              version: Number(te.version),
            }
          : null;
        return {
          admissionId: adm.id,
          patientId: adm.patientId,
          admissionState: String(adm.status),
          discharge,
          transferOut,
          missing: missingDischargeDetail({
            discharge: discharge
              ? { reason: discharge.reason, placeOfDeath: discharge.placeOfDeath }
              : null,
            transferOut: transferOut
              ? { receivingCareSetting: transferOut.receivingCareSetting }
              : null,
          }),
        };
      });
    },

    async admissionIdForDischarge(organizationId, dischargeEventId) {
      return inOrg(organizationId, READER, async (tx) => {
        const [row] = await tx
          .select({ admissionId: DE.admissionId })
          .from(DE)
          .where(and(eq(DE.id, dischargeEventId), eq(DE.organizationId, organizationId)))
          .limit(1);
        return row?.admissionId ?? null;
      });
    },

    async admissionIdForTransfer(organizationId, transferEventId) {
      return inOrg(organizationId, READER, async (tx) => {
        const [row] = await tx
          .select({ admissionId: TE.admissionId })
          .from(TE)
          .where(and(eq(TE.id, transferEventId), eq(TE.organizationId, organizationId)))
          .limit(1);
        return row?.admissionId ?? null;
      });
    },

    async recordPlaceOfDeath(
      organizationId,
      dischargeEventId,
      input: RecordDetailInput<PlaceOfDeath>,
      actorUserId,
    ): Promise<RecordDetailResult> {
      return inOrg(organizationId, actorUserId, async (tx) => {
        const [cur] = await tx
          .select({
            admissionId: DE.admissionId,
            dischargeType: DE.dischargeType,
            status: DE.status,
            placeOfDeath: DE.placeOfDeath,
            version: DE.version,
          })
          .from(DE)
          .where(and(eq(DE.id, dischargeEventId), eq(DE.organizationId, organizationId)))
          .limit(1);
        if (!cur) throw new ResourceNotFoundError(dischargeEventId);
        if (String(cur.dischargeType) !== "death" || String(cur.status) !== "completed") {
          throw new AdmissionStateError(
            "DISCHARGE_DETAIL_NOT_APPLICABLE",
            `a place of death is only recorded on a completed death discharge (this discharge is '${String(cur.dischargeType)}', status '${String(cur.status)}')`,
          );
        }
        if (Number(cur.version) !== input.ifVersion) {
          throw new VersionMismatchError(dischargeEventId, Number(cur.version), input.ifVersion);
        }
        const previous = (cur.placeOfDeath ?? null) as PlaceOfDeath | null;
        const verdict = decideDetailUpdate({
          current: previous,
          requested: input.value,
          correctionReason: input.correctionReason,
        });
        const base = {
          id: dischargeEventId,
          admissionId: cur.admissionId,
          detail: "place_of_death" as const,
          value: input.value,
          previousValue: previous,
          claimPatientStatus: PLACE_OF_DEATH_STATUS[input.value],
        };
        if (verdict.kind === "noop")
          return { ...base, changed: false, version: Number(cur.version) };
        if (verdict.kind === "reason_required")
          refuseWithoutReason("place_of_death", String(previous));
        const at = now();
        const [row] = await tx
          .update(DE)
          .set({
            placeOfDeath: input.value,
            placeOfDeathCorrectionReason: verdict.kind === "correct" ? verdict.reason : null,
            version: sql`${DE.version} + 1`,
            updatedAt: at,
          })
          .where(and(eq(DE.id, dischargeEventId), eq(DE.version, input.ifVersion)))
          .returning({ version: DE.version });
        if (!row) {
          throw new VersionMismatchError(dischargeEventId, Number(cur.version), input.ifVersion);
        }
        await emit(
          tx,
          organizationId,
          "discharge_event",
          detailsRecordedPayload({
            admissionId: cur.admissionId,
            patientId: await patientOf(tx, cur.admissionId),
            detail: "place_of_death",
            eventRowId: dischargeEventId,
            value: input.value,
            previousValue: previous,
          }) as Record<string, unknown> & { admissionId: string },
          dischargeEventId,
        );
        return { ...base, changed: true, version: Number(row.version) };
      });
    },

    async recordReceivingCareSetting(
      organizationId,
      transferEventId,
      input: RecordDetailInput<ReceivingCareSetting>,
      actorUserId,
    ): Promise<RecordDetailResult> {
      return inOrg(organizationId, actorUserId, async (tx) => {
        const [cur] = await tx
          .select({
            admissionId: TE.admissionId,
            direction: TE.direction,
            setting: TE.receivingCareSetting,
            version: TE.version,
          })
          .from(TE)
          .where(and(eq(TE.id, transferEventId), eq(TE.organizationId, organizationId)))
          .limit(1);
        if (!cur) throw new ResourceNotFoundError(transferEventId);
        if (String(cur.direction) !== "out") {
          throw new AdmissionStateError(
            "DISCHARGE_DETAIL_NOT_APPLICABLE",
            "a receiving care setting is only recorded on a transfer OUT (this is a transfer in)",
          );
        }
        if (Number(cur.version) !== input.ifVersion) {
          throw new VersionMismatchError(transferEventId, Number(cur.version), input.ifVersion);
        }
        const previous = (cur.setting ?? null) as ReceivingCareSetting | null;
        const verdict = decideDetailUpdate({
          current: previous,
          requested: input.value,
          correctionReason: input.correctionReason,
        });
        const base = {
          id: transferEventId,
          admissionId: cur.admissionId,
          detail: "receiving_care_setting" as const,
          value: input.value,
          previousValue: previous,
          claimPatientStatus: RECEIVING_CARE_SETTING_STATUS[input.value],
        };
        if (verdict.kind === "noop")
          return { ...base, changed: false, version: Number(cur.version) };
        if (verdict.kind === "reason_required") {
          refuseWithoutReason("receiving_care_setting", String(previous));
        }
        const at = now();
        const [row] = await tx
          .update(TE)
          .set({
            receivingCareSetting: input.value,
            receivingCareSettingCorrectionReason:
              verdict.kind === "correct" ? verdict.reason : null,
            version: sql`${TE.version} + 1`,
            updatedAt: at,
          })
          .where(and(eq(TE.id, transferEventId), eq(TE.version, input.ifVersion)))
          .returning({ version: TE.version });
        if (!row) {
          throw new VersionMismatchError(transferEventId, Number(cur.version), input.ifVersion);
        }
        await emit(
          tx,
          organizationId,
          "transfer_event",
          detailsRecordedPayload({
            admissionId: cur.admissionId,
            patientId: await patientOf(tx, cur.admissionId),
            detail: "receiving_care_setting",
            eventRowId: transferEventId,
            value: input.value,
            previousValue: previous,
          }) as Record<string, unknown> & { admissionId: string },
          transferEventId,
        );
        return { ...base, changed: true, version: Number(row.version) };
      });
    },
  };
}
