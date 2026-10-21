// apps/backend/src/modules/22-documents/access-log/portal-disclosures.ts - the read side of M22's
// `document_access_log` for a patient's section 164.528 accounting (GAP-052).
//
// `document_access_log` is M22-owned, so M31's `PortalDisclosureAccountingProvider` reaches it through THIS
// reader (bound at the composition root) rather than naming the table itself. Only PORTAL-accessor rows are
// returned (a portal account disclosed the chart to a family member / DPOA); staff reads of the same chart are
// M4's read-audit trail, not this ledger. The columns projected are ids, the access kind and the instant -
// never `purpose` / `recipient_class` (audit-denylisted, section 3.6).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, desc, eq, gte, isNotNull, lte } from "drizzle-orm";

/** A single accounting query never returns more than this many lines; the window narrows the rest. */
export const PORTAL_DISCLOSURE_PAGE_LIMIT = 1000;

export interface PortalDisclosureRow {
  readonly portalAccountId: string;
  readonly patientId: string;
  readonly documentId: string;
  readonly accessKind: string;
  readonly accessedAt: Date;
}

export type PortalDisclosureReader = (
  organizationId: string,
  patientId: string,
  from: Date,
  to: Date,
) => Promise<readonly PortalDisclosureRow[]>;

const { documentAccessLog } = schema;

/** Newest first, bounded by {@link PORTAL_DISCLOSURE_PAGE_LIMIT}, org-scoped through `withOrgContext` (RLS). */
export function buildPortalDisclosureReader(db: DbClient): PortalDisclosureReader {
  return (organizationId, patientId, from, to) =>
    withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const rows = await tx
        .select({
          portalAccountId: documentAccessLog.accessorPortalAccountId,
          patientId: documentAccessLog.patientId,
          documentId: documentAccessLog.documentId,
          accessKind: documentAccessLog.accessKind,
          accessedAt: documentAccessLog.accessedAt,
        })
        .from(documentAccessLog)
        .where(
          and(
            eq(documentAccessLog.organizationId, organizationId),
            eq(documentAccessLog.patientId, patientId),
            isNotNull(documentAccessLog.accessorPortalAccountId),
            gte(documentAccessLog.accessedAt, from),
            lte(documentAccessLog.accessedAt, to),
          ),
        )
        .orderBy(desc(documentAccessLog.accessedAt))
        .limit(PORTAL_DISCLOSURE_PAGE_LIMIT);
      return rows.flatMap((r) =>
        r.portalAccountId === null || r.patientId === null
          ? []
          : [
              {
                portalAccountId: r.portalAccountId,
                patientId: r.patientId,
                documentId: r.documentId,
                accessKind: r.accessKind,
                accessedAt: r.accessedAt,
              },
            ],
      );
    });
}
