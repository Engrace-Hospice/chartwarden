// apps/backend/src/modules/08-encounters/drafting/compute.ts — the draft for one author at one visit (S1 PR C2a;
// VN-D4, VN-D10, VN-D11, design §3.2). The entry PR C2b builds the store, routes and gate on.
//
// NOTHING IS CACHED across calls: the draft is recomputed from the seams for the reading author, as of the visit
// time, so Part 2 redaction is decided per request and one author's answer can never reach another.
import { createHash } from "node:crypto";
import {
  type AssemblyContext,
  type Draft,
  DraftInputError,
  type DraftInputs,
  HearthnoteAssemblyError,
  type SelectionState,
  compileDraft,
  draftSourceNeeds,
  emptyDraft,
  readsBenefitPeriod,
  templateHasDraftedSection,
} from "@chartwarden/hearthnote";
import { ASSEMBLY_ERROR_CODE, EncounterStateError } from "../lifecycle/errors";
import { readDraftInputs } from "./inputs";
import type { DraftEncounter, DraftPorts, DraftStorePorts, DraftViewer } from "./ports";
import { readsPreviousVisit } from "./source-reads";
import { draftUnavailable, guarded, settleAll } from "./unavailable";
import { visitAsOf } from "./visit-time";

/** What a draft view needs: the draft, the instant it describes and the template. */
export interface DraftOverview {
  readonly draft: Draft;
  /** The visit time the draft describes the patient at (ISO-8601, UTC). */
  readonly asOf: string;
  readonly templateKey: string;
}

export interface ComputedDraft extends DraftOverview {
  /** The clinician's stored selections and the slots that render them, as the draft was compiled from them (the signed note is built from the same read). */
  readonly selection: SelectionState;
  readonly context: AssemblyContext;
}

/** SHA-256 of the UTF-8 bytes as 64 lowercase hex characters: the draft's content hash and the sealed rows' hash. */
export const sha256Hex = (canonical: string): string =>
  createHash("sha256").update(canonical, "utf8").digest("hex");

/** Within one call the organization's zone is asked for once, though the visit time and the reads both need it. */
function zoneReadOnce(ports: DraftPorts): DraftPorts {
  let zone: Promise<string> | undefined;
  return {
    ...ports,
    organizationTimeZone: (organizationId) => {
      zone ??= Promise.resolve().then(() => ports.organizationTimeZone(organizationId));
      return zone;
    },
  };
}

/** Run a hearthnote draft step, mapping its typed failures to the codes the M8 routes answer with. */
function mapped<T>(step: () => T): T {
  try {
    return step();
  } catch (cause) {
    if (cause instanceof HearthnoteAssemblyError) {
      throw new EncounterStateError(ASSEMBLY_ERROR_CODE[cause.code], cause.message, undefined, {
        cause,
      });
    }
    if (cause instanceof DraftInputError) throw draftUnavailable("a source of the draft", cause);
    throw cause;
  }
}

const compile = (inputs: DraftInputs): Draft => mapped(() => compileDraft(inputs, { sha256Hex }));

/**
 * Compute the draft of `encounter` for `viewer` as of the visit time. Throws `EncounterStateError`
 * `DRAFT_UNAVAILABLE` when any read fails or returns something unusable, and the selection-assembly codes
 * (`VOCAB_VERSION_MISMATCH`, `INVALID_ENCOUNTER_DISCIPLINE_PAIR`, `UNKNOWN_VOCAB_CODE`) when the stored selection
 * cannot be rendered. `now` is only a ceiling on the visit time: once the service date has ended, `now` does not move it.
 */
export async function computeDraft(
  ports: DraftPorts,
  encounter: DraftEncounter,
  viewer: DraftViewer,
  now: Date,
): Promise<ComputedDraft> {
  const call = zoneReadOnce(ports);
  const orgTimeZone = await guarded("the organization time zone", () =>
    call.organizationTimeZone(encounter.organizationId),
  );
  const asOf = await guarded("the visit time", () =>
    visitAsOf({ serviceDate: encounter.serviceDate, orgTimeZone, now }),
  );
  // `settleAll`, not `Promise.all`: the stored-selection read is several queries on the request's transaction, and must not outlive a seam that fails at once.
  const [sources, stored, wounds] = await settleAll([
    readDraftInputs(call, encounter, viewer, asOf),
    guarded("the stored selections", () => call.loadSelection(encounter)),
    guarded("the recorded wounds", () =>
      call.recordedWounds({
        organizationId: encounter.organizationId,
        encounterId: encounter.id,
        patientId: encounter.patientId,
      }),
    ),
  ]);
  // The wounds are M9's: the store states what M8 holds, the seam adds them, so the signed note (`finalNoteOf`) states what the gate counted.
  const context: AssemblyContext =
    wounds.length === 0 ? stored.context : { ...stored.context, recordedWounds: wounds };
  const draft = compile({ ...sources, selection: stored.selection, context });
  return {
    draft,
    selection: stored.selection,
    context,
    asOf,
    templateKey: draft.templateKey,
  };
}

