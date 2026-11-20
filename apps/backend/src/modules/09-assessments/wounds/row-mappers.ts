// apps/backend/src/modules/09-assessments/wounds/row-mappers.ts — Drizzle rows of `wound` / `wound_observation` to the
// domain records (./projection). The columns are text + CHECK, so a stored value is always inside its value set; the
// casts below restate what the CHECK constraints (migrations 1528 / 1529) already guarantee. Numeric columns arrive from
// the driver as strings and are read as numbers.
import type {
  ExudateAmount,
  ExudateType,
  PeriwoundCondition,
  PressureStage,
  WoundAcquired,
  WoundBedTissue,
  WoundCorrectionReason,
  WoundDressing,
  WoundEtiology,
  WoundLaterality,
  WoundObservationStatus,
  WoundOdor,
  WoundStatus,
  WoundTrend,
} from "@chartwarden/assessments";
import type { schema } from "@chartwarden/db";
import type { WoundObservationRecord, WoundRecord } from "./projection";

const toIso = (v: Date | string): string =>
  v instanceof Date ? v.toISOString() : new Date(v).toISOString();
const toNumber = (v: string | number | null): number | null => (v === null ? null : Number(v));

export function woundRecordOf(r: typeof schema.wounds.$inferSelect): WoundRecord {
  return {
    id: r.id,
    organizationId: r.organizationId,
    patientId: r.patientId,
    siteCode: r.siteCode,
    laterality: r.laterality as WoundLaterality,
    etiology: r.etiology as WoundEtiology,
    acquired: r.acquired as WoundAcquired,
    onsetOn: r.onsetOn,
    status: r.status as WoundStatus,
    closedOn: r.closedOn,
    createdByMembershipId: r.createdByMembershipId,
    createdAt: toIso(r.createdAt),
  };
}

export function woundObservationRecordOf(
  r: typeof schema.woundObservations.$inferSelect,
): WoundObservationRecord {
  return {
    id: r.id,
    organizationId: r.organizationId,
    woundId: r.woundId,
    patientId: r.patientId,
    observedAt: toIso(r.observedAt),
    observedByMembershipId: r.observedByMembershipId,
    sourceEncounterId: r.sourceEncounterId,
    stage: r.stage as PressureStage | null,
    lengthCm: toNumber(r.lengthCm),
    widthCm: toNumber(r.widthCm),
    depthCm: toNumber(r.depthCm),
    undermining: r.undermining,
    woundBed: r.woundBed as WoundBedTissue[],
    exudateAmount: r.exudateAmount as ExudateAmount | null,
    exudateType: r.exudateType as ExudateType | null,
    odor: r.odor as WoundOdor | null,
    periwound: r.periwound as PeriwoundCondition[],
    painScore: r.painScore,
    dressing: r.dressing as WoundDressing | null,
    dressingChanged: r.dressingChanged,
    infectionSigns: r.infectionSigns,
    trend: r.trend as WoundTrend | null,
    status: r.status as WoundObservationStatus,
    correctsObservationId: r.correctsObservationId,
    correctionReason: r.correctionReason as WoundCorrectionReason | null,
    version: r.version,
    createdAt: toIso(r.createdAt),
  };
}
