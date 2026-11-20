// apps/backend/src/modules/09-assessments/wounds/projection.ts — the stored shapes of a wound and of an observation as the
// domain types them (numbers, not driver strings), and the one place they are projected to the service views. The
// Drizzle service maps rows to these records; the in-memory service keeps them. Computed measures (area, percent change)
// are made here, at read time, and never stored.
import {
  type ExudateAmount,
  type ExudateType,
  type PeriwoundCondition,
  type PressureStage,
  type WoundAcquired,
  type WoundBedTissue,
  type WoundCorrectionReason,
  type WoundDressing,
  type WoundEtiology,
  type WoundLaterality,
  type WoundObservationFields,
  type WoundObservationStatus,
  type WoundOdor,
  type WoundStatus,
  type WoundTrend,
  siteLabel,
  withComputedMeasures,
  woundAreaCm2,
} from "@chartwarden/assessments";
import type { WoundObservationDto, WoundView } from "./service";

export interface WoundRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly siteCode: string;
  readonly laterality: WoundLaterality;
  readonly etiology: WoundEtiology;
  readonly acquired: WoundAcquired;
  readonly onsetOn: string | null;
  readonly status: WoundStatus;
  readonly closedOn: string | null;
  readonly createdByMembershipId: string;
  readonly createdAt: string;
}

export interface WoundObservationRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly woundId: string;
  readonly patientId: string;
  readonly observedAt: string;
  readonly observedByMembershipId: string;
  readonly sourceEncounterId: string | null;
  readonly stage: PressureStage | null;
  readonly lengthCm: number | null;
  readonly widthCm: number | null;
  readonly depthCm: number | null;
  readonly undermining: boolean | null;
  readonly woundBed: readonly WoundBedTissue[];
  readonly exudateAmount: ExudateAmount | null;
  readonly exudateType: ExudateType | null;
  readonly odor: WoundOdor | null;
  readonly periwound: readonly PeriwoundCondition[];
  readonly painScore: number | null;
  readonly dressing: WoundDressing | null;
  readonly dressingChanged: boolean | null;
  readonly infectionSigns: boolean | null;
  readonly trend: WoundTrend | null;
  readonly status: WoundObservationStatus;
  readonly correctsObservationId: string | null;
  readonly correctionReason: WoundCorrectionReason | null;
  readonly version: number;
  readonly createdAt: string;
}

export function toWoundView(w: WoundRecord): WoundView {
  return {
    id: w.id,
    patientId: w.patientId,
    siteCode: w.siteCode,
    laterality: w.laterality,
    site: siteLabel(w.siteCode, w.laterality),
    etiology: w.etiology,
    acquired: w.acquired,
    onsetOn: w.onsetOn,
    status: w.status,
    closedOn: w.closedOn,
    createdAt: w.createdAt,
  };
}

const newestFirst = (a: WoundObservationRecord, b: WoundObservationRecord): number =>
  a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : a.id < b.id ? 1 : -1;

/**
 * One wound's observations as views, newest first. The percent change runs over the CURRENT (active) observations only; a
 * superseded one is shown (when asked for) with its own area and no percentage. The caller passes only that wound's rows.
 */
export function toObservationDtos(
  records: readonly WoundObservationRecord[],
  options: { readonly includeSuperseded: boolean },
): WoundObservationDto[] {
  const active = records.filter((r) => r.status === "active");
  const computedById = new Map(withComputedMeasures(active).map((c) => [c.id, c]));
  const shown = options.includeSuperseded ? records : active;
  return [...shown].sort(newestFirst).map((r): WoundObservationDto => {
    const computed = computedById.get(r.id);
    return {
      id: r.id,
      woundId: r.woundId,
      patientId: r.patientId,
      observedAt: r.observedAt,
      observedByMembershipId: r.observedByMembershipId,
      sourceEncounterId: r.sourceEncounterId,
      stage: r.stage,
      lengthCm: r.lengthCm,
      widthCm: r.widthCm,
      depthCm: r.depthCm,
      undermining: r.undermining,
      woundBed: r.woundBed,
      exudateAmount: r.exudateAmount,
      exudateType: r.exudateType,
      odor: r.odor,
      periwound: r.periwound,
      painScore: r.painScore,
      dressing: r.dressing,
      dressingChanged: r.dressingChanged,
      infectionSigns: r.infectionSigns,
      trend: r.trend,
      status: r.status,
      correctsObservationId: r.correctsObservationId,
      correctionReason: r.correctionReason,
      version: r.version,
      createdAt: r.createdAt,
      areaCm2: computed?.areaCm2 ?? woundAreaCm2(r.lengthCm, r.widthCm),
      areaChangePercent: computed?.areaChangePercent ?? null,
      areaChangeSinceObservedAt: computed?.areaChangeSinceObservedAt ?? null,
    };
  });
}

/** The clinical values of an observation as stored: an absent value is null, an absent list is empty. */
export type ObservationValues = Pick<
  WoundObservationRecord,
  | "stage"
  | "lengthCm"
  | "widthCm"
  | "depthCm"
  | "undermining"
  | "woundBed"
  | "exudateAmount"
  | "exudateType"
  | "odor"
  | "periwound"
  | "painScore"
  | "dressing"
  | "dressingChanged"
  | "infectionSigns"
  | "trend"
>;

export function observationValuesOf(f: WoundObservationFields): ObservationValues {
  return {
    stage: f.stage ?? null,
    lengthCm: f.lengthCm ?? null,
    widthCm: f.widthCm ?? null,
    depthCm: f.depthCm ?? null,
    undermining: f.undermining ?? null,
    woundBed: f.woundBed ?? [],
    exudateAmount: f.exudateAmount ?? null,
    exudateType: f.exudateType ?? null,
    odor: f.odor ?? null,
    periwound: f.periwound ?? [],
    painScore: f.painScore ?? null,
    dressing: f.dressing ?? null,
    dressingChanged: f.dressingChanged ?? null,
    infectionSigns: f.infectionSigns ?? null,
    trend: f.trend ?? null,
  };
}
