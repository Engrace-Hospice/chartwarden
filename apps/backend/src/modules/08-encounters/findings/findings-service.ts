// apps/backend/src/modules/08-encounters/findings/findings-service.ts — WF09: the service interface behind the findings routes
// (ADLs, nutrition, weight history) and the DTOs it returns. The routes compose over this; an in-memory implementation
// (findings-memory.ts) backs the route tests and a Drizzle one (findings-drizzle.ts) runs in production under `withOrgContext`.
import type {
  AdlDevice,
  AdlItem,
  AdlLevel,
  AppetiteLevel,
  ContinenceLevel,
  FluidIntakeLevel,
  NutritionSupport,
  PriorRecordedAdl,
  RecordedAdl,
  RecordedNutrition,
  SwallowingLevel,
} from "@chartwarden/hearthnote";
import { type AdlColumns, type AdlInput, recordedAdlFromRow } from "./adl";
import type { NutritionColumns, NutritionInput } from "./nutrition";
import type { WeightHistoryView, WeightReading } from "./weight-history";

/**
 * The concurrency token of a stored findings record: the instant it was last written, as epoch milliseconds, or 0 when none is
 * recorded yet. It is returned on every read and write (`version` in the body, `ETag` on the response) and may be sent back in
 * `If-Match` on the next PUT: a PUT replaces the whole record, so a stale token is a 409 STALE_VERSION instead of a silent overwrite
 * of what another tab or clinician saved. The header is optional on these routes; without it a PUT behaves as it always did.
 */
export function recordVersionOf(updatedAt: Date | string | null): number {
  return updatedAt === null ? 0 : new Date(updatedAt).getTime();
}

/**
 * Whether two stored column sets hold the same record, field by field (a device list compares as written, which is its documented order
 * on both sides). The PUT uses it to leave an unchanged record, and its version, alone.
 */
export function sameColumns<C extends object>(a: C, b: C): boolean {
  return (Object.keys(a) as (keyof C)[]).every(
    (k) => JSON.stringify(a[k]) === JSON.stringify(b[k]),
  );
}

/** The ADL record as read back: unassessed items are absent from `items`, an unassessed continence field is null. */
export interface AdlView {
  readonly encounterId: string;
  /** The patient the visit is for: attributes the read to the patient in the §164.528 accounting. */
  readonly patientId: string;
  /** The record's concurrency token (see {@link recordVersionOf}). */
  readonly version: number;
  readonly items: Partial<Record<AdlItem, AdlLevel>>;
  readonly bladder: ContinenceLevel | null;
  readonly bowel: ContinenceLevel | null;
  readonly devices: AdlDevice[];
  readonly updatedAt: string;
}

/** The nutrition record as read back: every field is null when it was not assessed. */
export interface NutritionView {
  readonly encounterId: string;
  /** The patient the visit is for: attributes the read to the patient in the §164.528 accounting. */
  readonly patientId: string;
  /** The record's concurrency token (see {@link recordVersionOf}). */
  readonly version: number;
  readonly appetite: AppetiteLevel | null;
  readonly mealIntakePercent: number | null;
  readonly fluidIntake: FluidIntakeLevel | null;
  readonly swallowing: SwallowingLevel | null;
  readonly support: NutritionSupport | null;
  readonly updatedAt: string;
}

/** The recorded findings of one encounter, as the visit note's facts take them. A finding with nothing recorded is absent. */
export interface RecordedFindings {
  readonly adl?: RecordedAdl;
  readonly nutrition?: RecordedNutrition;
  /** The patient's weight on an earlier encounter, for the note's `RecordedVitals.priorWeight`. */
  readonly priorWeight?: WeightReading;
  /** The ADL levels of the patient's previous signed visit that assessed any, for the note's change in dependence. */
  readonly priorAdl?: PriorRecordedAdl;
}

export interface FindingsService {
  /** The ADL record of an encounter, or null when none was recorded. 404 when the encounter is not visible. */
  getAdl(organizationId: string, encounterId: string): Promise<AdlView | null>;
  /**
   * Replace the whole ADL record (idempotent upsert) while the encounter is a DRAFT: 422 on a bad value or when the encounter's
   * template has no section that states ADLs, 404 when the encounter is not visible, 409 IMMUTABLE_AFTER_SIGN once it is signed,
   * cosigned or void and 409 NOTE_PINNED_AT_FINALIZE once it is finalized (the note text is pinned then, so a later change
   * would leave the record disagreeing with the note). `ifMatch` is the OPTIONAL precondition: the `version` last read (0 for
   * "no record yet"); a stale one is 409 STALE_VERSION and nothing is written.
   */
  putAdl(
    organizationId: string,
    encounterId: string,
    input: AdlInput,
    actorMembershipId: string,
    ifMatch?: number,
  ): Promise<AdlView>;
  getNutrition(organizationId: string, encounterId: string): Promise<NutritionView | null>;
  /** As {@link putAdl}, for the nutrition record. */
  putNutrition(
    organizationId: string,
    encounterId: string,
    input: NutritionInput,
    actorMembershipId: string,
    ifMatch?: number,
  ): Promise<NutritionView>;
  /** This visit's weight, the previous visit's, and the last six. 404 when the encounter is not visible. */
  getWeightHistory(organizationId: string, encounterId: string): Promise<WeightHistoryView>;
}

const isoOf = (value: Date | string): string =>
  typeof value === "string" ? value : value.toISOString();

export function adlViewOf(
  encounterId: string,
  patientId: string,
  columns: AdlColumns,
  updatedAt: Date | string,
): AdlView {
  const recorded = recordedAdlFromRow(columns);
  return {
    encounterId,
    patientId,
    version: recordVersionOf(updatedAt),
    items: { ...(recorded.items ?? {}) },
    bladder: columns.bladder,
    bowel: columns.bowel,
    devices: [...columns.devices],
    updatedAt: isoOf(updatedAt),
  };
}

export function nutritionViewOf(
  encounterId: string,
  patientId: string,
  columns: NutritionColumns,
  updatedAt: Date | string,
): NutritionView {
  return {
    encounterId,
    patientId,
    version: recordVersionOf(updatedAt),
    ...columns,
    updatedAt: isoOf(updatedAt),
  };
}
