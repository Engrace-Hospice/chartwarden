// apps/backend/src/modules/22-documents/seams/org-document-access.ts — ADR-0109 D10 the `OrgDocumentAccessProvider` impl: the ORG-LEVEL document
// door. A module that owns a document with NO patient (M16's mailing batch PDF) mints its short-lived download URL through M22 here, rather than
// reading M22's tables or keeping a bucket key of its own.
//
// NOT A GENERAL DOCUMENT DOOR. The caller names the aggregate types it may hand out, and the seam INTERSECTS that list with
// `SEAM_ONLY_DOCUMENT_AGGREGATE_TYPES` (a type M22's own routes serve is never handed out here, whatever the caller asks); it refuses a document of any
// other type, a document that belongs to a patient (those go through the caseload-scoped routes), and one that is not `active` (legal hold, destroyed
// tombstone, superseded). Every refusal is the same `{ denied }` family: the caller learns no more than "no". The ACCESSOR is not the caller's to name:
// it is the active membership of the request context's (org, user), so the ledger row cannot be pinned on someone else; no request context, a system
// actor, another org or no active membership throws (no URL). A successful mint appends ONE `document_access_log` row BEFORE the URL is returned
// (§164.528); a failed append throws and no URL leaves. The URL is never logged (§4.12) and is signed to be served as an attachment.
import { getRequestContext } from "@chartwarden/tenancy";
import {
  type DocumentAggregateType,
  type DocumentId,
  type DocumentVersionId,
  ORG_LIBRARY_DOCUMENT_AGGREGATE_TYPES,
  type OrgDocumentAccessProvider,
  type OrgDocumentDenialReason,
  type OrgId,
  SEAM_ONLY_DOCUMENT_AGGREGATE_TYPES,
} from "@chartwarden/types";
import { planSignedUrl } from "../lifecycle/storage";
import type { StaffMintAccessLogPort } from "../routes/signed-url-service";
import type { PortalAccessLogPort } from "./readers-store";
import type { ObjectStorePort } from "./store";

/** The org-scoped facts of one document and its active version. */
export interface OrgDocumentFacts {
  readonly documentId: string;
  readonly aggregateType: string;
  /** Null for an org-level document; anything else is refused. */
  readonly patientId: string | null;
  readonly status: string;
  readonly activeVersionId: string | null;
  /** The active version's object key. */
  readonly objectKey: string | null;
  /** The active version's MIME type and size (ADR-0109 D10, PR 3: the library describes and serves them). */
  readonly mimeType: string | null;
  readonly byteSize: number | null;
}

/** The data port the provider composes over (Drizzle under the caller's request context in prod; a Map in tests). */
export interface OrgDocumentAccessPort {
  loadDocument(args: {
    readonly organizationId: OrgId;
    readonly documentId: string;
  }): Promise<OrgDocumentFacts | null>;
  /** The ACTIVE membership of (organization, user), or null (pending, suspended, revoked, none). */
  activeMembershipId(args: {
    readonly organizationId: OrgId;
    readonly userId: string;
  }): Promise<string | null>;
}

export interface OrgDocumentAccessDeps {
  readonly port: OrgDocumentAccessPort;
  readonly objects: Pick<ObjectStorePort, "presign">;
  readonly accessLog: StaffMintAccessLogPort;
  /** ADR-0109 D10 (PR 3) — the portal ledger the library mint writes through. Unbound => every portal mint throws (no un-logged URL). */
  readonly portalAccessLog?: PortalAccessLogPort;
}

/** Every type the staff door may hand out: the seam-only internal types plus the org-level library types. */
const STAFF_DOOR_TYPES: ReadonlySet<string> = new Set<string>([
  ...SEAM_ONLY_DOCUMENT_AGGREGATE_TYPES,
  ...ORG_LIBRARY_DOCUMENT_AGGREGATE_TYPES,
]);

type Refusal = { readonly denied: true; readonly reason: OrgDocumentDenialReason };
type Servable = OrgDocumentFacts & { readonly activeVersionId: string; readonly objectKey: string };

/** The shared gates: the type (caller list INTERSECTED with what this door serves), org-level, active, with an active version. */
function gate(
  facts: OrgDocumentFacts | null,
  callerTypes: readonly DocumentAggregateType[],
  doorTypes: ReadonlySet<string>,
): Servable | Refusal {
  if (facts === null) return { denied: true, reason: "not_found" };
  if (!callerTypes.some((t) => doorTypes.has(t) && t === facts.aggregateType)) {
    return { denied: true, reason: "wrong_type" };
  }
  if (facts.patientId !== null) return { denied: true, reason: "not_org_level" };
  if (facts.status !== "active") return { denied: true, reason: "not_active" };
  if (facts.activeVersionId === null || facts.objectKey === null) {
    return { denied: true, reason: "no_active_version" };
  }
  return facts as Servable;
}

/**
 * The served Content-Type. A rendered internal PDF is stored as octet-stream, so it is always served as `application/pdf`; a hand-uploaded library item
 * keeps its VERIFIED MIME (a `video/mp4` streams in a media element). Always an attachment: a tab never renders the document inline.
 */
