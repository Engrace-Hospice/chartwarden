// apps/backend/src/modules/06-admission/routes/discharge-details-service.ts — the route-service CONTRACT of the
// after-the-fact discharge details (place of death on a completed death discharge, receiving care setting on a
// transfer-out). The Drizzle implementation is `../discharge-details-service-db.ts`; route tests inject fakes.
import type { DischargeDetailKind, PlaceOfDeath, ReceivingCareSetting } from "../discharge";

export interface DischargeDetailsView {
  readonly admissionId: string;
  readonly patientId: string;
  readonly admissionState: string;
  /** The admission's COMPLETED discharge_event (a voided or pending-cosign row is not a discharge). */
  readonly discharge: {
    readonly dischargeEventId: string;
    readonly reason: string;
    readonly status: string;
    readonly effectiveDate: string;
    readonly placeOfDeath: PlaceOfDeath | null;
    readonly placeOfDeathCorrectionReason: string | null;
    readonly version: number;
  } | null;
  /** The admission's latest transfer-OUT. */
  readonly transferOut: {
    readonly transferEventId: string;
    readonly effectiveDate: string;
    readonly receivingHospiceName: string | null;
    readonly receivingCareSetting: ReceivingCareSetting | null;
    readonly receivingCareSettingCorrectionReason: string | null;
    readonly version: number;
  } | null;
  readonly missing: DischargeDetailKind | null;
}

export interface RecordDetailInput<V extends string> {
  readonly value: V;
  readonly ifVersion: number;
  readonly correctionReason?: string;
}

export interface RecordDetailResult {
  readonly id: string;
  readonly admissionId: string;
  readonly detail: DischargeDetailKind;
  readonly value: string;
  readonly previousValue: string | null;
  readonly changed: boolean;
  readonly version: number;
  readonly claimPatientStatus: string;
}

export interface DischargeDetailsService {
  /** `null` when the admission does not exist in the org (RLS-hidden rows included). */
  getForAdmission(
    organizationId: string,
    admissionId: string,
  ): Promise<DischargeDetailsView | null>;
  /** The owning admission of a discharge_event / transfer_event (the ABAC scope target), or `null`. */
  admissionIdForDischarge(organizationId: string, dischargeEventId: string): Promise<string | null>;
  admissionIdForTransfer(organizationId: string, transferEventId: string): Promise<string | null>;
  recordPlaceOfDeath(
    organizationId: string,
    dischargeEventId: string,
    input: RecordDetailInput<PlaceOfDeath>,
    actorUserId: string,
  ): Promise<RecordDetailResult>;
  recordReceivingCareSetting(
    organizationId: string,
    transferEventId: string,
    input: RecordDetailInput<ReceivingCareSetting>,
    actorUserId: string,
  ): Promise<RecordDetailResult>;
}
