import type {
  NewLabObservationInboundLinkRow,
  NewLabObservationRow,
  NewLabObservationValueRow,
} from "@wardenx/db/schema";
// apps/backend/src/modules/29-external-interfaces/inbound — ORU lab attach planning (M29-T05, §2.2/§4.6 D7).
// PURE. The transactional-pinch-point core: it turns a projected ORU + its resolved patient binding +
// terminology/SUD/abnormal decisions into either
//   • `attach`    — the `lab_observation` insert row + N `lab_observation_value` rows + the
//                   `lab_observation_inbound_link` row + the outbox descriptors (received / attached /
//                   abnormal-critical) + the M22 PDF handshake descriptors, or
//   • `unmatched` — no `lab_observation` PARENT (its `patient_id` and, via ARCH-011, its
//                   `provider_entity_id` are both NOT NULL, and an unmatched result has neither), but the
//                   observation id is RESERVED and its `lab_observation_value` rows + one
//                   `lab_observation_inbound_link` row ARE written, plus the
//                   `m29.lab_observation.unmatched` descriptor. GAP-044: before that, the unmatched branch
//                   returned the event and nothing else — no link row — so the §4.2 review queue, which
//                   reads exactly that table, was permanently EMPTY and the result values a reviewer needs
//                   to identify the patient (§5.2.4's detail panel) were discarded at the wire boundary.
//                   The manual bind materializes the parent under the reserved id.
//
// Determinism (mirrors `planProposal`, T04): the caller supplies `observationId` / `linkId` / `receivedAt`
// so the result is a pure function of its inputs — the T08 worker mints the ids + clock and does the atomic
// multi-row insert + publish. Nothing here touches the DB, the outbox, or the clock.
import type {
  LabAbnormalFlag,
  LabAbnormalSummary,
  LabResultStatus,
  LabTerminologyValidation,
  LabValueType,
} from "@wardenx/types";
import { LAB_VALUE_TYPES } from "@wardenx/types";
import type { ProjectedObr, ProjectedObx } from "./hl7-oru-projection";
import { computeAbnormalSummary, isCriticalFlagSet, selectValueFlag } from "./lab-abnormal";
import type { LabPatientResolution } from "./lab-patient-resolver";
import { type ExtractedPdf, OBX_ENCAPSULATED_DATA_TYPE } from "./obx-pdf";

/** The value written to a SUD-redacted `string_value` (the raw wire value never lands, D15). */
export const SUD_REDACTED_SENTINEL = "[REDACTED_SUD]";

// ── Outbox descriptors (§2.4 / §4.10) — RETURNED, never published here (the T08 worker owns the write) ────

export interface LabReceivedPayload {
  readonly observationId: string;
  readonly sourceMessageId: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly orderRecordId: string | null;
  readonly matchMethod: LabPatientResolution["matchMethod"];
  readonly terminologyValidation: LabTerminologyValidation;
  readonly sudRedacted: boolean;
  readonly abnormalSummary: LabAbnormalSummary;
}

export interface LabAttachedPayload {
  readonly observationId: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly orderRecordId: string | null;
  readonly loincCode: string;
  readonly abnormalFlag: LabAbnormalFlag | null;
  readonly observationDatetime: string;
}

export interface LabAbnormalFlagPayload {
  readonly observationId: string;
  readonly organizationId: string;
  readonly patientId: string;
  /** The panel LOINC only — the abnormal VALUE and its numeric result stay OFF the alert (PHI denylist, §8). */
  readonly loincCode: string;
  readonly criticalCount: number;
}

export interface LabUnmatchedPayload {
  /** The RESERVED observation id — the queue item's identity and, after a bind, the materialized
   *  `lab_observation.id`. The parent row does not exist yet (patient_id / provider_entity_id NOT NULL). */
  readonly observationId: string;
  readonly sourceMessageId: string;
  readonly organizationId: string;
  readonly loincCode: string;
  readonly reason: "no_patient_match";
  readonly receivedAt: string;
  readonly candidatePatientId: string | null;
  readonly candidateMatchLevel: string;
}

/** The M22 document-upload handshake for an OBX-5 embedded PDF (§9 D7). */
export interface LabPdfHandshakePayload {
  readonly organizationId: string;
  readonly requestingModule: "m29";
  readonly backRef: {
    readonly kind: "lab_observation";
    readonly observationId: string;
    readonly orderId: string | null;
    readonly patientId: string;
  };
  readonly mimeType: "application/pdf";
  readonly retentionClass: "clinical_record";
  readonly payloadBase64: string;
  readonly sourceLabel: string;
}

export type LabOutboxEvent =
  | { readonly name: "m29.lab_observation.received"; readonly payload: LabReceivedPayload }
  | { readonly name: "m29.lab_observation.attached"; readonly payload: LabAttachedPayload }
  | { readonly name: "m29.lab_observation.abnormal_flag"; readonly payload: LabAbnormalFlagPayload }
  | { readonly name: "m29.document.upload_requested"; readonly payload: LabPdfHandshakePayload };

