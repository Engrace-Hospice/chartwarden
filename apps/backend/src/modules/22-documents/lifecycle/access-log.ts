// apps/backend/src/modules/22-documents/lifecycle/access-log.ts — M22-T03 (§2.4 / §3.3 / §164.528).
//
// The `document_access_log` append: every PHI-bearing document access (metadata read, content download,
// signed-URL issue/consume, portal view, disclosure export) appends one immutable log row. This module
// returns the append as a pure DATA descriptor — the service writes the partitioned row inside the access
// transaction. The log is append-only and never cascade-deleted by the eraser within the §164.528
// disclosure-accounting retention floor (ADR-0013 / D12). PHI never enters the descriptor: `purpose` and
// `recipientClass` are denylisted columns (M22_AUDIT_DENYLIST) so they never reach the M4 audit values.
import type {
  DocumentAccessKind,
  DocumentAccessPurpose,
  DocumentId,
  DocumentVersionId,
  IsoInstant,
  MembershipId,
  OrgId,
} from "@chartwarden/types";

/** An append-only `document_access_log` row the service persists (§3.3). Mirrors the table columns; the
 * `correlationId` ties a signed-URL issue to its later consume. */
export interface DocumentAccessLogEntry {
  readonly organizationId: OrgId;
  readonly documentId: DocumentId;
  readonly documentVersionId: DocumentVersionId;
  readonly accessorMembershipId: MembershipId;
  readonly accessKind: DocumentAccessKind;
  readonly purpose: DocumentAccessPurpose;
  readonly recipientMembershipId: MembershipId | null;
  readonly recipientClass: string | null;
  readonly correlationId: string;
  readonly accessedAt: IsoInstant;
}

/** The §4.10 outbox event a signed-URL access emits, if any. Metadata reads + content downloads are
 * audit-only; signed-URL issue/consume + disclosure export carry an outbox event for the M4 accounting
 * surface. `null` ⇒ audit-only (no outbox). */
function outboxForAccess(
  accessKind: DocumentAccessKind,
): "m22.signed_url.issued" | "m22.signed_url.consumed" | "m22.phi_bundle.exported" | null {
  switch (accessKind) {
    case "signed_url_issued":
      return "m22.signed_url.issued";
    case "signed_url_consumed":
      return "m22.signed_url.consumed";
    case "disclosure_export":
      return "m22.phi_bundle.exported";
    default:
      return null;
  }
}

/** The full plan a document access produces: the append-only log row + the M4 `auditRead` marker + the
 * optional §4.10 outbox event. */
export interface AccessLogPlan {
  readonly entry: DocumentAccessLogEntry;
  readonly outboxEvent:
    | "m22.signed_url.issued"
    | "m22.signed_url.consumed"
    | "m22.phi_bundle.exported"
    | null;
}

/**
 * Plan a document access-log append (§2.4). Pure: assembles the immutable {@link DocumentAccessLogEntry}
 * and resolves the optional §4.10 outbox event. The service appends the row + runs `auditRead()` + (if
 * present) publishes the event in the access transaction. The descriptor carries no free-text PHI — the
 * `purpose` is an enum value, never a narrative string.
 */
export function planAccessLog(args: {
  readonly organizationId: OrgId;
  readonly documentId: DocumentId;
  readonly documentVersionId: DocumentVersionId;
  readonly accessorMembershipId: MembershipId;
  readonly accessKind: DocumentAccessKind;
  readonly purpose: DocumentAccessPurpose;
  readonly correlationId: string;
  readonly accessedAt: IsoInstant;
  readonly recipientMembershipId?: MembershipId | null;
  readonly recipientClass?: string | null;
}): AccessLogPlan {
  return {
    entry: {
      organizationId: args.organizationId,
      documentId: args.documentId,
      documentVersionId: args.documentVersionId,
      accessorMembershipId: args.accessorMembershipId,
      accessKind: args.accessKind,
      purpose: args.purpose,
      recipientMembershipId: args.recipientMembershipId ?? null,
      recipientClass: args.recipientClass ?? null,
      correlationId: args.correlationId,
      accessedAt: args.accessedAt,
    },
    outboxEvent: outboxForAccess(args.accessKind),
  };
}
