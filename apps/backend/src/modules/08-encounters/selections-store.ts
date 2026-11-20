// apps/backend/src/modules/08-encounters/selections-store.ts — WF09: the HearthNote selection row, the pinned narrative and the
// `GET .../selections` body, as the route service reads and writes them. Standalone functions over a caller's org-scoped
// transaction (no closure state), so the route service's one big factory only composes them.
import { type DbClient, schema } from "@chartwarden/db";
import { templateKey as hearthnoteTemplateKey } from "@chartwarden/hearthnote";
import { VOCAB_VERSION } from "@chartwarden/narrative-vocab";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { EncounterStateError } from "./lifecycle/errors";
import type { FallLink } from "./routes/fall-link";
import type { SelectionSectionInput } from "./routes/service";

const ENC = schema.encounters;
const SEL = schema.hearthnoteSelections;
const OUT = schema.hearthnoteAssembledOutputs;

/** One section of the stored tree (`hasFreeText` is storage metadata for the §2.6 gate; the prose itself is sealed elsewhere). */
export interface StoredSelectionSection {
  readonly sectionId: string;
  readonly entries: SelectionSectionInput["entries"];
  readonly hasFreeText?: boolean;
}

/**
 * Write the encounter's selection row and bump its version together: the one shape for every selections write (the draft save and the
 * create that carries a first reason). Bumps the optimistic-lock version from `ifVersion` (a lost race matches no row and throws),
 * moves the fall link, and upserts the one selection row of the encounter. Returns the new version.
 */
export async function persistSelections(
  t: DbClient,
  organizationId: string,
  r: {
    readonly id: string;
    readonly providerEntityId: string | null;
    readonly locationId: string | null;
    readonly encounterType: typeof ENC.$inferSelect.encounterType;
    readonly discipline: typeof ENC.$inferSelect.discipline;
  },
  write: {
    readonly ifVersion: number;
    readonly stored: readonly StoredSelectionSection[];
    readonly freeTextCipher: string | null;
    readonly fallLink: FallLink | null;
  },
): Promise<number> {
  const [updated] = await t
    .update(ENC)
    .set({
      version: write.ifVersion + 1,
      updatedAt: new Date(),
      fallIncidentId: write.fallLink?.incidentId ?? null,
      fallOccurredOn: write.fallLink?.occurredOn ?? null,
    })
    .where(and(eq(ENC.id, r.id), eq(ENC.version, write.ifVersion)))
    .returning({ version: ENC.version });
  if (!updated) {
    throw new EncounterStateError(
      "ILLEGAL_TRANSITION",
      "updateSelections matched no row (stale write)",
    );
  }
  const key = hearthnoteTemplateKey(r.encounterType, r.discipline);
  const selections = { sections: [...write.stored] };
  await t
    .insert(SEL)
    .values({
      organizationId,
      providerEntityId: r.providerEntityId,
      locationId: r.locationId,
      encounterId: r.id,
      templateKey: key,
      templateVersion: VOCAB_VERSION,
      selections,
      freeTextCipher: write.freeTextCipher,
    })
    .onConflictDoUpdate({
      target: SEL.encounterId,
      targetWhere: isNotNull(SEL.encounterId),
      set: {
        selections,
        freeTextCipher: write.freeTextCipher,
        templateKey: key,
        templateVersion: VOCAB_VERSION,
        updatedAt: new Date(),
        version: sql`${SEL.version} + 1`,
      },
    });
  return Number(updated.version);
}

/** The latest pinned primary narrative of an encounter (ciphers still sealed), or undefined: a draft, or a row finalized before #122. */
export async function pinnedOutputFor(t: DbClient, encounterId: string) {
  const [row] = await t
    .select({
      layer1Cipher: OUT.layer1Cipher,
      finalCipher: OUT.finalCipher,
      clinicianEdited: OUT.clinicianEdited,
    })
    .from(OUT)
    .where(and(eq(OUT.encounterId, encounterId), eq(OUT.kind, "primary_finalize")))
    .orderBy(desc(OUT.createdAt))
    .limit(1);
  return row;
}

/** The `GET .../selections` body: the encounter's own facts around the tree and the preview the caller worked out. */
export function selectionsViewOf(
  r: typeof ENC.$inferSelect,
  note: {
    readonly sections: SelectionSectionInput[];
    readonly layer1Preview: string;
    readonly editedNarrative: string | null;
    readonly editedNarrativeStale: boolean;
  },
) {
  return {
    patientId: r.patientId,
    templateKey: hearthnoteTemplateKey(r.encounterType, r.discipline),
    vocabVersion: VOCAB_VERSION,
    sections: note.sections,
    layer1Preview: note.layer1Preview,
    editedNarrative: note.editedNarrative,
    editedNarrativeStale: note.editedNarrativeStale,
    // The If-Match contract protects the encounter aggregate, not its HearthNote child row.
    // `hearthnote_selection.version` remains internal bookkeeping; returning it here causes a
    // false 412 whenever the child and encounter counters differ.
    version: Number(r.version),
    fallIncident:
      r.fallIncidentId !== null && r.fallOccurredOn !== null
        ? { incidentId: r.fallIncidentId, occurredOn: r.fallOccurredOn }
        : null,
  };
}