/** What stands in for the store of a draft whose transaction has closed and that needs none: a read through it is a bug, not a silent open connection. */
const CLOSED_STORE: DraftStorePorts = {
  organizationTimeZone: () =>
    Promise.reject(new Error("a store read after its transaction closed")),
  previousSignedVisitAt: () =>
    Promise.reject(new Error("a store read after its transaction closed")),
  latestVitals: () => Promise.reject(new Error("a store read after its transaction closed")),
  weightReadings: () => Promise.reject(new Error("a store read after its transaction closed")),
  removedCarePlanElementIds: () =>
    Promise.reject(new Error("a store read after its transaction closed")),
  removedDisciplinePlanElementIds: () =>
    Promise.reject(new Error("a store read after its transaction closed")),
  linkedIdgActionItemId: () =>
    Promise.reject(new Error("a store read after its transaction closed")),
  loadSelection: () => Promise.reject(new Error("a store read after its transaction closed")),
};

/** The earliest `from` of the weight snapshot: the benefit period's start is not known until module 6 answers, so every weight up to the visit is taken. */
const WEIGHTS_FROM = "1970-01-01T00:00:00.000Z";

/** The store read of a source this snapshot did not take: a bug in the caller, refused loudly rather than answered as "nothing recorded". */
const notTaken = (what: string) => (): Promise<never> =>
  Promise.reject(new Error(`a ${what} read the snapshot did not take`));

/**
 * Every STORE read the draft makes (the zone, the previous visit, the vitals, the removed care-plan links, the stored selections), taken up
 * front, as constant ports. A read-only draft then runs its source reads (M7, M9, M12, M39: each opens a pooled transaction of its own) with
 * NO connection held by this request, instead of one held across them for as long as the slowest seam takes (S3: ten concurrent drafts would
 * hold the whole pool and each wait for an eleventh). The reads, their arguments and their failure codes are the ones `computeDraft` makes;
 * only when they are made moves. A template the corpus does not draft reads nothing, and its ports refuse any read.
 */
export async function snapshotStorePorts(
  store: DraftStorePorts,
  encounter: DraftEncounter,
  now: Date,
  /**
   * Whether the viewer holds `idg.read` (S5b, VN-D66): a viewer without it gets the IDG follow-up's own section as not drafted, so the link is not even
   * read for them and nothing about this visit's link can fail their draft. The draft's read of the link (`readIdgFollowUp`) asks the same key.
   */
  mayReadIdg = true,
): Promise<DraftStorePorts> {
  if (!templateHasDraftedSection(encounter.encounterType, encounter.discipline))
    return CLOSED_STORE;
  const orgTimeZone = await guarded("the organization time zone", () =>
    store.organizationTimeZone(encounter.organizationId),
  );
  const asOf = await guarded("the visit time", () =>
    visitAsOf({ serviceDate: encounter.serviceDate, orgTimeZone, now }),
  );
  // S2: only the recertification and face-to-face visits read weights, and only they pay for the read (the routine visit's snapshot is as it was).
  const readsWeights = readsBenefitPeriod(encounter.encounterType);
  // S3: the store reads of a source the template does not draft from are not taken either (an aide's snapshot is the care-plan links and the
  // stored selections): `readDraftInputs` reads the same sources, by the same rule.
  const needs = draftSourceNeeds(encounter.encounterType, encounter.discipline);
  const [previous, vitals, removed, removedDiscipline, linkedIdg, stored, weights] =
    await settleAll([
      readsPreviousVisit(needs)
        ? guarded("the previous signed visit", () => store.previousSignedVisitAt(encounter))
        : Promise.resolve(null),
      needs.vitals
        ? guarded("the vitals", () => store.latestVitals(encounter.id, asOf))
        : Promise.resolve(null),
      needs.carePlan
        ? guarded("the removed care-plan links", () =>
            store.removedCarePlanElementIds(encounter.id),
          )
        : Promise.resolve(new Set<string>()),
      needs.disciplinePlan
        ? guarded("the removed discipline-plan links", () =>
            store.removedDisciplinePlanElementIds(encounter.id),
          )
        : Promise.resolve(new Set<string>()),
      needs.idgFollowUp && mayReadIdg
        ? guarded("the linked IDG action item", () => store.linkedIdgActionItemId(encounter.id))
        : Promise.resolve(null),
      guarded("the stored selections", () => store.loadSelection(encounter)),
      readsWeights
        ? guarded("the weights", () => store.weightReadings(encounter, WEIGHTS_FROM, asOf))
        : Promise.resolve(null),
    ]);
  return {
    organizationTimeZone: async () => orgTimeZone,
    // A read of a source the snapshot did not take is a bug, not an empty answer (as the weights below, and `CLOSED_STORE`).
    previousSignedVisitAt: readsPreviousVisit(needs)
      ? async () => previous
      : notTaken("previous signed visit"),
    latestVitals: needs.vitals ? async () => vitals : notTaken("vitals"),
    // The same rows `weightReadings(encounter, from, asOf)` would return, cut to `from` here (the period start is known only later).
    weightReadings: async (_encounter, from) =>
      weights === null
        ? Promise.reject(new Error("a weight read the snapshot did not take"))
        : weights.filter((row) => Date.parse(row.recordedAt) >= Date.parse(from)),
    removedCarePlanElementIds: needs.carePlan
      ? async () => removed
      : notTaken("removed care-plan links"),
    removedDisciplinePlanElementIds: needs.disciplinePlan
      ? async () => removedDiscipline
      : notTaken("removed discipline-plan links"),
    linkedIdgActionItemId: needs.idgFollowUp
      ? async () => linkedIdg
      : notTaken("linked IDG action item"),
    loadSelection: async () => stored,
  };
}

