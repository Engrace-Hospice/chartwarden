// M31 ADR-0107 (PROPOSED) — the Drizzle store behind the STAFF signature-request routes (create / list / void). Runs under `withOrgContext` as the
// app role, so FORCEd RLS scopes every statement to the actor's tenant. The patient-facing view (`signature-store.ts`) deliberately hides voided
// requests and signer text; this one is for staff and shows status, who sent it and when, but still never the signer's typed name or reasons.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { M31EventEmitter } from "../events";

const SR = schema.portalSignatureRequests;
const UP = schema.portalDocumentUploads;
const GRANT = schema.portalAccessGrants;
const OPEN = ["pending", "uploaded_pending_review"] as const;
const LIST_LIMIT = 100;

/** Why a request was withdrawn. A fixed vocabulary, never free text: the column is not encrypted and a note typed here could carry PHI. */
export const VOID_REASONS = [
  "sent_in_error",
  "document_superseded",
  "patient_declined",
  "patient_unreachable",
  "signed_on_paper",
] as const;
export type VoidReason = (typeof VOID_REASONS)[number];

export interface StaffSignatureRequestView {
  readonly id: string;
  readonly patientId: string;
  readonly docKind: schema.PortalSignatureDocKind;
  readonly status: schema.PortalSignatureStatus;
  readonly templateKey: string;
  readonly templateVersion: string;
  readonly targetRef: string | null;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly lastRemindedAt: string | null;
  readonly reminderCount: number;
  readonly signedAt: string | null;
  readonly signerRole: schema.PortalSignerRole | null;
  readonly voidReason: string | null;
  /** The M22 document of the uploaded signed copy (open it in the document viewer); null when there is no upload. */
  readonly uploadedDocumentId: string | null;
  readonly reviewOutcome: "accepted" | "rejected" | null;
}

type Row = typeof SR.$inferSelect;
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const toStaffView = (
  r: Row,
  uploadedDocumentId: string | null = null,
): StaffSignatureRequestView => ({
  id: r.id,
  patientId: r.patientId,
  docKind: r.docKind,
  status: r.status,
  templateKey: r.templateKey,
  templateVersion: r.templateVersion,
  targetRef: r.targetRef,
  requestedBy: r.requestedBy,
  requestedAt: r.requestedAt.toISOString(),
  lastRemindedAt: iso(r.lastRemindedAt),
  reminderCount: r.reminderCount,
  signedAt: iso(r.signedAt),
  signerRole: r.signerRole ?? null,
  voidReason: r.voidReason ?? null,
  uploadedDocumentId,
  reviewOutcome: (r.reviewOutcome as "accepted" | "rejected" | null) ?? null,
});

type Tx = DbClient;
/** `withOrgContext` hands the callback a narrower executor type; the helpers below need the full query builder. */
const asDb = (tx: unknown): Tx => tx as Tx;
/** Views for rows, with the M22 document id of each uploaded copy resolved in ONE query. */
async function toStaffViews(tx: Tx, rows: readonly Row[]): Promise<StaffSignatureRequestView[]> {
  const uploadIds = rows.flatMap((r) =>
    r.uploadedDocumentUploadId ? [r.uploadedDocumentUploadId] : [],
  );
  const docs = uploadIds.length
    ? await tx
        .select({ id: UP.id, documentId: UP.documentId })
        .from(UP)
        .where(inArray(UP.id, uploadIds))
    : [];
  const byUpload = new Map(docs.map((d) => [d.id, d.documentId ?? null]));
  return rows.map((r) =>
    toStaffView(
      r,
      r.uploadedDocumentUploadId ? (byUpload.get(r.uploadedDocumentUploadId) ?? null) : null,
    ),
  );
}

/** What the review needs: the request, the uploaded copy, and the UPLOADER's live grant (who the copy is signed by). */
export interface ReviewTarget {
  readonly id: string;
  readonly patientId: string;
  readonly docKind: schema.PortalSignatureDocKind;
  readonly templateVersion: string;
  readonly status: schema.PortalSignatureStatus;
  readonly uploadId: string | null;
  readonly documentId: string | null;
  readonly uploaderAccountId: string | null;
  readonly uploaderGrant: {
    readonly grantKind: string;
    readonly sourceConsentRecordId: string;
  } | null;
}

