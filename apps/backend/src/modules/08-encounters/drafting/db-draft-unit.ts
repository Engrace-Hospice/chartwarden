// apps/backend/src/modules/08-encounters/drafting/db-draft-unit.ts — the production `RunInOrg` (S1 PR C2b1): one `withOrgContext`
// transaction per request, so RLS scopes every statement, the confirmation and care-plan writes commit or roll back together with the
// explicit audit event, and the row triggers attribute the write to the acting user.
import { audit } from "@chartwarden/audit";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { eq } from "drizzle-orm";
import type { HearthnoteCiphers } from "../hearthnote-crypto";
import { createDbDraftStore } from "./db-draft-store";
import type {
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
const PART2_RETENTION_CLASS = "compliance_42cfr_part2";
const DEFAULT_RETENTION_CLASS = "compliance";

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
  const [row] = forUpdate ? await query.for("update") : await query;
  return row ?? null;
}

function createUnit(
  tx: DbClient,
  scope: DraftScope,
  ciphers: HearthnoteCiphers | undefined,
): DraftUnit {
  return {
    enabled: () => isVisitNoteDraftEnabled(tx, scope.organizationId),
    encounter: (encounterId, forUpdate) => loadEncounter(tx, encounterId, forUpdate),
    store: createDbDraftStore(tx, { now: scope.now, freeTextCipher: ciphers?.freeText }),
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
        retentionClass: event.part2Derived ? PART2_RETENTION_CLASS : DEFAULT_RETENTION_CLASS,
        // Ids, enums and counts only: the source ids are the VN-D7 provenance for a plain section; no sentence of the note is copied here,
        // and no content hash (an unsalted SHA-256 of low-entropy text is an offline guessing oracle; the hash lives on the confirmation row).
        after: {
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
