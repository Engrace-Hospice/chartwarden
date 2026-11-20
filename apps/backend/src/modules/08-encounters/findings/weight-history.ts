// apps/backend/src/modules/08-encounters/findings/weight-history.ts — WF09: the patient's recorded weights, for the visit note
// ("down 2 lb since the last visit") and the weight screen.
//
// Weight is captured with the vitals set (`vitals.weight` / `weight_unit`, one or more sets per encounter). This reads those, across
// the patient's encounters, and answers three things for ONE encounter:
//   current  the weight recorded on this encounter (its latest set that has one), or null
//   prior    the most recent weight recorded on an EARLIER encounter of the same patient (an earlier service date than this
//            encounter's) that is SIGNED: the `RecordedVitals["priorWeight"]` the note states
//   history  the last {@link WEIGHT_HISTORY_LIMIT} weights, newest first, one per encounter, this encounter's included
// Only signed, cosign-pending and cosigned encounters of the patient count as earlier visits. A draft or finalized note is still
// its author's working copy (another clinician's unsigned weight is neither final nor theirs to pin into this note's legal text),
// and a void one never happened; this visit's own weight always shows, whatever its status short of void.
// A weight is "recorded" by the one rule the note's own weight uses (`parseWeight`): a positive number AND its unit, kg or lb.
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import type { RecordedVitals } from "@chartwarden/hearthnote";
import { NotFoundError } from "@chartwarden/types";
import { and, desc, eq, inArray, isNotNull, lt, ne, or } from "drizzle-orm";
import { parseWeight, unitlessMeasurements } from "../authoring/measurements";

const ENC = schema.encounters;
const VITALS = schema.vitals;

/** One recorded weight, in the shape the note's `priorWeight` takes: value as stored, its unit, and the service date it was taken on. */
export type WeightReading = NonNullable<RecordedVitals["priorWeight"]>;

/** The three answers about one encounter's weight; see the file header. */
export interface WeightSummary {
  readonly current: WeightReading | null;
  readonly prior: WeightReading | null;
  readonly history: WeightReading[];
}

/**
 * {@link WeightHistory} plus whether THIS encounter holds a weight that cannot be stated because its unit is missing or not kg|lb (a
 * legacy row): such a weight is left out of `current`, `prior` and `history` and the note, so the screen tells the author to re-enter it.
 */
export interface WeightHistoryView extends WeightHistory {
  readonly weightUnitMissing: boolean;
}

/** {@link WeightSummary} as the route returns it: with the patient it is about, which attributes the read in the §164.528 accounting. */
export interface WeightHistory extends WeightSummary {
  readonly patientId: string;
}

/** One vitals set joined to its encounter's service date. */
export interface WeightSetRow {
  readonly encounterId: string;
  /** The encounter's org-local service date, `YYYY-MM-DD`. */
  readonly serviceDate: string;
  readonly capturedAt: Date | string;
  readonly weight: string | null;
  readonly weightUnit: string | null;
}

export const WEIGHT_HISTORY_LIMIT = 6;

/** The statuses of an EARLIER encounter whose weight counts: signed, awaiting a cosignature, or cosigned. */
export const SIGNED_NOTE_STATUSES = ["signed", "cosign_pending", "cosigned"] as const;

/**
 * The most vitals sets read for one answer. The six readings come from distinct encounters, so this only falls short for a patient
 * whose newest encounters carry dozens of weight sets each; the screen then shows fewer than six points, never a wrong one.
 * ponytail: a window function (row_number per encounter) would lift the cap; not worth a raw query for that case.
 */
const WEIGHT_SET_READ_CAP = 60;

const instantOf = (value: Date | string): number => new Date(value).getTime();

function isRecorded(
  row: WeightSetRow,
): row is WeightSetRow & { weight: string; weightUnit: string } {
  return parseWeight(row.weight, row.weightUnit) !== null;
}