const responseTypeOf = (facts: OrgDocumentFacts): string =>
  ORG_LIBRARY_DOCUMENT_AGGREGATE_TYPES.has(facts.aggregateType as DocumentAggregateType) &&
  facts.mimeType !== null
    ? facts.mimeType
    : "application/pdf";

/** The deny-everything port a boot with no database binds: every mint answers `not_found`. */
export const REFUSING_ORG_DOCUMENT_ACCESS_PORT: OrgDocumentAccessPort = {
  async loadDocument() {
    return null;
  },
  async activeMembershipId() {
    return null;
  },
};

/** The requesting member, from the ambient request context only. Throws (no URL) when it cannot be established. */
async function accessorOf(port: OrgDocumentAccessPort, organizationId: OrgId): Promise<string> {
  const ctx = getRequestContext();
  if (!ctx || ctx.systemActor || ctx.userId.length === 0 || ctx.organizationId !== organizationId) {
    throw new Error("org-document mint refused: no requesting member in this request context");
  }
  const membershipId = await port.activeMembershipId({ organizationId, userId: ctx.userId });
  if (membershipId === null) {
    throw new Error("org-document mint refused: the requesting member has no active membership");
  }
  return membershipId;
}

export function createOrgDocumentAccessProvider(
  deps: OrgDocumentAccessDeps,
): OrgDocumentAccessProvider {
  return {
    async mintOrgDownloadUrl(args) {
      const facts = gate(
        await deps.port.loadDocument({
          organizationId: args.organizationId,
          documentId: args.documentId,
        }),
        args.allowedAggregateTypes,
        STAFF_DOOR_TYPES,
      );
      if ("denied" in facts) return facts;
      const accessorMembershipId = await accessorOf(deps.port, args.organizationId);

      const descriptor = planSignedUrl({
        organizationId: args.organizationId,
        objectKey: facts.objectKey,
        accessKind: "signed_url_issued",
      });
      const { url, expiresAt } = await deps.objects.presign({
        descriptor,
        organizationId: args.organizationId,
        // a download, never rendered inline in the browser tab
        responseOverrides: { contentDisposition: "attachment", contentType: responseTypeOf(facts) },
      });
      // The ledger row lands after every gate and the presign, before the URL leaves: no un-logged URL is released.
      await deps.accessLog.append({
        organizationId: args.organizationId,
        documentId: facts.documentId,
        documentVersionId: facts.activeVersionId,
        patientId: null,
        accessorMembershipId,
        accessKind: "signed_url_issued",
        purpose: "operations",
        recipientClass: null,
        correlationId:
          getRequestContext()?.correlationId ?? `org-doc-mint:${facts.activeVersionId}`,
      });
      return {
        url,
        expiresAt,
        documentVersionId: facts.activeVersionId as DocumentVersionId,
      };
    },

    async describeOrgDocument(args) {
      const facts = gate(
        await deps.port.loadDocument({
          organizationId: args.organizationId,
          documentId: args.documentId,
        }),
        args.allowedAggregateTypes,
        STAFF_DOOR_TYPES,
      );
      if ("denied" in facts) return facts;
      return {
        mimeType: facts.mimeType ?? "application/octet-stream",
        byteSize: facts.byteSize ?? 0,
      };
    },

    async mintPortalLibraryUrl(args) {
      // The portal door serves the library types ONLY: never a seam-only, internal or patient document.
      const facts = gate(
        await deps.port.loadDocument({
          organizationId: args.organizationId,
          documentId: args.documentId,
        }),
        [...ORG_LIBRARY_DOCUMENT_AGGREGATE_TYPES],
        ORG_LIBRARY_DOCUMENT_AGGREGATE_TYPES,
      );
      if ("denied" in facts) return facts;
      if (deps.portalAccessLog === undefined) {
        throw new Error("org-document portal mint refused: no portal access ledger is bound");
      }
      const descriptor = planSignedUrl({
        organizationId: args.organizationId,
        objectKey: facts.objectKey,
        accessKind: "signed_url_issued",
      });
      const { url, expiresAt } = await deps.objects.presign({
        descriptor,
        organizationId: args.organizationId,
        responseOverrides: { contentDisposition: "attachment", contentType: responseTypeOf(facts) },
      });
      // The ledger row (the family's account and session) lands before the URL leaves.
      await deps.portalAccessLog.appendPortalDownload({
        organizationId: args.organizationId,
        documentId: facts.documentId as DocumentId,
        documentVersionId: facts.activeVersionId as DocumentVersionId,
        patientId: null,
        portalAccountId: args.portalAccountId,
        portalSessionId: args.portalSessionId,
        correlationId:
          getRequestContext()?.correlationId ?? `org-doc-portal-mint:${facts.activeVersionId}`,
        accessedAt: new Date().toISOString() as never,
      });
      return {
        url,
        expiresAt,
        documentVersionId: facts.activeVersionId as DocumentVersionId,
      };
    },
  };
}

export type { DocumentId };
