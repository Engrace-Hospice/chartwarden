// M31 ADR-0107 (PROPOSED) — the Drizzle store behind the STAFF signature-request routes (create / list / void). Runs under `withOrgContext` as the
// app role, so FORCEd RLS scopes every statement to the actor's tenant. The patient-facing view (`signature-store.ts`) deliberately hides voided
// requests and signer text; this one is for staff and shows status, who sent it and when, but still never the signer's typed name or reasons.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, desc, eq, inArray } from "drizzle-orm";

const SR = schema.portalSignatureRequests;
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
}

type Row = typeof SR.$inferSelect;
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const toStaffView = (r: Row): StaffSignatureRequestView => ({
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
});

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
}

export function buildStaffSignatureStore(db: DbClient): StaffSignatureStore {
  const ctx = (organizationId: string, userId = "") => ({ organizationId, userId });
  return {
    async create(organizationId, input) {
      return withOrgContext(db, ctx(organizationId, input.requestedBy), async (tx) => {
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
        return { created: true, request: toStaffView(row as Row) } as const;
      });
    },

    async get(organizationId, requestId) {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const [row] = await tx.select().from(SR).where(eq(SR.id, requestId)).limit(1);
        return row ? toStaffView(row) : null;
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
        return rows.map(toStaffView);
      });
    },

    async voidOpen(organizationId, requestId, voidedBy, reason) {
      return withOrgContext(db, ctx(organizationId, voidedBy), async (tx) => {
        const [row] = await tx
          .update(SR)
          .set({ status: "voided", voidedBy, voidReason: reason })
          .where(and(eq(SR.id, requestId), inArray(SR.status, [...OPEN])))
          .returning();
        if (row) return { voided: true, request: toStaffView(row) } as const;
        const [current] = await tx
          .select({ id: SR.id })
          .from(SR)
          .where(eq(SR.id, requestId))
          .limit(1);
        return { voided: false, reason: current ? "not_open" : "not_found" } as const;
      });
    },
  };
}