/**
 * Reduce the vitals sets of one patient (this encounter's, plus those of its earlier-dated, signed encounters) to the three answers.
 * The caller filters to those encounters; this orders (service date, then capture time, newest first), keeps each encounter's latest
 * recorded weight, and cuts the history.
 */
export function summariseWeights(
  rows: readonly WeightSetRow[],
  encounterId: string,
  limit: number = WEIGHT_HISTORY_LIMIT,
): WeightSummary {
  const newestFirst = rows
    .filter(isRecorded)
    .sort(
      (a, b) =>
        b.serviceDate.localeCompare(a.serviceDate) ||
        instantOf(b.capturedAt) - instantOf(a.capturedAt),
    );
  const seen = new Set<string>();
  const readings: { readonly encounterId: string; readonly reading: WeightReading }[] = [];
  for (const row of newestFirst) {
    if (seen.has(row.encounterId)) continue;
    seen.add(row.encounterId);
    readings.push({
      encounterId: row.encounterId,
      reading: { value: row.weight.trim(), unit: row.weightUnit, on: row.serviceDate },
    });
  }
  return {
    current: readings.find((r) => r.encounterId === encounterId)?.reading ?? null,
    prior: readings.find((r) => r.encounterId !== encounterId)?.reading ?? null,
    history: readings.slice(0, limit).map((r) => r.reading),
  };
}

/**
 * Read the weight history of one encounter inside the caller's org-scoped transaction (RLS scopes every row by tenant; the
 * organization filter is the explicit second lock). A missing or cross-tenant encounter is the non-leaking 404.
 */
export async function readWeightHistory(
  tx: DbClient,
  args: { readonly organizationId: string; readonly encounterId: string },
  limit: number = WEIGHT_HISTORY_LIMIT,
): Promise<WeightHistory> {
  const { organizationId, encounterId } = args;
  const [encounter] = await tx
    .select({ patientId: ENC.patientId, serviceDate: ENC.serviceDate })
    .from(ENC)
    .where(and(eq(ENC.id, encounterId), eq(ENC.organizationId, organizationId)))
    .limit(1);
  if (!encounter) throw new NotFoundError("encounter");
  const rows = await tx
    .select({
      encounterId: VITALS.encounterId,
      serviceDate: ENC.serviceDate,
      capturedAt: VITALS.capturedAt,
      weight: VITALS.weight,
      weightUnit: VITALS.weightUnit,
    })
    .from(VITALS)
    .innerJoin(ENC, eq(ENC.id, VITALS.encounterId))
    .where(
      and(
        eq(ENC.organizationId, organizationId),
        eq(ENC.patientId, encounter.patientId),
        ne(ENC.status, "voided"),
        isNotNull(VITALS.weight),
        isNotNull(VITALS.weightUnit),
        or(
          eq(ENC.id, encounterId),
          and(
            lt(ENC.serviceDate, encounter.serviceDate),
            inArray(ENC.status, [...SIGNED_NOTE_STATUSES]),
          ),
        ),
      ),
    )
    .orderBy(desc(ENC.serviceDate), desc(VITALS.capturedAt))
    .limit(WEIGHT_SET_READ_CAP);
  return { patientId: encounter.patientId, ...summariseWeights(rows, encounterId, limit) };
}

/** Whether this encounter's own vitals hold a weight with no usable unit (see {@link WeightHistoryView}). */
export async function readWeightUnitMissing(
  tx: DbClient,
  args: { readonly organizationId: string; readonly encounterId: string },
): Promise<boolean> {
  const rows = await tx
    .select({ weight: VITALS.weight, weightUnit: VITALS.weightUnit })
    .from(VITALS)
    .innerJoin(ENC, eq(ENC.id, VITALS.encounterId))
    .where(
      and(eq(ENC.organizationId, args.organizationId), eq(VITALS.encounterId, args.encounterId)),
    );
  return unitlessMeasurements(rows).weightUnitMissing;
}
