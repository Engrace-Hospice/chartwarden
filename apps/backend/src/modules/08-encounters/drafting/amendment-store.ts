// apps/backend/src/modules/08-encounters/drafting/amendment-store.ts — the Drizzle access of an amending addendum (S1 PR E2; VN-D30). Every
// query runs on the caller's `withOrgContext` transaction, so RLS scopes it to the tenant.
//
//   * naming       `encounter_amendment` rows, one per section the addendum names, INSERTed when the addendum is created.
//   * resolutions  the author's `confirmed` / `deselected` per named section, UPDATEd in place (the guard trigger freezes them once the addendum
//                  is signed). `createAmendmentDraftStore` presents them as the `DraftStore` the draft pipeline reads, so the addendum owner
//                  runs through the very code a note does. An amendment never touches the note's care-plan links: they went out with the
//                  signed event and an amendment has no consumer for a changed one, so linking and unlinking are no-ops here.
//   * sealed rows  at sign, one `hearthnote_signed_section` row per amended section, against the addendum's own assembled output.
import { type DbClient, schema } from "@chartwarden/db";
import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { EncounterStateError } from "../lifecycle/errors";
import type { AmendedSection } from "./amendment-note";
import type { SectionVersionFlag } from "./amendment-part2";
import { sha256Hex } from "./compute";
import type { ConfirmationWrite, DraftStore } from "./draft-store";
import type { ConfirmationRecord } from "./section-state";

const AMENDMENT = schema.encounterAmendments;
const ADDENDUM = schema.encounterAddenda;
const SIGNED = schema.hearthnoteSignedSections;
const OUT = schema.hearthnoteAssembledOutputs;

/** An original sealed row of the parent's own pin: what an amendment names. */
export interface OriginalSection {
  readonly id: string;
  readonly sectionId: string;
  readonly position: number;
  /**
   * The ORIGINAL row is 42 CFR Part 2 derived. Not what guards an amendment: that is the LATEST version's flag (`part2SectionsAmong`, with
   * `amendmentFlagsOf`), since a section whose original was not Part 2 may have been amended into one.
   */
  readonly part2Derived: boolean;
}

/** The addendum an amendment belongs to, with the siting the satellite rows copy. */
export interface AmendingAddendum {
  readonly id: string;
  readonly organizationId: string;
  readonly encounterId: string;
  readonly providerEntityId: string | null;
  readonly locationId: string | null;
}

/** The original sealed rows of the encounter's own pin (`primary_finalize`), in note order; empty when the note has no sealed rows. */
export async function originalSectionsOf(
  tx: DbClient,
  encounterId: string,
): Promise<readonly OriginalSection[]> {
  const [pin] = await tx
    .select({ id: OUT.id })
    .from(OUT)
    .where(and(eq(OUT.encounterId, encounterId), eq(OUT.kind, "primary_finalize")))
    .orderBy(desc(OUT.createdAt))
    .limit(1);
  if (pin === undefined) return [];
  return tx
    .select({
      id: SIGNED.id,
      sectionId: SIGNED.sectionId,
      position: SIGNED.position,
      part2Derived: SIGNED.part2Derived,
    })
    .from(SIGNED)
    .where(and(eq(SIGNED.assembledOutputId, pin.id), isNull(SIGNED.addendumId)))
    .orderBy(asc(SIGNED.position));
}

/**
 * The signed amendment rows of the encounter, oldest addendum first (the order of their signing, which the parent's row lock serialises): each
 * section's id and Part 2 flag. With the originals they decide whose Part 2 disclosure a section needs: the LATEST version's flag, not the
 * original's (`part2SectionsAmong`). Rows exist only for a signed addendum, so a sign in progress never sees its own.
 */
export async function amendmentFlagsOf(
  tx: DbClient,
  encounterId: string,
): Promise<readonly SectionVersionFlag[]> {
  return tx
    .select({ sectionId: SIGNED.sectionId, part2Derived: SIGNED.part2Derived })
    .from(SIGNED)
    .innerJoin(ADDENDUM, eq(ADDENDUM.id, SIGNED.addendumId))
    .where(and(eq(SIGNED.encounterId, encounterId), isNotNull(SIGNED.addendumId)))
    .orderBy(asc(ADDENDUM.signedAt), asc(ADDENDUM.id), asc(SIGNED.position));
}

/** Names the sections an addendum amends (the addendum is a draft: the guard trigger refuses naming after that). */
export async function nameSections(
  tx: DbClient,
  addendum: AmendingAddendum,
  sectionIds: readonly string[],
): Promise<void> {
  if (sectionIds.length === 0) return;
  await tx.insert(AMENDMENT).values(
    sectionIds.map((sectionId) => ({
      organizationId: addendum.organizationId,
      providerEntityId: addendum.providerEntityId,
      locationId: addendum.locationId,
      encounterId: addendum.encounterId,
      addendumId: addendum.id,
      sectionId,
    })),
  );
}

