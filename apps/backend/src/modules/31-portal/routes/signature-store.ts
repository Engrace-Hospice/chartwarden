// M31 ADR-0107 (PROPOSED) — the Drizzle store behind the portal signature-request routes. Every read and write runs under
// `withOrgContext` as the app role (FORCEd RLS on `portal_signature_request`), and every patient-facing read is narrowed to the SESSION's
// patient here, not left to the caller: a request id from another patient of the same tenant answers "not found", never its contents.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ConflictError } from "@chartwarden/types";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { M31EventEmitter } from "../events";
import type {
  SignatureRequestRecord,
  SignatureRequestStore,
} from "../write-paths/sign-admission-document";

const SR = schema.portalSignatureRequests;
const GRANT = schema.portalAccessGrants;
const UP = schema.portalDocumentUploads;

type Row = typeof SR.$inferSelect;

/** What the portal shows for a request: ids, kinds, status and instants. Never the signer's typed name, relationship or reason. */
export interface SignatureRequestView {
  readonly id: string;
  readonly docKind: schema.PortalSignatureDocKind;
  readonly status: schema.PortalSignatureStatus;
  readonly templateKey: string;
  readonly templateVersion: string;
  readonly requestedAt: string;
  readonly signedAt: string | null;
  readonly signerRole: schema.PortalSignerRole | null;
}

const toView = (r: Row): SignatureRequestView => ({
  id: r.id,
  docKind: r.docKind,
  status: r.status,
  templateKey: r.templateKey,
  templateVersion: r.templateVersion,
  requestedAt: r.requestedAt.toISOString(),
  signedAt: r.signedAt ? r.signedAt.toISOString() : null,
  signerRole: r.signerRole ?? null,
});

const toRecord = (r: Row): SignatureRequestRecord => ({
  id: r.id,
  patientId: r.patientId,
  docKind: r.docKind,
  status: r.status,
  targetRef: r.targetRef,
  templateVersion: r.templateVersion,
});

export interface PortalSignatureStore extends SignatureRequestStore {
  /** The session patient's requests, newest first. Voided requests are not shown to the patient. */
  listForPatient(
    organizationId: string,
    patientId: string,
  ): Promise<readonly SignatureRequestView[]>;
  viewForPatient(
    organizationId: string,
    patientId: string,
    requestId: string,
  ): Promise<SignatureRequestView | null>;
  /** Park the request in `uploaded_pending_review` with the session account's completed signed-copy upload. Never marks it signed (D6). */
  attachSignedCopy(
    organizationId: string,
    input: {
      readonly patientId: string;
      readonly portalAccountId: string;
      readonly requestId: string;
      readonly uploadId: string;
    },
  ): Promise<AttachOutcome>;
  /** The account's ACTIVE grant for the patient: its kind, and the consent it was issued from. */
  activeGrantSource(
    organizationId: string,
    portalAccountId: string,
    patientId: string,
  ): Promise<{ readonly grantKind: string; readonly sourceConsentRecordId: string } | null>;
}

export type AttachOutcome =
  | { readonly ok: true; readonly request: SignatureRequestView }
  | {
      readonly ok: false;
      readonly code: "request_not_found" | "request_not_pending" | "upload_not_usable";
    };

const SHOWN_TO_PATIENT = ["pending", "uploaded_pending_review", "signed"] as const;
const LIST_LIMIT = 100;

