// apps/backend/src/modules/09-assessments/wounds/service.ts — the longitudinal-wound route service: its views, its inputs,
// and the port the routes compose over. `createDbWoundService` (./service-db) is the production implementation;
// `createInMemoryWoundService` (./service-memory) backs the route tests and a database-less boot.
//
// A patient has wounds; each visit adds dated observations to a wound; a correction appends a superseding observation
// (the M9 convention — values are never updated). `organizationId` always comes from the server-assembled request context.
import type {
  ComputedMeasures,
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
  WoundObservationFields,
  WoundObservationStatus,
  WoundOdor,
  WoundResolution,
  WoundStatus,
  WoundTrend,
} from "@chartwarden/assessments";

/** Who acts: the org, the Better Auth user (attributes the write-audit row) and the active membership (authors the row). */
export interface WoundWriteActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly membershipId: string;
}

export interface CreateWoundInput {
  readonly siteCode: string;
  readonly laterality: WoundLaterality;
  readonly etiology: WoundEtiology;
  readonly acquired?: WoundAcquired;
  readonly onsetOn?: string | null;
}

export interface RecordObservationInput extends WoundObservationFields {
  /** ISO instant; defaults to now. */
  readonly observedAt?: string;
  /** The encounter (M8 visit note) this was recorded at; a logical uuid. */
  readonly sourceEncounterId?: string | null;
}

export interface CorrectObservationInput extends RecordObservationInput {
  readonly correctionReason: WoundCorrectionReason;
}

export interface ResolveWoundInput {
  readonly status: WoundResolution;
  /** ISO date; defaults to today (organisation-local). */
  readonly closedOn?: string;
}

export type WoundStatusFilter = WoundStatus | "all";

export interface WoundView {
  readonly id: string;
  readonly patientId: string;
  readonly siteCode: string;
  readonly laterality: WoundLaterality;
  /** The display phrase for the location ("left heel"). */
  readonly site: string;
  readonly etiology: WoundEtiology;
  readonly acquired: WoundAcquired;
  readonly onsetOn: string | null;
  readonly status: WoundStatus;
  readonly closedOn: string | null;
  readonly createdAt: string;
}

export interface WoundObservationDto extends ComputedMeasures {
  readonly id: string;
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

export interface WoundListItem extends WoundView {
  /** The wound's newest current observation, with its computed measures; null before the first one. */
  readonly latestObservation: WoundObservationDto | null;
}

export interface WoundDetail {
  readonly wound: WoundView;
  /** Newest first. Current observations only unless `includeSuperseded`. */
  readonly observations: readonly WoundObservationDto[];
}

export interface WoundRouteService {
  listWounds(
    organizationId: string,
    patientId: string,
    status: WoundStatusFilter,
  ): Promise<{ readonly wounds: readonly WoundListItem[] }>;
  getWound(
    organizationId: string,
    patientId: string,
    woundId: string,
    options: { readonly includeSuperseded: boolean },
  ): Promise<WoundDetail>;
  createWound(
    actor: WoundWriteActor,
    patientId: string,
    input: CreateWoundInput,
  ): Promise<WoundView>;
  recordObservation(
    actor: WoundWriteActor,
    patientId: string,
    woundId: string,
    input: RecordObservationInput,
  ): Promise<WoundObservationDto>;
  /** Appends an observation that supersedes `observationId` (which must be current, at `ifVersion`). */
  correctObservation(
    actor: WoundWriteActor,
    patientId: string,
    woundId: string,
    observationId: string,
    ifVersion: number,
    input: CorrectObservationInput,
  ): Promise<WoundObservationDto>;
  resolveWound(
    actor: WoundWriteActor,
    patientId: string,
    woundId: string,
    input: ResolveWoundInput,
  ): Promise<WoundView>;
}

/** Wounds a patient chart lists at most (a chart holds a handful; the cap is a guard, not a page size). */
export const MAX_WOUNDS_LISTED = 200;
/** Observations of one wound a detail read returns at most. */
export const MAX_OBSERVATIONS_LISTED = 1000;
