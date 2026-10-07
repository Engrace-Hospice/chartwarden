// apps/web/src/modules/06-admission/election-addendum-api.ts — typed calls for the FY2027 election statement
// addendum (42 CFR 418.24(c)/(d)). The server owns every state change and its guards (ADR-0030); a failed
// call surfaces the server's message so the clinician sees why (e.g. the missing (c) elements on furnish).
import type { ApiClient } from "@wardenx/ui";
import { type UploadStage, verifiedUpload } from "../../shell/document-workflows";

export type AddendumStatus =
  | "draft"
  | "furnished"
  | "signed"
  | "refused"
  | "signature_not_required"
  | "not_required";

export type ItemCategory = "condition" | "item" | "service" | "drug";

export interface AddendumItem {
  category: ItemCategory;
  description: string;
  reasonNotCovered: string;
  source?: "problem" | "medication" | "dme" | "supply" | "service";
  sourceId?: string;
}

export interface AddendumDiagnosis {
  icd10Code: string | null;
  description: string;
}

/** How the (c)(9) acknowledgement was captured: keyed in WardenX, or a scanned signed paper copy. */
export type AcknowledgementSource = "structured" | "uploaded";

export interface AddendumVersion {
  id: string;
  admissionId: string;
  patientId: string;
  versionNumber: number;
  trigger: "initial" | "poc_change";
  triggerCause: string | null;
  triggeredAt: string;
  status: AddendumStatus;
  hospiceName: string | null;
  patientName: string | null;
  medicalRecordNumber: string | null;
  terminalDiagnosis: AddendumDiagnosis[];
  relatedDiagnoses: AddendumDiagnosis[];
  items: AddendumItem[];
  noNonCoveredItems: boolean;
  clinicalExplanation: string | null;
  guidelineReferences: string | null;
  dueAt: string | null;
  furnishedAt: string | null;
  furnishMethod: "paper" | "electronic_with_paper_copy" | null;
  signedAt: string | null;
  signerKind: "beneficiary" | "representative" | null;
  representativeName: string | null;
  representativeRelationship: string | null;
  acknowledgementSource: AcknowledgementSource | null;
  acknowledgementDocumentId: string | null;
  acknowledgementDocumentVersionId: string | null;
  refusedAt: string | null;
  refusalReason: string | null;
  signatureNotRequiredReason: "death" | "revocation" | "discharge" | null;
  signatureNotRequiredNote: string | null;
  documentId: string | null;
  supersededById: string | null;
  version: number;
}

export interface AddendumOverview {
  admissionId: string;
  required: boolean;
  electionEffectiveDate: string | null;
  inCare: boolean;
  current: AddendumVersion | null;
  history: AddendumVersion[];
  openWindows: { id: string; kind: string; status: string; dueAt: string }[];
}

export interface AddendumDraftPatch {
  items?: AddendumItem[];
  noNonCoveredItems?: boolean;
  clinicalExplanation?: string | null;
  guidelineReferences?: string | null;
}

/** A scanned paper copy of the addendum: the file, what the paper shows, and its dates (ISO instants). */
export type ScannedCopyInput = {
  file: File;
  /** When the paper was handed over — required when the version was never furnished in WardenX. */
  furnishedAt?: string;
  onStage: (stage: UploadStage) => void;
} & (
  | {
      outcome: "signed";
      signerKind: "beneficiary" | "representative";
      representativeName?: string | null;
      representativeRelationship?: string | null;
      signedAt: string;
    }
  | { outcome: "refused"; reason: string; refusedAt?: string }
);

export interface ElectionAddendumApi {
  overview(admissionId: string): Promise<AddendumOverview>;
  draft(admissionId: string): Promise<AddendumOverview>;
  save(
    admissionId: string,
    v: AddendumVersion,
    patch: AddendumDraftPatch,
  ): Promise<AddendumVersion>;
  furnish(
    admissionId: string,
    v: AddendumVersion,
    method: "paper" | "electronic_with_paper_copy",
  ): Promise<AddendumVersion>;
  sign(
    admissionId: string,
    v: AddendumVersion,
    input: {
      signerKind: "beneficiary" | "representative";
      representativeName?: string | null;
      representativeRelationship?: string | null;
    },
  ): Promise<AddendumVersion>;
  refuse(admissionId: string, v: AddendumVersion, reason: string): Promise<AddendumVersion>;
  notRequired(
    admissionId: string,
    v: AddendumVersion,
    reason: "death" | "revocation" | "discharge",
    note: string | null,
  ): Promise<AddendumVersion>;
  /** Upload the scanned paper copy to M22 (verified-upload ceremony), then attach it as the acknowledgement. */
  attachScannedCopy(
    admissionId: string,
    v: AddendumVersion,
    input: ScannedCopyInput,
  ): Promise<AddendumVersion>;
  /** A short-lived URL for a document version; with no version, the document's newest one (the render). */
  documentUrl(documentId: string, versionId: string | null): Promise<string>;
}

/** The server's own message when present, else a plain fallback. */
export function apiMessage(error: unknown, fallback: string): string {
  const e = error as { message?: unknown; error?: { message?: unknown } } | null | undefined;
  const msg = typeof e?.message === "string" ? e.message : e?.error?.message;
  return typeof msg === "string" && msg.length > 0 ? msg : fallback;
}