export function buildPortalSignatureStore(
  db: DbClient,
  events?: M31EventEmitter,
): PortalSignatureStore {
  const ctx = (organizationId: string) => ({ organizationId, userId: "" });
  return {
    async get(organizationId, requestId) {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const [row] = await tx.select().from(SR).where(eq(SR.id, requestId)).limit(1);
        return row ? toRecord(row) : null;
      });
    },

    async markSigned(organizationId, requestId, input) {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const [updated] = await tx
          .update(SR)
          .set({
            status: "signed",
            targetRef: input.targetRef,
            signedByPortalAccountId: input.signer.portalAccountId,
            signerGrantKind: input.signer.grantKind,
            signerRole: input.signerRole,
            signedTypedName: input.statement.signedTypedName.trim(),
            signerRelationshipText: input.statement.signerRelationshipText?.trim() || null,
            patientUnableReason: input.statement.patientUnableReason?.trim() || null,
            attestationSha256: input.statement.attestationSha256,
            portalSessionId: input.signer.portalSessionId,
            idempotencyKey: input.statement.idempotencyKey,
          })
          .where(
            and(eq(SR.id, requestId), inArray(SR.status, ["pending", "uploaded_pending_review"])),
          )
          .returning();
        if (updated) {
          await events?.emitInTx(
            tx,
            organizationId,
            "m31.signature_request.signed",
            { kind: "portal_signature_request", id: updated.id },
            {
              requestId: updated.id,
              patientId: updated.patientId,
              docKind: updated.docKind,
              signerRole: input.signerRole,
              signerGrantKind: input.signer.grantKind,
            },
          );
          return toRecord(updated);
        }
        // A concurrent retry signed it first: the request is final, return it as it stands.
        const [current] = await tx.select().from(SR).where(eq(SR.id, requestId)).limit(1);
        if (current?.status === "signed") return toRecord(current);
        // Staff voided it between the portal's check and this write (the authoritative M06/M39 record is already signed): a typed 409,
        // never a bare 500. The voided request stays terminal; staff reconcile the orphaned record from the audit trail.
        throw new ConflictError(
          "This request was withdrawn while you were signing. Please contact your care team.",
        );
      });
    },

    async listForPatient(organizationId, patientId) {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const rows = await tx
          .select()
          .from(SR)
          .where(and(eq(SR.patientId, patientId), inArray(SR.status, [...SHOWN_TO_PATIENT])))
          .orderBy(desc(SR.requestedAt))
          .limit(LIST_LIMIT);
        return rows.map(toView);
      });
    },

    async viewForPatient(organizationId, patientId, requestId) {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const [row] = await tx
          .select()
          .from(SR)
          .where(and(eq(SR.id, requestId), eq(SR.patientId, patientId)))
          .limit(1);
        return row && row.status !== "voided" ? toView(row) : null;
      });
    },

    async attachSignedCopy(organizationId, input) {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const [req] = await tx
          .select()
          .from(SR)
          .where(and(eq(SR.id, input.requestId), eq(SR.patientId, input.patientId)))
          .limit(1);
        if (!req || req.status === "voided")
          return { ok: false, code: "request_not_found" } as const;
        if (req.status !== "pending") return { ok: false, code: "request_not_pending" } as const;
        // The upload must be THIS session account's, for THIS patient, a signed-copy upload that has completed (so it is a real M22 document),
        // and not already attached to another request.
        const [upload] = await tx
          .select({ id: UP.id })
          .from(UP)
          .where(
            and(
              eq(UP.id, input.uploadId),
              eq(UP.portalAccountId, input.portalAccountId),
              eq(UP.patientId, input.patientId),
              eq(UP.purpose, "signed_admission_document"),
              eq(UP.status, "submitted"),
              isNotNull(UP.documentId),
            ),
          )
          .limit(1);
        if (!upload) return { ok: false, code: "upload_not_usable" } as const;
        const [taken] = await tx
          .select({ id: SR.id })
          .from(SR)
          .where(eq(SR.uploadedDocumentUploadId, input.uploadId))
          .limit(1);
        if (taken) return { ok: false, code: "upload_not_usable" } as const;
        const [updated] = await tx
          .update(SR)
          .set({ status: "uploaded_pending_review", uploadedDocumentUploadId: input.uploadId })
          .where(and(eq(SR.id, input.requestId), eq(SR.status, "pending")))
          .returning();
        if (!updated) return { ok: false, code: "request_not_pending" } as const;
        await events?.emitInTx(
          tx,
          organizationId,
          "m31.signature_request.uploaded",
          { kind: "portal_signature_request", id: updated.id },
          { requestId: updated.id, patientId: updated.patientId, docKind: updated.docKind },
        );
        return { ok: true, request: toView(updated) } as const;
      });
    },

    async activeGrantSource(organizationId, portalAccountId, patientId) {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const [g] = await tx
          .select({
            grantKind: GRANT.grantKind,
            sourceConsentRecordId: GRANT.sourceConsentRecordId,
          })
          .from(GRANT)
          .where(
            and(
              eq(GRANT.portalAccountId, portalAccountId),
              eq(GRANT.patientId, patientId),
              isNull(GRANT.revokedAt),
            ),
          )
          .limit(1);
        return g ?? null;
      });
    },
  };
}