/**
 * The store reads of the per-element routes of a social-work or chaplain visit (S4b): the zone and the removed links, and nothing else. The response never
 * shows the clinician's stored selections, so they are neither loaded nor decrypted; a read of any other port is a bug, refused loudly (as `snapshotStorePorts`).
 */
export async function snapshotDisciplinePlanPorts(
  store: DraftStorePorts,
  encounter: DraftEncounter,
): Promise<DraftStorePorts> {
  const [orgTimeZone, removed] = await settleAll([
    guarded("the organization time zone", () =>
      store.organizationTimeZone(encounter.organizationId),
    ),
    guarded("the removed discipline-plan links", () =>
      store.removedDisciplinePlanElementIds(encounter.id),
    ),
  ]);
  return {
    organizationTimeZone: async () => orgTimeZone,
    removedDisciplinePlanElementIds: async () => removed,
    previousSignedVisitAt: notTaken("previous signed visit"),
    latestVitals: notTaken("vitals"),
    weightReadings: notTaken("weights"),
    removedCarePlanElementIds: notTaken("removed care-plan links"),
    linkedIdgActionItemId: notTaken("linked IDG action item"),
    loadSelection: notTaken("stored selections"),
  };
}

/**
 * The store reads of the IDG action item routes of an IDG follow-up visit (S5b): the zone and the live link, and nothing else. The response never shows the
 * clinician's stored selections, so they are neither loaded nor decrypted; a read of any other port is a bug, refused loudly (as `snapshotStorePorts`).
 */
export async function snapshotIdgFollowUpPorts(
  store: DraftStorePorts,
  encounter: DraftEncounter,
): Promise<DraftStorePorts> {
  const [orgTimeZone, linked] = await settleAll([
    guarded("the organization time zone", () =>
      store.organizationTimeZone(encounter.organizationId),
    ),
    guarded("the linked IDG action item", () => store.linkedIdgActionItemId(encounter.id)),
  ]);
  return {
    organizationTimeZone: async () => orgTimeZone,
    linkedIdgActionItemId: async () => linked,
    previousSignedVisitAt: notTaken("previous signed visit"),
    latestVitals: notTaken("vitals"),
    weightReadings: notTaken("weights"),
    removedCarePlanElementIds: notTaken("removed care-plan links"),
    removedDisciplinePlanElementIds: notTaken("removed discipline-plan links"),
    loadSelection: notTaken("stored selections"),
  };
}

/**
 * The draft the routes show: `computeDraft` for a template the corpus drafts, otherwise every section empty (`not_drafted`) with no
 * source read, no stored selection read and no zone read. `asOf` is then `now`: nothing is described as of a visit time, and `now` is the
 * ceiling the visit time never passes. The same predicate (`templateHasDraftedSection`) keeps the gate and sign out of the draft entirely
 * (`readNoteDraft`). A pair with no template is refused as `computeDraft` refuses it.
 */
export async function computeDraftOverview(
  ports: DraftPorts,
  encounter: DraftEncounter,
  viewer: DraftViewer,
  now: Date,
): Promise<DraftOverview> {
  if (templateHasDraftedSection(encounter.encounterType, encounter.discipline)) {
    return computeDraft(ports, encounter, viewer, now);
  }
  const asOf = now.toISOString();
  const draft = mapped(() => emptyDraft(encounter.encounterType, encounter.discipline, asOf));
  return { draft, asOf, templateKey: draft.templateKey };
}
