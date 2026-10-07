// apps/web/src/modules/06-admission/election-addendum-api.ts — typed calls for the FY2027 election statement
// addendum (42 CFR 418.24(c)/(d)). The server owns every state change and its guards (ADR-0030); a failed
// call surfaces the server's message so the clinician sees why (e.g. the missing (c) elements on furnish).
import type { ApiClient } from "@wardenx/ui";

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

export interface AddendumVersion {
  id: string;
  admissionId: string;
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