export type ReviewOutcome =
  | { readonly ok: true; readonly request: StaffSignatureRequestView }
  | { readonly ok: false; readonly reason: "not_found" | "not_pending_review" };

export interface CreateSignatureRequestInput {
  readonly patientId: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly docKind: schema.PortalSignatureDocKind;
  readonly templateKey: string;
  readonly templateVersion: string;
  readonly targetRef: string | null;
  readonly requestedBy: string;
}

export type CreateOutcome =
  | { readonly created: true; readonly request: StaffSignatureRequestView }
  | { readonly created: false; readonly reason: "already_open"; readonly existingId: string };

export type VoidOutcome =
  | { readonly voided: true; readonly request: StaffSignatureRequestView }
  | { readonly voided: false; readonly reason: "not_found" | "not_open" };

export interface StaffSignatureStore {
  create(organizationId: string, input: CreateSignatureRequestInput): Promise<CreateOutcome>;
  get(organizationId: string, requestId: string): Promise<StaffSignatureRequestView | null>;
  listForPatient(
    organizationId: string,
    patientId: string,
  ): Promise<readonly StaffSignatureRequestView[]>;
  voidOpen(
    organizationId: string,
    requestId: string,
    voidedBy: string,
    reason: VoidReason,
  ): Promise<VoidOutcome>;
  loadForReview(organizationId: string, requestId: string): Promise<ReviewTarget | null>;
  /** uploaded_pending_review -> pending: the copy is refused and the patient may sign electronically or upload another. */
  rejectUpload(
    organizationId: string,
    requestId: string,
    reviewerId: string,
  ): Promise<ReviewOutcome>;
  /** uploaded_pending_review -> signed, once the authoritative record exists (`targetRef`). Evidence is the review itself. */
  markAccepted(
    organizationId: string,
    requestId: string,
    input: {
      readonly reviewerId: string;
      readonly uploadId: string;
      readonly targetRef: string;
      readonly signerGrantKind: string;
      readonly signerRole: schema.PortalSignerRole;
    },
  ): Promise<ReviewOutcome>;
}

/** `portal_document_upload.rejection_code` for a signed copy staff refused at review. */
export const SIGNED_COPY_REJECTED = "signed_copy_rejected_by_staff";

const isUniqueViolation = (err: unknown): boolean =>
  (err as { code?: string; cause?: { code?: string } })?.code === "23505" ||
  (err as { cause?: { code?: string } })?.cause?.code === "23505";