function unwrap<T>(res: { data?: unknown; error?: unknown }, fallback: string): T {
  if (res.error || res.data === undefined) throw new Error(apiMessage(res.error, fallback));
  return res.data as T;
}

/** Reject a body that is not an addendum overview (never render a half-shaped read as truth). */
function asOverview(data: unknown, fallback: string): AddendumOverview {
  const o = data as Partial<AddendumOverview> | null | undefined;
  if (!o || !Array.isArray(o.history) || !Array.isArray(o.openWindows)) throw new Error(fallback);
  return o as AddendumOverview;
}

const BASE = "/api/v1/admissions/{id}/election-addendum/{addendumId}" as const;

export function createElectionAddendumApi(client: ApiClient): ElectionAddendumApi {
  const path = (admissionId: string, v: AddendumVersion) => ({
    params: { path: { id: admissionId, addendumId: v.id } },
  });
  return {
    async overview(admissionId) {
      return asOverview(
        unwrap(
          await client.GET("/api/v1/admissions/{id}/election-addendum", {
            params: { path: { id: admissionId } },
          }),
          "Could not load the election addendum.",
        ),
        "Could not load the election addendum.",
      );
    },
    async draft(admissionId) {
      return asOverview(
        unwrap(
          await client.POST("/api/v1/admissions/{id}/election-addendum", {
            params: { path: { id: admissionId } },
            body: {},
          }),
          "Could not draft the addendum.",
        ),
        "Could not draft the addendum.",
      );
    },
    async save(admissionId, v, patch) {
      return unwrap(
        await client.PATCH(BASE, {
          ...path(admissionId, v),
          body: { ifVersion: v.version, ...patch },
        }),
        "Could not save the addendum.",
      );
    },
    async furnish(admissionId, v, method) {
      return unwrap(
        await client.POST(`${BASE}/furnish`, {
          ...path(admissionId, v),
          body: { ifVersion: v.version, method },
        }),
        "Could not furnish the addendum.",
      );
    },
    async sign(admissionId, v, input) {
      return unwrap(
        await client.POST(`${BASE}/signature`, {
          ...path(admissionId, v),
          body: { ifVersion: v.version, ...input },
        }),
        "Could not record the signature.",
      );
    },
    async refuse(admissionId, v, reason) {
      return unwrap(
        await client.POST(`${BASE}/refusal`, {
          ...path(admissionId, v),
          body: { ifVersion: v.version, reason },
        }),
        "Could not record the refusal.",
      );
    },
    async attachScannedCopy(admissionId, v, input) {
      const { file, onStage, ...rest } = input;
      const uploaded = await verifiedUpload(client, {
        context: { kind: "patient", patientId: v.patientId, admissionId } as never,
        mode: "new_document",
        file,
        title:
          rest.outcome === "signed"
            ? `Election addendum v${v.versionNumber} — signed paper copy`
            : `Election addendum v${v.versionNumber} — refusal on paper`,
        documentType: "election_addendum",
        patientFacing: false,
        sourceMetadata: {
          documentType: "election_addendum",
          sourceChannel: "scanned_physical",
          receivedAt: new Date().toISOString(),
          originalFilename: file.name,
        },
        onStage,
      });
      const ids = {
        documentId: uploaded.documentId,
        documentVersionId: uploaded.documentVersionId,
      };
      const fail = "The scan uploaded, but it could not be attached to the addendum.";
      if (rest.outcome === "signed") {
        const { outcome: _o, ...signature } = rest;
        return unwrap(
          await client.POST(`${BASE}/signature/uploaded-evidence`, {
            ...path(admissionId, v),
            body: { ifVersion: v.version, ...ids, ...signature },
          }),
          fail,
        );
      }
      const { outcome: _o, ...refusal } = rest;
      return unwrap(
        await client.POST(`${BASE}/refusal/uploaded-evidence`, {
          ...path(admissionId, v),
          body: { ifVersion: v.version, ...ids, ...refusal },
        }),
        fail,
      );
    },
    async documentUrl(documentId, versionId) {
      const fail = "The document is not available.";
      let id = versionId;
      if (!id) {
        const versions = unwrap<{ items: { id: string; versionNumber: number }[] }>(
          await client.GET("/api/v1/documents/{id}/versions", {
            params: { path: { id: documentId } },
          }),
          fail,
        );
        id = [...versions.items].sort((a, b) => b.versionNumber - a.versionNumber)[0]?.id ?? null;
        if (!id) throw new Error(fail);
      }
      const minted = unwrap<{ url?: string }>(
        await client.GET("/api/v1/documents/{id}/versions/{versionId}/content", {
          params: {
            path: { id: documentId, versionId: id },
            query: { purpose: "treatment", ttlSeconds: 300 },
          },
        }),
        fail,
      );
      if (!minted.url) throw new Error(fail);
      return minted.url;
    },
    async notRequired(admissionId, v, reason, note) {
      return unwrap(
        await client.POST(`${BASE}/signature-not-required`, {
          ...path(admissionId, v),
          body: { ifVersion: v.version, reason, note },
        }),
        "Could not record that a signature is not required.",
      );
    },
  };
}
