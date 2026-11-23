// apps/backend/src/modules/08-encounters/drafting/db-draft-store.ts — the Drizzle `DraftStore` over the M8 tables (S1 PR C2b1): the five
// store ports the draft computation reads (design §3.2 "Input rules") plus the confirmation and care-plan-link access. Every query
// runs on the caller's `withOrgContext` transaction, so RLS scopes each one to the tenant.
import { type DbClient, organizationTimezone, schema } from "@chartwarden/db";
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, lte, or } from "drizzle-orm";
import type { HearthnoteEnvelopeCipher } from "../hearthnote-crypto";
import { readRecordedFacts } from "../note-facts";
import { ASSEMBLY_PATIENT_SLOT, toSelectionState } from "../routes/service";
import { openStoredProse, sectionHasOwnText, storedSections } from "../selection-tree";
import { linkElements, removeElements, removedCarePlanElementIds } from "./care-plan-links";
import { carePlanElementsOf } from "./care-plan-refs";
import { readConfirmations, upsertConfirmation } from "./confirmations";
import {
  linkDisciplineElements,
  removeDisciplineElements,
  removedDisciplinePlanElementIds,
} from "./discipline-plan-links";
import { disciplinePlanElementsOf } from "./discipline-plan-refs";
import type { DraftStore } from "./draft-store";
import {
  liveIdgActionItemId,
  raiseIdgLinkPart2,
  setIdgActionItemLink,
} from "./idg-action-item-links";
import type { DraftEncounter, WeightRow } from "./ports";
import { previousVisitAsOf } from "./visit-time";
import { vitalsDraftInput } from "./vitals-input";

const E = schema.encounters;
const V = schema.vitals;
const SEL = schema.hearthnoteSelections;

/** A visit counts as the previous one once it is signed: signed, or signed and awaiting its cosignature, or cosigned. */
const SIGNED_STATUSES = ["signed", "cosign_pending", "cosigned"] as const;

export interface DbDraftStoreDeps {
  /** The request's instant: the previous visit's own visit time is capped at it, exactly as this visit's is. */
  readonly now: Date;
  /** The `hearthnote_selection.free_text_cipher` envelope; absent, an encounter whose prose is sealed cannot be drafted (never drafted without it). */
  readonly freeTextCipher?: HearthnoteEnvelopeCipher;
}

/**
 * The candidates for the previous visit: the patient's SIGNED encounters of the SAME DISCIPLINE on an earlier service date (exported so a
 * test can render it). Any encounter type counts, but not any discipline: an intervening chaplain or aide visit must not become the last
 * visit of an RN note, or a medication change made between two RN visits falls into the window of a note that never described medications.
 * `encounter.discipline` is NOT NULL on the row and on `DraftEncounter`, so there is no null case: the comparison is plain equality.
 */
export const previousVisitWhere = (encounter: DraftEncounter) =>
  and(
    eq(E.organizationId, encounter.organizationId),
    eq(E.patientId, encounter.patientId),
    eq(E.discipline, encounter.discipline),
    inArray(E.status, [...SIGNED_STATUSES]),
    lt(E.serviceDate, encounter.serviceDate),
  );

/**
 * The patient's most recent SIGNED encounter of the same discipline on an EARLIER service date (any encounter type), as the instant
 * that encounter's own note described the patient at (`previousVisitAsOf`: its visit time, never later than its signing). Same-day
 * signed encounters are not "earlier", and a later-signed one wins a tie on the date.
 */
async function previousSignedVisitAt(
  tx: DbClient,
  encounter: DraftEncounter,
  now: Date,
): Promise<Date | null> {
  const [previous] = await tx
    .select({ serviceDate: E.serviceDate, signedAt: E.signedAt })
    .from(E)
    .where(previousVisitWhere(encounter))
    .orderBy(desc(E.serviceDate), desc(E.signedAt))
    .limit(1);
  if (previous === undefined) return null;
  const orgTimeZone = await organizationTimezone(tx, encounter.organizationId);
  return new Date(
    previousVisitAsOf({
      serviceDate: previous.serviceDate,
      orgTimeZone,
      now,
      signedAt: previous.signedAt,
    }),
  );
}

async function latestVitals(tx: DbClient, encounterId: string, asOf: string) {
  const [row] = await tx
    .select({
      id: V.id,
      capturedAt: V.capturedAt,
      bpSystolic: V.bpSystolic,
      bpDiastolic: V.bpDiastolic,
      heartRate: V.heartRate,
      respiratoryRate: V.respiratoryRate,
      temperature: V.temperature,
      temperatureUnit: V.temperatureUnit,
      spo2: V.spo2,
      painScore: V.painScore,
      painScale: V.painScale,
    })
    .from(V)
    .where(and(eq(V.encounterId, encounterId), lte(V.capturedAt, new Date(asOf))))
    .orderBy(desc(V.capturedAt), desc(V.createdAt), desc(V.id))
    .limit(1);
  return row === undefined ? null : vitalsDraftInput(row);
}

/**
 * S2: the patient's stored weights captured from `from` to `asOf`, oldest first: this encounter's own, and those of the patient's SIGNED
 * encounters (an unsigned draft of another visit is not yet part of the record, and a voided one never is). The text and unit are returned
 * as stored; `inputs.ts` decides what parses. Scoped by the caller's transaction (RLS) and by this organization (on both tables) and patient.
 * It takes every weight of the patient up to `asOf` when `from` is the epoch (the recertification snapshot, which does not yet know the benefit
 * period's start): cutting it by a guessed look-back would make "the first weight of the period" wrong for a period that began earlier.
 */
