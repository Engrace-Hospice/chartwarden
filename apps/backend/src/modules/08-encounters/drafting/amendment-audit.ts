// apps/backend/src/modules/08-encounters/drafting/amendment-audit.ts — the explicit audit event of an amending addendum's sign (S1; ADR-0114
// VN-D30, CW-AC-51). ONE event per signed addendum, written in its sign transaction beside the sealed amendment rows: WHO amended a section of WHICH
// note by WHICH addendum, and how many. `audit.read` is not Part 2 gated, so nothing here may tell a reader which sections hold Part 2: the event
// names no section and carries no Part 2 flag, and files under the standard retention class (never the Part 2 class: that would itself mark the
// addendum). The per-section trail, the actor and the scrubbed image of each amended section, is the row trigger of `hearthnote_signed_section`;
// the outbox event of the same name (ids only, one per section) is the subscribers'. Never text, a content hash or a source id.
import { type AuditContext, audit } from "@chartwarden/audit";
import type { DbClient } from "@chartwarden/db";

export const SECTION_AMENDED_AUDIT_EVENT = "m8.encounter.section_amended";

export interface SectionsAmended {
  readonly encounterId: string;
  readonly addendumId: string;
  /** How many sections the addendum amended (a deselected section amends nothing). */
  readonly sectionCount: number;
}

export async function recordSectionsAmended(
  tx: DbClient,
  context: AuditContext,
  amended: SectionsAmended,
): Promise<void> {
  if (amended.sectionCount === 0) return;
  await audit(tx, context, {
    eventType: SECTION_AMENDED_AUDIT_EVENT,
    resourceKind: "encounter",
    resourceId: amended.encounterId,
    outcome: "success",
    severity: "info",
    retentionClass: "compliance",
    after: { addendumId: amended.addendumId, sectionCount: amended.sectionCount },
  });
}
