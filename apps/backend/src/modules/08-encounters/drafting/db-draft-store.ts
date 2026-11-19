// apps/backend/src/modules/08-encounters/drafting/db-draft-store.ts — the Drizzle `DraftStore` over the M8 tables (S1 PR C2b1): the five
// store ports the draft computation reads (design §3.2 "Input rules") plus the confirmation and care-plan-link access. Every query
// runs on the caller's `withOrgContext` transaction, so RLS scopes each one to the tenant.
import { type DbClient, organizationTimezone, schema } from "@chartwarden/db";
import { and, desc, eq, inArray, lt, lte } from "drizzle-orm";
import type { HearthnoteEnvelopeCipher } from "../hearthnote-crypto";
import { ASSEMBLY_PATIENT_SLOT, toSelectionState } from "../routes/service";
import { openStoredProse, sectionHasOwnText, storedSections } from "../selection-tree";
import { linkElements, removeElements, removedCarePlanElementIds } from "./care-plan-links";
import { carePlanElementsOf } from "./care-plan-refs";
import { readConfirmations, upsertConfirmation } from "./confirmations";
import type { DraftStore } from "./draft-store";
import type { DraftEncounter } from "./ports";
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
 * The patient's most recent SIGNED encounter on an EARLIER service date (all seventeen encounter types are visit types), as the instant
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
    .where(
      and(
        eq(E.organizationId, encounter.organizationId),
        eq(E.patientId, encounter.patientId),
        inArray(E.status, [...SIGNED_STATUSES]),
        lt(E.serviceDate, encounter.serviceDate),
      ),
    )
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

/** What the existing Layer-1 assembly renders: the stored tree (prose opened) and the patient and service-date slots. */
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
  return {
    selection: toSelectionState(encounter.encounterType, encounter.discipline, sections),
    context: { patient: ASSEMBLY_PATIENT_SLOT, serviceDate: encounter.serviceDate },
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
    removedCarePlanElementIds: (encounterId) => removedCarePlanElementIds(tx, encounterId),
    loadSelection: (encounter) => loadSelection(tx, encounter, deps.freeTextCipher),
    confirmations: (encounterId) => readConfirmations(tx, encounterId),
    ownTextSectionIds: (encounterId) => ownTextSectionIds(tx, encounterId),
    saveConfirmation: (write) => upsertConfirmation(tx, write),
    linkCarePlan: (encounter, refs) => linkElements(tx, encounter, carePlanElementsOf(refs)),
    removeCarePlan: (encounter, refs, removedBy, now) =>
      removeElements(tx, encounter, carePlanElementsOf(refs), removedBy, now),
  };
}
