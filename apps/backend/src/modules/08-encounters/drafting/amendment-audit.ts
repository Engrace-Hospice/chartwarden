// apps/backend/src/modules/08-encounters/drafting/amendment-audit.ts — the explicit audit event of an amended section (S1; ADR-0114 VN-D30,
// CW-AC-51). One event per section the signed addendum amended, written in the addendum's sign transaction beside the sealed amendment row:
// the row trigger records the row, this records WHO amended WHICH section of WHICH note by WHICH addendum, and what the audit read path may
// show of it. Ids and one flag only: never text, a content hash or a source id. A Part 2 derived section files under the Part 2 retention
// class (the catalog marks the action Part 2 eligible). The outbox event of the same name carries ids only and no flag (the flag would tell a
// subscriber which section is Part 2); the flag lives here, in the class of the audit event.
import { type AuditContext, audit } from "@chartwarden/audit";
import type { DbClient } from "@chartwarden/db";
import { retentionClassOf } from "./audit-retention";

export const SECTION_AMENDED_AUDIT_EVENT = "m8.encounter.section_amended";

export interface SectionsAmended {
  readonly encounterId: string;
  readonly addendumId: string;
  readonly sections: readonly { readonly sectionId: string; readonly part2Derived: boolean }[];
}

export async function recordSectionsAmended(
  tx: DbClient,
  context: AuditContext,
  amended: SectionsAmended,
): Promise<void> {
  for (const section of amended.sections) {
    await audit(tx, context, {
      eventType: SECTION_AMENDED_AUDIT_EVENT,
      resourceKind: "encounter",
      resourceId: amended.encounterId,
      outcome: "success",
      severity: "info",
      retentionClass: retentionClassOf(section.part2Derived),
      after: {
        addendumId: amended.addendumId,
        sectionId: section.sectionId,
        part2Derived: section.part2Derived,
      },
    });
  }
}