/** The section ids the addendum names, by section id (they are named in one statement, so there is no order of naming to keep). */
export async function namedSectionIds(
  tx: DbClient,
  addendumId: string,
): Promise<readonly string[]> {
  const rows = await tx
    .select({ sectionId: AMENDMENT.sectionId })
    .from(AMENDMENT)
    .where(eq(AMENDMENT.addendumId, addendumId))
    .orderBy(asc(AMENDMENT.sectionId));
  return rows.map((row) => row.sectionId);
}

/** The resolutions the author has made: a named section nobody has resolved yet has none. */
export async function amendmentConfirmations(
  tx: DbClient,
  addendumId: string,
): Promise<ConfirmationRecord[]> {
  const rows = await tx
    .select({
      sectionId: AMENDMENT.sectionId,
      resolution: AMENDMENT.resolution,
      contentHash: AMENDMENT.contentHash,
      corpusVersion: AMENDMENT.corpusVersion,
    })
    .from(AMENDMENT)
    .where(eq(AMENDMENT.addendumId, addendumId));
  return rows.flatMap((row): ConfirmationRecord[] =>
    row.resolution === null || row.contentHash === null || row.corpusVersion === null
      ? []
      : [
          {
            sectionId: row.sectionId,
            resolution: row.resolution,
            contentHash: row.contentHash,
            corpusVersion: row.corpusVersion,
          },
        ],
  );
}

/** Resolves one named section (confirm again to replace). A section the addendum does not name is `UNKNOWN_TEMPLATE_SECTION`. */
export async function saveAmendmentResolution(
  tx: DbClient,
  addendumId: string,
  write: ConfirmationWrite,
): Promise<void> {
  const updated = await tx
    .update(AMENDMENT)
    .set({
      resolution: write.resolution,
      contentHash: write.contentHash,
      corpusVersion: write.corpusVersion,
      edited: write.edited,
      part2Derived: write.part2Derived,
      sourceRefs: [...write.sourceRefs],
      resolvedByMembershipId: write.resolvedByMembershipId,
      resolvedAt: write.resolvedAt,
    })
    .where(and(eq(AMENDMENT.addendumId, addendumId), eq(AMENDMENT.sectionId, write.sectionId)))
    .returning({ id: AMENDMENT.id });
  if (updated.length === 0) {
    throw new EncounterStateError(
      "UNKNOWN_TEMPLATE_SECTION",
      `section '${write.sectionId}' is not one this addendum amends`,
    );
  }
}

/** `base` with the addendum's resolutions in place of the note's, and no care-plan link changes: the store the draft pipeline reads an addendum through. */
export function createAmendmentDraftStore(
  tx: DbClient,
  base: DraftStore,
  addendumId: string,
): DraftStore {
  return {
    ...base,
    confirmations: () => amendmentConfirmations(tx, addendumId),
    saveConfirmation: (write) => saveAmendmentResolution(tx, addendumId, write),
    linkCarePlan: async () => 0,
    removeCarePlan: async () => 0,
  };
}

export interface AmendmentRowsWrite {
  readonly addendum: AmendingAddendum;
  readonly sections: readonly AmendedSection[];
  /** Seals one text under the tenant DEK with the narrative's envelope. */
  readonly seal: (plaintext: string) => Promise<string>;
}

/**
 * At sign, in the sign transaction and BEFORE the addendum flips to signed (the guard trigger refuses a row for any other status): one sealed row
 * per amended section, against the addendum's own assembled output, naming the amended ORIGINAL row of the parent's pin. Any one seal failing
 * fails the set (no partial rows), and the sign with it. Returns the number of rows written.
 */
export async function writeAmendmentRows(tx: DbClient, write: AmendmentRowsWrite): Promise<number> {
  const { addendum, sections } = write;
  if (sections.length === 0) return 0;
  const [output] = await tx
    .select({ id: OUT.id })
    .from(OUT)
    .where(and(eq(OUT.addendumId, addendum.id), eq(OUT.kind, "addendum_finalize")))
    .orderBy(desc(OUT.createdAt))
    .limit(1);
  if (output === undefined) {
    throw new EncounterStateError(
      "ILLEGAL_TRANSITION",
      "the addendum has no pinned output to seal its amended sections against",
    );
  }
  const originals = new Map(
    (await originalSectionsOf(tx, addendum.encounterId)).map((o) => [o.sectionId, o]),
  );
  const sealed = await Promise.all(
    sections.map(async (section) => ({ section, textCipher: await write.seal(section.text) })),
  );
  await tx.insert(SIGNED).values(
    sealed.map(({ section, textCipher }) => {
      const original = originals.get(section.sectionId);
      if (original === undefined) {
        throw new EncounterStateError(
          "UNKNOWN_TEMPLATE_SECTION",
          `section '${section.sectionId}' is not one the signed note carries, so it cannot be amended`,
        );
      }
      return {
        organizationId: addendum.organizationId,
        providerEntityId: addendum.providerEntityId,
        locationId: addendum.locationId,
        encounterId: addendum.encounterId,
        assembledOutputId: output.id,
        addendumId: addendum.id,
        amendsSectionId: original.id,
        sectionId: section.sectionId,
        position: original.position,
        textCipher,
        contentHash: sha256Hex(section.text),
        part2Derived: section.part2Derived,
        sourceRefs: [...section.sourceRefs],
      };
    }),
  );
  return sealed.length;
}
