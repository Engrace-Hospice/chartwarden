// apps/backend/src/modules/08-encounters/drafting/ports.ts — the narrow interfaces the draft computation reads
// through (S1 PR C2a). Unit tests pass fakes; `defaultDraftPorts()` (default-ports.ts) wires the seam-backed half
// from the M1 registry, and PR C2b supplies the store-backed half over the M8 tables.
import type { AssemblyContext, SelectionState, VitalsDraftInput } from "@chartwarden/hearthnote";
import type {
  CarePlanElementsAudience,
  EncounterDiscipline,
  EncounterType,
  InterventionDiscipline,
  MedicationOrderChange,
  RelevantCarePlanElements,
  ScaleSeries,
  ScaleType,
} from "@chartwarden/types";

/** What the draft needs of an encounter row (a projection, so a test needs no database row). */
export interface DraftEncounter {
  readonly id: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly encounterType: EncounterType;
  readonly discipline: EncounterDiscipline;
  /** Org-local calendar day, `YYYY-MM-DD`. */
  readonly serviceDate: string;
  readonly startedAt: Date | null;
  readonly clockStartedAt: Date | null;
}

/**
 * Whoever the draft is computed for: the SESSION identity (VN-D10). Both fields MUST come from the server-assembled
 * session, never request input; M7 and the Part 2 verdict trust them as the identity they ask M39 about.
 */
export interface DraftViewer {
  readonly roles: readonly string[];
  /** The actor's ACTIVE membership id, or `null` when the session carries none (fails closed against a release). */
  readonly membershipId: string | null;
}

/** The sources other modules own, read through their seams. Each answers for the VIEWER and as of an instant. */
export interface DraftSeamPorts {
  /** M7 `CarePlanReader.relevantElementsAsOf`: redacts Part 2 per viewer itself. */
  carePlanAsOf(
    patientId: string,
    encounterType: EncounterType,
    discipline: InterventionDiscipline,
    admissionId: string | undefined,
    viewer: CarePlanElementsAudience,
    asOf: string,
  ): Promise<RelevantCarePlanElements | null>;
  /** M9 `ScaleSeriesProvider.series`: bounds are inclusive and filter on `captured_at`. */
  scaleSeries(patientId: string, scaleType: ScaleType, from: string, to: string): Promise<ScaleSeries>;
  /** M12 `MedicationOrderProvider.getMedicationChangesBetween`: the window `(from, to]`. `isSudTreatment` is NOT redacted. */
  medicationChangesBetween(
    organizationId: string,
    patientId: string,
    from: string,
    to: string,
  ): Promise<readonly MedicationOrderChange[]>;
  /** Whether this viewer may read this patient's 42 CFR Part 2 content. Fails closed (`false`) on its own errors. */
  part2DisclosureAllowed(query: {
    readonly organizationId: string;
    readonly patientId: string;
    readonly viewer: DraftViewer;
  }): Promise<boolean>;
}

/** What the M8 tables hold: supplied by PR C2b's store, never by this core. */
export interface DraftStorePorts {
  /** The organization's IANA time zone (`organizationTimezone` in `@chartwarden/db`). */
  organizationTimeZone(organizationId: string): Promise<string>;
  /**
   * When the patient's most recent EARLIER signed visit-type encounter happened (its `started_at`, else its
   * `clock_started_at`), or `null` when there is none. "Earlier" means before THIS encounter's visit time.
   */
  previousSignedVisitAt(encounter: DraftEncounter): Promise<Date | null>;
  /** The encounter's own latest vitals row captured at or before `asOf`, or `null`. One row, never merged. */
  latestVitals(encounterId: string, asOf: string): Promise<VitalsDraftInput | null>;
  /** Goal and intervention ids whose link to this encounter was removed (VN-D8), which the draft leaves out. */
  removedCarePlanElementIds(encounterId: string): Promise<ReadonlySet<string>>;
  /** The stored selection tree (prose opened) and the slots that render it. */
  loadSelection(
    encounter: DraftEncounter,
  ): Promise<{ readonly selection: SelectionState; readonly context: AssemblyContext }>;
}

export type DraftPorts = DraftSeamPorts & DraftStorePorts;