/** The attach outcome: the rows to insert atomically + the events to publish after commit. */
export type LabAttachPlan =
  | {
      readonly kind: "attach";
      readonly observation: NewLabObservationRow;
      readonly values: readonly NewLabObservationValueRow[];
      readonly link: NewLabObservationInboundLinkRow;
      readonly events: readonly LabOutboxEvent[];
    }
  | {
      /**
       * The §4.2 review-queue ENTRY: the OBX value rows under the reserved observation id + the link row
       * that IS the queue item. No `observation` — the parent materializes at manual bind (GAP-044).
       */
      readonly kind: "unmatched";
      readonly values: readonly NewLabObservationValueRow[];
      readonly link: NewLabObservationInboundLinkRow;
      readonly event: {
        readonly name: "m29.lab_observation.unmatched";
        readonly payload: LabUnmatchedPayload;
      };
    };

export interface LabAttachInput {
  readonly organizationId: string;
  readonly sourceMessageId: string;
  /** ARCH-011 — the matched patient's agency (resolved by the T08 worker); required on a matched attach. */
  readonly providerEntityId: string;
  readonly locationId?: string | null;
  readonly obr: ProjectedObr;
  readonly obxList: readonly ProjectedObx[];
  readonly resolution: LabPatientResolution;
  readonly terminologyValidation: LabTerminologyValidation;
  readonly sudRedacted: boolean;
  readonly pdfAttachments: readonly ExtractedPdf[];
  // ── Caller-supplied identity + clock (determinism) ──
  readonly observationId: string;
  readonly linkId: string;
  readonly receivedAt: Date;
}

const VALUE_TYPE_SET: ReadonlySet<string> = new Set<string>(LAB_VALUE_TYPES);

/** Coerce a raw OBX-2 to the `lab_value_type` enum; unknown (non-ED) types fall back to `ST` (string). */
function mapValueType(raw: string): LabValueType {
  const upper = raw.trim().toUpperCase();
  return VALUE_TYPE_SET.has(upper) ? (upper as LabValueType) : "ST";
}

/** Map an HL7 result-status token (OBR-25 / OBX-11) to `lab_result_status`; default `final` for a resulted ORU. */
function mapResultStatus(raw: string): LabResultStatus {
  switch (raw.trim().toUpperCase()) {
    case "P":
      return "preliminary";
    case "C":
      return "corrected";
    case "X":
      return "cancelled";
    case "F":
      return "final";
    default:
      return "final";
  }
}

/** The observation-level LOINC (OBR-4 universal service id; falls back to the first OBX-3). */
function observationLoinc(
  obr: ProjectedObr,
  obxList: readonly ProjectedObx[],
): { code: string; text: string } {
  if (obr.universalServiceCode) {
    return {
      code: obr.universalServiceCode,
      text: obr.universalServiceText || obr.universalServiceCode,
    };
  }
  const first = obxList.find((o) => o.loincCode !== "");
  const code = first?.loincCode ?? "";
  return { code, text: first?.loincText || code };
}

/** Build the N `lab_observation_value` rows (every OBX except the embedded-PDF ED segments). */
function buildValueRows(input: LabAttachInput): NewLabObservationValueRow[] {
  const rows: NewLabObservationValueRow[] = [];
  for (const obx of input.obxList) {
    if (obx.valueType === OBX_ENCAPSULATED_DATA_TYPE) continue; // PDFs → M22 handshake, not a value row
    const valueType = mapValueType(obx.valueType);
    const isNumeric = valueType === "NM" || valueType === "SN";
    const rawValue = obx.value.trim();
    const parsedNumeric =
      isNumeric && rawValue !== "" && Number.isFinite(Number(rawValue)) ? rawValue : null;
    rows.push({
      organizationId: input.organizationId,
      observationId: input.observationId,
      obxSetId: obx.setId,
      loincCode: obx.loincCode,
      loincDisplayText: obx.loincText || obx.loincCode,
      terminologyValidation: input.terminologyValidation,
      valueType,
      numericValue: input.sudRedacted ? null : parsedNumeric,
      stringValue: input.sudRedacted
        ? SUD_REDACTED_SENTINEL
        : parsedNumeric === null
          ? rawValue || null
          : null,
      units: obx.units || null,
      referenceRange: obx.referenceRange || null,
      abnormalFlag: selectValueFlag(obx.abnormalFlagsRaw),
      performedAt: null,
      receivedAt: input.receivedAt,
    });
  }
  return rows;
}

