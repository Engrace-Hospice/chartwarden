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
  type IsoInstant,
  ORG_LIBRARY_DOCUMENT_AGGREGATE_TYPES,
  type OrgDocumentAccessProvider,
  type OrgDocumentDenialReason,
  type OrgId,
  SEAM_ONLY_DOCUMENT_AGGREGATE_TYPES,
} from "@chartwarden/types";
import { deriveTenantBucket, planSignedUrl } from "../lifecycle/storage";
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

/** CW-BR-10 — what the destroy needs to know about one document: its type, owner, state, hold and EVERY version's object key. */
export interface OrgDocumentDestroyTarget {
  readonly aggregateType: string;
  readonly patientId: string | null;
  readonly status: string;
  /** An unreleased M22 hold row, status `legal_hold`, or Part 2 class. */
  readonly held: boolean;
  readonly objectKeys: readonly string[];
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
  /** CW-BR-10 — at most `limit` org-level, not-yet-destroyed documents of one type created before the cutoff, oldest first. */
  listPurgeCandidates(args: {
    readonly organizationId: OrgId;
    readonly aggregateType: DocumentAggregateType;
    readonly createdBefore: Date;
    readonly limit: number;
  }): Promise<
    readonly { readonly documentId: string; readonly createdAt: Date; readonly held: boolean }[]
  >;
  /** CW-BR-10 — the facts the destroy decides on; null when the document is not visible. */
  loadDestroyTarget(args: {
    readonly organizationId: OrgId;
    readonly documentId: string;
  }): Promise<OrgDocumentDestroyTarget | null>;
  /**
   * CW-BR-10 — after the objects are gone: status `destroyed_tombstone`, no active version, every version's in-row cipher shredded, in ONE transaction.
   * False when the row is no longer `active`/`superseded` or a hold landed since the check (nothing is changed then).
   */
  markDestroyed(args: {
    readonly organizationId: OrgId;
    readonly documentId: string;
  }): Promise<boolean>;
}

export interface OrgDocumentAccessDeps {
  readonly port: OrgDocumentAccessPort;
  /** `presign` serves the mints; `destroyAllVersions` serves the retention destroy (CW-BR-10). Absent => a destroy refuses by throwing, before anything is touched. */
  readonly objects: Pick<ObjectStorePort, "presign"> &
    Partial<Pick<ObjectStorePort, "destroyAllVersions">>;
  readonly accessLog: StaffMintAccessLogPort;
  /** ADR-0109 D10 (PR 3) — the portal ledger the library mint writes through. Unbound => every portal mint throws (no un-logged URL). */
  readonly portalAccessLog?: PortalAccessLogPort;
}

/** CW-BR-10 — the most one object key's version-aware delete may take before it is aborted (list plus deletes of a few versions). */
const ORG_DOCUMENT_DESTROY_TIMEOUT_MS = 60_000;

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
  async listPurgeCandidates() {
    return [];
  },
  async loadDestroyTarget() {
    return null;
  },
  async markDestroyed() {
    return false;
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

    async listOrgDocumentsForPurge(args) {
      // Only a seam-only type (M16's mailing batch) is ever listed: never a library item, a patient's document or another module's.
      if (!SEAM_ONLY_DOCUMENT_AGGREGATE_TYPES.has(args.aggregateType)) {
        return { denied: true, reason: "wrong_type" };
      }
      const limit = Math.max(1, Math.floor(args.limit));
      const rows = await deps.port.listPurgeCandidates({
        organizationId: args.organizationId,
        aggregateType: args.aggregateType,
        createdBefore: new Date(args.createdBefore),
        limit: limit + 1, // one more than asked: its presence is what says "truncated"
      });
      return {
        documents: rows.slice(0, limit).map((r) => ({
          documentId: r.documentId as DocumentId,
          createdAt: r.createdAt.toISOString() as IsoInstant,
          held: r.held,
        })),
        truncated: rows.length > limit,
      };
    },

    async destroyOrgDocument(args) {
      const target = await deps.port.loadDestroyTarget({
        organizationId: args.organizationId,
        documentId: args.documentId,
      });
      if (target === null) return { refused: true, reason: "not_found" };
      if (
        !SEAM_ONLY_DOCUMENT_AGGREGATE_TYPES.has(target.aggregateType as DocumentAggregateType) ||
        !args.allowedAggregateTypes.some((t) => t === target.aggregateType)
      ) {
        return { refused: true, reason: "wrong_type" };
      }
      if (target.patientId !== null) return { refused: true, reason: "not_org_level" };
      if (target.status === "destroyed_tombstone") {
        return { refused: true, reason: "already_destroyed" };
      }
      if (target.held || target.status === "legal_hold") return { refused: true, reason: "held" };

      // OBJECTS BEFORE ROWS (the eraser's order): a failed delete throws with the rows, and so the keys, still in place; the next run retries.
      // No object store bound for deletes => refuse loudly before anything is touched (never "destroy" the row of an object that is still there).
      const destroyAllVersions = deps.objects.destroyAllVersions;
      if (destroyAllVersions === undefined) {
        throw new Error("org-document destroy refused: no object store is bound for deletes");
      }
      const bucket = deriveTenantBucket(args.organizationId);
      for (const objectKey of target.objectKeys) {
        // Bounded: the caller may hold M4's per-org hold lock across this call, so a hung store must time out (the file then counts as failed and the lock goes).
        await destroyAllVersions.call(deps.objects, {
          bucket,
          objectKey,
          organizationId: args.organizationId,
          signal: AbortSignal.timeout(ORG_DOCUMENT_DESTROY_TIMEOUT_MS),
        });
      }
      const marked = await deps.port.markDestroyed({
        organizationId: args.organizationId,
        documentId: args.documentId,
      });
      // False = a hold (or another writer) got in after the check: the objects are gone, the row stays as it was. Its own answer, so the caller alarms.
      return marked
        ? { destroyed: true, objectVersionsDestroyed: target.objectKeys.length }
        : { refused: true, reason: "held_after_destroy" };
    },
  };
}

export type { DocumentId };
