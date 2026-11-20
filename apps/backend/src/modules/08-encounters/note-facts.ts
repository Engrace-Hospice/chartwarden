// apps/backend/src/modules/08-encounters/note-facts.ts — WF09: what a visit note states beyond the clinician's own selections.
//
// A note's Layer-1 text is the selections plus FACTS read from the visit: the vitals captured on it (with the weight on the previous
// signed visit), the ADLs and nutrition recorded on it, the wounds M9 holds for it and the fall it follows up. This is the one place
// those are read and assembled into the `NoteFacts` the assembler takes, for every path that renders a note (the draft preview, the
// finalize pin, the render payload). It owns no state: a reader over the database and the two seams (M9 wounds, M30 falls).
//
// The seams open their own tenant context, so they are read OUTSIDE any open transaction: callers read wounds first and hand the
// result to {@link NoteFactsReader.factsFor}. A caller whose note is already PINNED reads none of this: the pin is the note.
import { type DbClient, organizationTimezone, schema } from "@chartwarden/db";
import type { RecordedVitals, RecordedWound } from "@chartwarden/hearthnote";
import { localDateInTimeZone } from "@chartwarden/shared/dates";
import { withOrgContext } from "@chartwarden/tenancy";
import { desc, eq } from "drizzle-orm";
import { recordedVitalsFrom } from "./authoring/index";
import { loadEncounterRow } from "./encounter-row";
import { loadRecordedFindings } from "./findings/index";
import {
  type FallChoice,
  type FallIncidentReader,
  fallChoicesFor,
  fallLookbackStart,
} from "./routes/fall-link";
import type { NoteFacts } from "./routes/service";
import type { WoundNoteReader } from "./wound-reader";

const VITALS = schema.vitals;

export interface NoteFactsReader {
  /**
   * Everything the note states beyond the selections: the vitals (with the prior signed weight), the ADLs and nutrition, the
   * `wounds` the caller read first, and the linked fall.
   */
  factsFor(
    t: DbClient,
    organizationId: string,
    r: { readonly id: string; readonly fallOccurredOn: string | null },
    wounds: readonly RecordedWound[],
  ): Promise<NoteFacts>;
  /** The wounds recorded on this encounter's visit, through M9's seam. Call it OUTSIDE any open transaction, and only for an unpinned note. */
  woundsFor(args: {
    readonly organizationId: string;
    readonly encounterId: string;
    readonly patientId: string;
  }): Promise<readonly RecordedWound[]>;
  /** The recorded falls this encounter's visit can follow up, through M30's seam (read outside any open transaction: one short read for the scope, then the seam). */
  fallChoicesFor(
    organizationId: string,
    encounterId: string,
    actorMembershipId: string | null,
  ): Promise<readonly FallChoice[]>;
}

/** The vitals the note states: every set captured on the encounter, newest capture first, merged per measurement. */
async function recordedVitalsFor(t: DbClient, encounterId: string): Promise<RecordedVitals> {
  const rows = await t
    .select({
      bpSystolic: VITALS.bpSystolic,
      bpDiastolic: VITALS.bpDiastolic,
      heartRate: VITALS.heartRate,
      respiratoryRate: VITALS.respiratoryRate,
      temperature: VITALS.temperature,
      temperatureUnit: VITALS.temperatureUnit,
      spo2: VITALS.spo2,
      painScore: VITALS.painScore,
      weight: VITALS.weight,
      weightUnit: VITALS.weightUnit,
      height: VITALS.height,
      heightUnit: VITALS.heightUnit,
    })
    .from(VITALS)
    .where(eq(VITALS.encounterId, encounterId))
    .orderBy(desc(VITALS.capturedAt), desc(VITALS.id));
  return recordedVitalsFrom(rows);
}

/**
 * Everything the note states beyond the selections that M8's own tables hold (the vitals with the prior signed weight, the ADLs and
 * nutrition, the linked fall), plus the `wounds` the caller read through M9's seam. One reader for every path that renders a note: the
 * selections preview, the finalize pin and the visit-note draft, so none of them can state less than another.
 */
export async function readRecordedFacts(
  t: DbClient,
  organizationId: string,
  r: { readonly id: string; readonly fallOccurredOn: string | null },
  wounds: readonly RecordedWound[],
): Promise<NoteFacts> {
  const findings = await loadRecordedFindings(t, { organizationId, encounterId: r.id });
  const vitals = await recordedVitalsFor(t, r.id);
  return {
    recordedVitals:
      findings.priorWeight === undefined
        ? vitals
        : { ...vitals, priorWeight: findings.priorWeight },
    ...(findings.adl === undefined ? {} : { recordedAdl: findings.adl }),
    ...(findings.nutrition === undefined ? {} : { recordedNutrition: findings.nutrition }),
    ...(wounds.length === 0 ? {} : { recordedWounds: wounds }),
    ...(r.fallOccurredOn === null ? {} : { linkedFall: { occurredOn: r.fallOccurredOn } }),
  };
}

export function createNoteFactsReader(deps: {
  readonly db: DbClient;
  readonly woundReader: WoundNoteReader;
  readonly fallReader: FallIncidentReader;
}): NoteFactsReader {
  const { db, woundReader, fallReader } = deps;

  return {
    factsFor: readRecordedFacts,

    woundsFor: (args) => woundReader.woundsForEncounter(args),

    async fallChoicesFor(organizationId, encounterId, actorMembershipId) {
      const scope = await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEncounterRow(t, encounterId);
        return {
          patientId: r.patientId,
          serviceDate: r.serviceDate,
          timeZone: await organizationTimezone(t, organizationId),
        };
      });
      const falls = await fallReader.recentFalls({
        organizationId,
        patientId: scope.patientId,
        actorMembershipId,
        occurredAfter: fallLookbackStart(scope.serviceDate),
      });
      return fallChoicesFor(falls, scope.serviceDate, (at) =>
        localDateInTimeZone(at, scope.timeZone),
      );
    },
  };
}