/** Plan the attach (matched) or the unmatched routing for an inbound ORU lab (D7). */
export function planLabAttach(input: LabAttachInput): LabAttachPlan {
  const loinc = observationLoinc(input.obr, input.obxList);
  const observationDatetime = input.obr.observationDate
    ? new Date(input.obr.observationDate)
    : input.receivedAt;

  // ─── Unmatched: the parent observation is DEFERRED, the queue entry is not (GAP-044) ──
  // The values land under the reserved id so the reviewer can read the actual results (§5.2.4), and the
  // link row is the queue item the §4.2 routes act on. `lab_observation_value` carries its own
  // organization_id, RLS policy and audit trigger and references its parent logically (no FK across the
  // partition edge), so writing children ahead of a parent that may never exist is legal by construction.
  if (input.resolution.kind === "unmatched") {
    return {
      kind: "unmatched",
      values: buildValueRows(input),
      link: {
        id: input.linkId,
        organizationId: input.organizationId,
        observationId: input.observationId,
        sourceMessageId: input.sourceMessageId,
        sourceOrderId: null,
        obrPlacerOrderNumber: input.obr.placerOrderNumber || null,
        matchMethod: "unmatched",
        matchConfidence:
          input.resolution.matchConfidence === null
            ? null
            : input.resolution.matchConfidence.toFixed(3),
        candidatePatientId: input.resolution.candidatePatientId,
        candidateMatchLevel: input.resolution
          .candidateMatchLevel as NewLabObservationInboundLinkRow["candidateMatchLevel"],
      },
      event: {
        name: "m29.lab_observation.unmatched",
        payload: {
          observationId: input.observationId,
          sourceMessageId: input.sourceMessageId,
          organizationId: input.organizationId,
          loincCode: loinc.code,
          reason: "no_patient_match",
          receivedAt: input.receivedAt.toISOString(),
          candidatePatientId: input.resolution.candidatePatientId,
          candidateMatchLevel: input.resolution.candidateMatchLevel,
        },
      },
    };
  }

  // ─── Matched (OBR-2 placer or confident cascade): materialize the observation ──
  const { patientId } = input.resolution;
  const orderId = input.resolution.orderId;
  const valueRows = buildValueRows(input);
  const abnormalSummary: LabAbnormalSummary = computeAbnormalSummary(
    valueRows.map((v) => v.abnormalFlag ?? null),
  );
  const topFlag: LabAbnormalFlag | null = selectValueFlag(
    input.obxList.flatMap((o) => o.abnormalFlagsRaw),
  );
  const resultStatus = mapResultStatus(
    input.obr.resultStatusRaw || input.obxList[0]?.resultStatusRaw || "",
  );

  const observation: NewLabObservationRow = {
    id: input.observationId,
    organizationId: input.organizationId,
    providerEntityId: input.providerEntityId,
    locationId: input.locationId ?? null,
    sourceMessageId: input.sourceMessageId,
    patientId,
    orderId,
    observationDate: observationDatetime,
    collectionDate: null,
    resultStatus,
    loincCode: loinc.code,
    loincDisplayText: loinc.text,
    terminologyValidation: input.terminologyValidation,
    abnormalSummary,
    sudRedactedAtIngest: input.sudRedacted,
    receivedAt: input.receivedAt,
  };

  const link: NewLabObservationInboundLinkRow = {
    id: input.linkId,
    organizationId: input.organizationId,
    observationId: input.observationId,
    sourceMessageId: input.sourceMessageId,
    sourceOrderId: orderId,
    obrPlacerOrderNumber: input.obr.placerOrderNumber || null,
    matchMethod: input.resolution.matchMethod,
    matchConfidence: null,
    candidatePatientId: null,
    candidateMatchLevel: null,
  };

  const events: LabOutboxEvent[] = [
    {
      name: "m29.lab_observation.received",
      payload: {
        observationId: input.observationId,
        sourceMessageId: input.sourceMessageId,
        organizationId: input.organizationId,
        patientId,
        orderRecordId: orderId,
        matchMethod: input.resolution.matchMethod,
        terminologyValidation: input.terminologyValidation,
        sudRedacted: input.sudRedacted,
        abnormalSummary,
      },
    },
    {
      name: "m29.lab_observation.attached",
      payload: {
        observationId: input.observationId,
        organizationId: input.organizationId,
        patientId,
        orderRecordId: orderId,
        loincCode: loinc.code,
        abnormalFlag: topFlag,
        observationDatetime: observationDatetime.toISOString(),
      },
    },
  ];

  // D7 — a critical (HH/LL) flag pages the caseload RN via M36. Single-letter abnormal (H/L/A) does not.
  const criticalCount = input.obxList.filter((o) => isCriticalFlagSet(o.abnormalFlagsRaw)).length;
  if (criticalCount > 0) {
    events.push({
      name: "m29.lab_observation.abnormal_flag",
      payload: {
        observationId: input.observationId,
        organizationId: input.organizationId,
        patientId,
        loincCode: loinc.code,
        criticalCount,
      },
    });
  }

  // §9 — each embedded PDF becomes an M22 upload handshake (the back-ref fills attached_document_id at T08).
  for (const pdf of input.pdfAttachments) {
    events.push({
      name: "m29.document.upload_requested",
      payload: {
        organizationId: input.organizationId,
        requestingModule: "m29",
        backRef: {
          kind: "lab_observation",
          observationId: input.observationId,
          orderId,
          patientId,
        },
        mimeType: "application/pdf",
        retentionClass: "clinical_record",
        payloadBase64: pdf.payloadBase64,
        sourceLabel: `lab-report-obx-${pdf.obxSetId}`,
      },
    });
  }

  return { kind: "attach", observation, values: valueRows, link, events };
}