export function buildStaffSignatureStore(
  db: DbClient,
  events?: M31EventEmitter,
): StaffSignatureStore {
  const ctx = (organizationId: string, userId = "") => ({ organizationId, userId });
  const insertOrReportOpen = async (
    organizationId: string,
    input: CreateSignatureRequestInput,
  ): Promise<CreateOutcome> =>
    withOrgContext(db, ctx(organizationId, input.requestedBy), async (tx) => {
      // One open request per (patient, document kind): a second send would double-notify and race the signature. Answer with the open one
      // rather than relying on the unique index to throw, so the caller gets a clean 409 and the existing id.
      const [open] = await tx
        .select({ id: SR.id })
        .from(SR)
        .where(
          and(
            eq(SR.patientId, input.patientId),
            eq(SR.docKind, input.docKind),
            inArray(SR.status, [...OPEN]),
          ),
        )
        .limit(1);
      if (open) return { created: false, reason: "already_open", existingId: open.id } as const;
      const [row] = await tx
        .insert(SR)
        .values({
          organizationId,
          providerEntityId: input.providerEntityId,
          locationId: input.locationId,
          patientId: input.patientId,
          docKind: input.docKind,
          templateKey: input.templateKey,
          templateVersion: input.templateVersion,
          targetRef: input.targetRef,
          requestedBy: input.requestedBy,
        })
        .returning();
      const created = row as Row;
      await events?.emitInTx(
        tx,
        organizationId,
        "m31.signature_request.requested",
        { kind: "portal_signature_request", id: created.id },
        {
          requestId: created.id,
          patientId: created.patientId,
          docKind: created.docKind,
          templateVersion: created.templateVersion,
        },
      );
      return { created: true, request: toStaffView(created) } as const;
    });

  const openRequestId = (
    organizationId: string,
    input: CreateSignatureRequestInput,
  ): Promise<string | null> =>
    withOrgContext(db, ctx(organizationId, input.requestedBy), async (tx) => {
      const [open] = await tx
        .select({ id: SR.id })
        .from(SR)
        .where(
          and(
            eq(SR.patientId, input.patientId),
            eq(SR.docKind, input.docKind),
            inArray(SR.status, [...OPEN]),
          ),
        )
        .limit(1);
      return open?.id ?? null;
    });

  return {
    async create(organizationId, input) {
      try {
        return await insertOrReportOpen(organizationId, input);
      } catch (err) {
        // Two concurrent sends both pass the pre-check; the loser trips the one-open-request unique index. Same answer as the pre-check.
        if (!isUniqueViolation(err)) throw err;
        const existingId = await openRequestId(organizationId, input);
        if (!existingId) throw err;
        return { created: false, reason: "already_open", existingId };
      }
    },

    async get(organizationId, requestId) {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const [row] = await tx.select().from(SR).where(eq(SR.id, requestId)).limit(1);
        return row ? ((await toStaffViews(asDb(tx), [row]))[0] ?? null) : null;
      });
    },

    async listForPatient(organizationId, patientId) {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const rows = await tx
          .select()
          .from(SR)
          .where(eq(SR.patientId, patientId))
          .orderBy(desc(SR.requestedAt))
          .limit(LIST_LIMIT);
        return toStaffViews(asDb(tx), rows);
      });
    },

    async voidOpen(organizationId, requestId, voidedBy, reason) {
      return withOrgContext(db, ctx(organizationId, voidedBy), async (tx) => {
        const [row] = await tx
          .update(SR)
          .set({ status: "voided", voidedBy, voidReason: reason })
          .where(and(eq(SR.id, requestId), inArray(SR.status, [...OPEN])))
          .returning();
        if (row) {
          await events?.emitInTx(
            tx,
            organizationId,
            "m31.signature_request.voided",
            { kind: "portal_signature_request", id: row.id },
            {
              requestId: row.id,
              patientId: row.patientId,
              docKind: row.docKind,
              voidReason: reason,
            },
          );
          return {
            voided: true,
            request: (await toStaffViews(asDb(tx), [row]))[0] as StaffSignatureRequestView,
          } as const;
        }
        const [current] = await tx
          .select({ id: SR.id })
          .from(SR)
          .where(eq(SR.id, requestId))
          .limit(1);
        return { voided: false, reason: current ? "not_open" : "not_found" } as const;
      });
    },

    async loadForReview(organizationId, requestId) {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const [row] = await tx.select().from(SR).where(eq(SR.id, requestId)).limit(1);
        if (!row) return null;
        const [upload] = row.uploadedDocumentUploadId
          ? await tx.select().from(UP).where(eq(UP.id, row.uploadedDocumentUploadId)).limit(1)
          : [];
        // The copy is signed by whoever uploaded it, so its authority is the UPLOADER's grant, still live.
        const [grant] = upload
          ? await tx
              .select({
                grantKind: GRANT.grantKind,
                sourceConsentRecordId: GRANT.sourceConsentRecordId,
              })
              .from(GRANT)
              .where(
                and(
                  eq(GRANT.portalAccountId, upload.portalAccountId),
                  eq(GRANT.patientId, row.patientId),
                  isNull(GRANT.revokedAt),
                ),
              )
              .limit(1)
          : [];
        return {
          id: row.id,
          patientId: row.patientId,
          docKind: row.docKind,
          templateVersion: row.templateVersion,
          status: row.status,
          uploadId: row.uploadedDocumentUploadId ?? null,
          documentId: upload?.documentId ?? null,
          uploaderAccountId: upload?.portalAccountId ?? null,
          uploaderGrant: grant ?? null,
        };
      });
    },

    async rejectUpload(organizationId, requestId, reviewerId) {
      return withOrgContext(db, ctx(organizationId, reviewerId), async (tx) => {
        // Lock the request and read the copy being refused before the link is cleared.
        const [current] = await tx
          .select({ uploadId: SR.uploadedDocumentUploadId })
          .from(SR)
          .where(and(eq(SR.id, requestId), eq(SR.status, "uploaded_pending_review")))
          .for("update")
          .limit(1);
        const [row] = await tx
          .update(SR)
          .set({
            status: "pending",
            reviewOutcome: "rejected",
            reviewedBy: reviewerId,
            reviewedAt: sql`now()`,
            uploadedDocumentUploadId: null,
          })
          .where(and(eq(SR.id, requestId), eq(SR.status, "uploaded_pending_review")))
          .returning();
        if (!row) return reviewMiss(asDb(tx), requestId);
        // A refused copy can never be attached again, to this request or another: attach only takes `submitted` uploads.
        if (current?.uploadId) {
          await tx
            .update(UP)
            .set({ status: "rejected", rejectionCode: SIGNED_COPY_REJECTED })
            .where(eq(UP.id, current.uploadId));
        }
        await events?.emitInTx(
          tx,
          organizationId,
          "m31.signature_request.reviewed",
          { kind: "portal_signature_request", id: row.id },
          {
            requestId: row.id,
            patientId: row.patientId,
            docKind: row.docKind,
            decision: "rejected",
          },
        );
        return {
          ok: true,
          request: (await toStaffViews(asDb(tx), [row]))[0] as StaffSignatureRequestView,
        } as const;
      });
    },

    async markAccepted(organizationId, requestId, input) {
      return withOrgContext(db, ctx(organizationId, input.reviewerId), async (tx) => {
        const [row] = await tx
          .update(SR)
          .set({
            status: "signed",
            targetRef: input.targetRef,
            reviewOutcome: "accepted",
            reviewedBy: input.reviewerId,
            reviewedAt: sql`now()`,
            signerGrantKind: input.signerGrantKind,
            signerRole: input.signerRole,
          })
          .where(
            and(
              eq(SR.id, requestId),
              eq(SR.status, "uploaded_pending_review"),
              eq(SR.uploadedDocumentUploadId, input.uploadId),
            ),
          )
          .returning();
        if (!row) {
          // A retry, or a second reviewer, that lands on the SAME consent already recorded: the same answer, nothing re-emitted.
          const [current] = await tx.select().from(SR).where(eq(SR.id, requestId)).limit(1);
          if (current?.status === "signed" && current.targetRef === input.targetRef) {
            return {
              ok: true,
              request: (await toStaffViews(asDb(tx), [current]))[0] as StaffSignatureRequestView,
            } as const;
          }
          return reviewMiss(asDb(tx), requestId);
        }
        const common = { requestId: row.id, patientId: row.patientId, docKind: row.docKind };
        const aggregate = { kind: "portal_signature_request", id: row.id } as const;
        await events?.emitInTx(tx, organizationId, "m31.signature_request.reviewed", aggregate, {
          ...common,
          decision: "accepted",
        });
        await events?.emitInTx(tx, organizationId, "m31.signature_request.signed", aggregate, {
          ...common,
          signerRole: input.signerRole,
          signerGrantKind: input.signerGrantKind,
        });
        return {
          ok: true,
          request: (await toStaffViews(asDb(tx), [row]))[0] as StaffSignatureRequestView,
        } as const;
      });
    },
  };
}

async function reviewMiss(tx: Tx, requestId: string): Promise<ReviewOutcome> {
  const [current] = await tx.select({ id: SR.id }).from(SR).where(eq(SR.id, requestId)).limit(1);
  return { ok: false, reason: current ? "not_pending_review" : "not_found" };
}