async function weightReadings(
  tx: DbClient,
  encounter: DraftEncounter,
  from: string,
  asOf: string,
): Promise<readonly WeightRow[]> {
  const rows = await tx
    .select({ id: V.id, capturedAt: V.capturedAt, weight: V.weight, unit: V.weightUnit })
    .from(V)
    .innerJoin(E, eq(E.id, V.encounterId))
    .where(
      and(
        eq(V.organizationId, encounter.organizationId),
        eq(E.organizationId, encounter.organizationId),
        eq(E.patientId, encounter.patientId),
        isNotNull(V.weight),
        gte(V.capturedAt, new Date(from)),
        lte(V.capturedAt, new Date(asOf)),
        or(eq(E.id, encounter.id), inArray(E.status, [...SIGNED_STATUSES])),
      ),
    )
    .orderBy(asc(V.capturedAt), asc(V.createdAt), asc(V.id));
  return rows.map((row) => ({
    id: row.id,
    recordedAt: row.capturedAt.toISOString(),
    weight: row.weight ?? "",
    unit: row.unit,
  }));
}

/**
 * What the existing Layer-1 assembly renders: the stored tree (prose opened), the patient and service-date slots and the facts recorded
 * on the visit (vitals, ADLs, nutrition, the linked fall). A section the draft does not draft is written from these when the note is
 * signed (`finalNoteOf`), so a context without them would sign a note that omits what the gate counted as documented. The wounds are
 * M9's, read through the draft's seam (`DraftSeamPorts.recordedWounds`), not here.
 */
async function loadSelection(
  tx: DbClient,
  encounter: DraftEncounter,
  cipher: HearthnoteEnvelopeCipher | undefined,
) {
  const [row] = await tx.select().from(SEL).where(eq(SEL.encounterId, encounter.id)).limit(1);
  // Sealed prose with no cipher would draft WITHOUT the clinician's own text, a hash that no signed note could match: refuse instead.
  if (row?.freeTextCipher != null && cipher === undefined) {
    throw new Error("the clinician's free text is sealed and no cipher is bound to open it");
  }
  const sections = row
    ? await openStoredProse(
        row,
        cipher && ((envelope) => cipher.open(encounter.organizationId, envelope)),
      )
    : [];
  const [visit] = await tx
    .select({ fallOccurredOn: E.fallOccurredOn })
    .from(E)
    .where(eq(E.id, encounter.id))
    .limit(1);
  const facts = await readRecordedFacts(
    tx,
    encounter.organizationId,
    { id: encounter.id, fallOccurredOn: visit?.fallOccurredOn ?? null },
    [],
  );
  return {
    selection: toSelectionState(encounter.encounterType, encounter.discipline, sections),
    context: { patient: ASSEMBLY_PATIENT_SLOT, serviceDate: encounter.serviceDate, ...facts },
  };
}

async function ownTextSectionIds(tx: DbClient, encounterId: string): Promise<ReadonlySet<string>> {
  const [row] = await tx
    .select({ selections: SEL.selections })
    .from(SEL)
    .where(eq(SEL.encounterId, encounterId))
    .limit(1);
  return new Set(
    storedSections(row?.selections)
      .filter(sectionHasOwnText)
      .map((s) => s.sectionId),
  );
}

export function createDbDraftStore(tx: DbClient, deps: DbDraftStoreDeps): DraftStore {
  return {
    organizationTimeZone: (organizationId) => organizationTimezone(tx, organizationId),
    previousSignedVisitAt: (encounter) => previousSignedVisitAt(tx, encounter, deps.now),
    latestVitals: (encounterId, asOf) => latestVitals(tx, encounterId, asOf),
    weightReadings: (encounter, from, asOf) => weightReadings(tx, encounter, from, asOf),
    removedCarePlanElementIds: (encounterId) => removedCarePlanElementIds(tx, encounterId),
    removedDisciplinePlanElementIds: (encounterId) =>
      removedDisciplinePlanElementIds(tx, encounterId),
    linkedIdgActionItemId: (encounterId) => liveIdgActionItemId(tx, encounterId),
    loadSelection: (encounter) => loadSelection(tx, encounter, deps.freeTextCipher),
    confirmations: (encounterId) => readConfirmations(tx, encounterId),
    ownTextSectionIds: (encounterId) => ownTextSectionIds(tx, encounterId),
    saveConfirmation: (write) => upsertConfirmation(tx, write),
    linkCarePlan: (encounter, refs) => linkElements(tx, encounter, carePlanElementsOf(refs)),
    removeCarePlan: (encounter, refs, removedBy, now) =>
      removeElements(tx, encounter, carePlanElementsOf(refs), removedBy, now),
    raiseIdgLinkPart2: (encounterId, actionItemId) =>
      raiseIdgLinkPart2(tx, encounterId, actionItemId),
    setIdgActionItemLink: (encounter, target, currentPart2Derived, by, now) =>
      setIdgActionItemLink(tx, encounter, target, currentPart2Derived, by, now),
    linkDisciplinePlan: (encounter, refs, part2Derived) =>
      linkDisciplineElements(tx, encounter, disciplinePlanElementsOf(refs), part2Derived),
    removeDisciplinePlan: (encounter, refs, part2Derived, removedBy, now) =>
      removeDisciplineElements(
        tx,
        encounter,
        disciplinePlanElementsOf(refs),
        part2Derived,
        removedBy,
        now,
      ),
  };
}
