// apps/backend/src/modules/08-encounters/drafting/db-draft-unit.ts — the production `RunInOrg` (S1 PR C2b1): one `withOrgContext`
// transaction per request, so RLS scopes every statement, the confirmation and care-plan writes commit or roll back together with the
// explicit audit event, and the row triggers attribute the write to the acting user.
import { audit } from "@chartwarden/audit";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";
import type { HearthnoteCiphers } from "../hearthnote-crypto";
import { createAmendmentDraftStore, namedSectionIds } from "./amendment-store";
import { retentionClassOf } from "./audit-retention";
import { createDbDraftStore } from "./db-draft-store";
import type {
  AmendmentRef,
  DraftEncounterRow,
  DraftResolvedEvent,
  DraftScope,
  DraftUnit,
  RunInOrg,
} from "./draft-store";
import { isVisitNoteDraftEnabled } from "./policy-service";

/** The explicit audit event one resolution records (catalogued in `M8_ACTION_CATALOG`); the confirmation's row trigger records the row too. */
export const DRAFT_SECTION_AUDIT_EVENT = "m8.encounter.draft_section_resolved";

const E = schema.encounters;
const ADDENDUM = schema.encounterAddenda;

async function loadEncounter(
  tx: DbClient,
  encounterId: string,
  forUpdate: boolean,
): Promise<DraftEncounterRow | null> {
  const query = tx
    .select({
      id: E.id,
      organizationId: E.organizationId,
      patientId: E.patientId,
      admissionId: E.admissionId,
      encounterType: E.encounterType,
      discipline: E.discipline,
      serviceDate: E.serviceDate,
      status: E.status,
      providerEntityId: E.providerEntityId,
      locationId: E.locationId,
    })
    .from(E)
    .where(eq(E.id, encounterId))
    .limit(1);
  // `FOR NO KEY UPDATE`: the same lock finalize, sign, the picker and the selections save take (`loadEnc({ lock: true })`), so these
  // writes and those take turns, while the foreign-key checks of vitals, mileage and signature inserts (KEY SHARE) are not held up.
  const [row] = forUpdate ? await query.for("no key update") : await query;
  return row ?? null;
}

async function loadAmendment(
  tx: DbClient,
  encounterId: string,
  addendumId: string,
): Promise<AmendmentRef | null> {
  const [row] = await tx
    .select({
      id: ADDENDUM.id,
      status: ADDENDUM.status,
      authoredByMembershipId: ADDENDUM.authoredByMembershipId,
    })
    .from(ADDENDUM)
    .where(and(eq(ADDENDUM.id, addendumId), eq(ADDENDUM.encounterId, encounterId)))
    .limit(1);
  if (row === undefined) return null;
  return {
    id: row.id,
    status: row.status as AmendmentRef["status"],
    authoredByMembershipId: row.authoredByMembershipId,
    sectionIds: await namedSectionIds(tx, row.id),
  };
}

function createUnit(
  tx: DbClient,
  scope: DraftScope,
  ciphers: HearthnoteCiphers | undefined,
): DraftUnit {
  const store = createDbDraftStore(tx, { now: scope.now, freeTextCipher: ciphers?.freeText });
  return {
    enabled: () => isVisitNoteDraftEnabled(tx, scope.organizationId),
    encounter: (encounterId, forUpdate) => loadEncounter(tx, encounterId, forUpdate),
    store,
    amendment: (encounterId, addendumId) => loadAmendment(tx, encounterId, addendumId),
    amendmentStore: (addendumId) => createAmendmentDraftStore(tx, store, addendumId),
    async recordResolved(event: DraftResolvedEvent) {
      if (scope.audit === undefined)
        throw new Error("a draft write needs the request's audit context");
      await audit(tx, scope.audit, {
        eventType: DRAFT_SECTION_AUDIT_EVENT,
        resourceKind: "encounter",
        resourceId: event.encounterId,
        outcome: "success",
        severity: "info",
        // A Part 2 section files under the Part 2 retention class (the catalog marks the event Part 2 eligible) and records no source ids:
        // the audit read path (`audit.read`) is not Part 2 gated, and a medication id tied to a patient discloses the SUD treatment.
        retentionClass: retentionClassOf(event.part2Derived),
        // Ids, enums and counts only: the source ids are the VN-D7 provenance for a plain section; no sentence of the note is copied here,
        // and no content hash (an unsalted SHA-256 of low-entropy text is an offline guessing oracle; the hash lives on the confirmation row).
        after: {
          ...(event.addendumId === null ? {} : { addendumId: event.addendumId }),
          sectionId: event.sectionId,
          resolution: event.resolution,
          edited: event.edited,
          corpusVersion: event.corpusVersion,
          part2Derived: event.part2Derived,
          ...(event.part2Derived
            ? {}
            : { sourceRefs: event.sourceRefs.map((ref) => ({ kind: ref.kind, id: ref.id })) }),
          carePlanElementsLinked: event.carePlanElementsLinked,
          carePlanElementsRemoved: event.carePlanElementsRemoved,
        },
      });
    },
  };
}

export function createDbRunInOrg(db: DbClient, ciphers?: HearthnoteCiphers): RunInOrg {
  return (scope, fn) =>
    withOrgContext(db, { organizationId: scope.organizationId, userId: scope.userId }, (tx) =>
      fn(createUnit(tx as unknown as DbClient, scope, ciphers)),
    );
}
