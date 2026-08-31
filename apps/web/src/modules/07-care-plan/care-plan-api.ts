import type { ApiClient } from "@wardenx/ui";

export interface SignerSlot {
  role: string;
  count: number;
}

export interface SignatureView {
  signerRole: string;
  signedAt: string | null;
}

export interface Version {
  id: string;
  planId: string;
  sequence: number;
  kind: string;
  status: string;
  idgMeetingId: string | null;
  requiredSignerSet: SignerSlot[];
  signatures: SignatureView[];
  draftedAt: string | null;
  signedAt: string | null;
  supersededAt: string | null;
  stateSnapshot?: unknown;
  patientUnderstandingText?: string | null;
  version: number;
}

export interface Problem {
  id: string;
  planId: string;
  icd10Code: string | null;
  snomedCode: string | null;
  description: string;
  kind: string;
  source: string;
  sudRelated: boolean;
  status: string;
  onsetAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  version: number;
}

export interface Goal {
  id: string;
  planId: string;
  problemId: string;
  originalText: string;
  revisedText: string | null;
  source: string;
  actingConsentId: string | null;
  measurableOutcome: string | null;
  targetAt: string | null;
  status: string;
  statusNote: string | null;
  version: number;
}

export interface Intervention {
  id: string;
  planId: string;
  problemId: string;
  goalRefs: string[];
  scopeText: string;
  frequencyText: string;
  frequencyValue: string;
  discipline: string;
  responsibleRole: string | null;
  linkedOrderId: string | null;
  status: string;
  discontinueReason: string | null;
  version: number;
}

export interface CarePlan {
  id: string;
  patientId: string;
  admissionId: string;
  status: string;
  activeVersionId: string | null;
  version: number;
  versions: Version[];
  problems: Problem[];
  goals: Goal[];
  interventions: Intervention[];
  redacted: boolean;
}

export interface PatientSummary {
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

export interface Readiness {
  planId: string;
  openVersionId: string | null;
  openVersionStatus?: string;
  canFinalize: boolean;
  canSign: boolean;
  blockers: { code: string; message: string }[];
  signatures: {
    required: SignerSlot[];
    collected: SignatureView[];
    missing: SignerSlot[];
  };
}

export interface ReviewStatus {
  planId: string;
  nextReviewDueAt: string | null;
  status: "not_due" | "due" | "overdue" | "review_in_progress";
  overdueByDays: number;
  openReviewVersionId: string | null;
  openReviewVersionStatus: string | null;
  canStartReview: boolean;
}

export interface ProposedChange {
  id: string;
  proposalId: string;
  decisionId: string;
  entityType: string;
  operation: string;
  targetId: string | null;
  before: unknown;
  proposed: unknown;
  status: string;
}

export interface ProposedChanges {
  versionId: string;
  kind: string;
  meetingId: string | null;
  status: string;
  proposals: {
    id: string;
    decisionId: string;
    meetingId: string;
    sourceOutboxEventId: string;
    status: string;
    proposedAt: string | null;
    inReviewAt: string | null;
    appliedAt: string | null;
    conflictReason: string | null;
  }[];
  changes: ProposedChange[];
}

export interface ClinicalSnapshot {
  problems?: Problem[];
  goals?: Goal[];
  interventions?: Intervention[];
}

export function idemKey(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `m7-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

export function writeHeaders(version?: number | null): Record<string, string> {
  const header: Record<string, string> = { "Idempotency-Key": idemKey() };
  if (version != null) header["If-Match"] = String(version);
  return header;
}

export function errorMessage(error: unknown, fallback: string): string {
  const body = error as {
    title?: string;
    detail?: string;
    code?: string;
    status?: number;
    blockers?: { code?: string; message?: string }[];
  } | null;
  if (body?.blockers?.length) return body.blockers.map((b) => b.message ?? b.code).join("; ");
  if (body?.detail) return body.detail;
  if (body?.title) return body.title;
  if (body?.status === 409) return "Another open revision already exists. Reload to continue it.";
  if (body?.status === 412)
    return "This record changed while you were working. Reload before saving again.";
  if (body?.status === 422) return "The Care Plan is not ready for this action.";
  if (body?.status === 403) return "You do not have access to this action for this patient.";
  return fallback;
}

export function normalizeSignerSet(raw: unknown): SignerSlot[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry === "string") return [{ role: entry, count: 1 }];
    const e = entry as { role?: unknown; count?: unknown };
    if (typeof e.role !== "string") return [];
    return [{ role: e.role, count: typeof e.count === "number" ? e.count : 1 }];
  });
}

function normalizeVersion(raw: unknown): Version {
  const v = raw as Version & { requiredSignerSet?: unknown };
  return { ...v, requiredSignerSet: normalizeSignerSet(v.requiredSignerSet) };
}

export async function getCarePlanWorkspace(
  client: ApiClient,
  patientId: string,
): Promise<{
  plan: CarePlan | null;
  patient: PatientSummary | null;
  readiness: Readiness | null;
  review: ReviewStatus | null;
  error: unknown;
}> {
  const [planRes, patRes] = await Promise.all([
    client.GET("/api/v1/patients/{patientId}/care-plan", { params: { path: { patientId } } }),
    client.GET("/api/v1/patients/{id}", { params: { path: { id: patientId } } }),
  ]);
  if (planRes.error) {
    return { plan: null, patient: null, readiness: null, review: null, error: planRes.error };
  }
  const patient = patRes.data ? (patRes.data as PatientSummary) : null;
  const data = planRes.data;
  if (!data || !("id" in data) || !data.id) {
    return { plan: null, patient, readiness: null, review: null, error: null };
  }
  const plan = {
    ...(data as unknown as CarePlan),
    versions: ((data as unknown as CarePlan).versions ?? []).map(normalizeVersion),
  };
  const [readinessRes, reviewRes] = await Promise.all([
    client.GET("/api/v1/care-plans/{planId}/readiness", { params: { path: { planId: plan.id } } }),
    client.GET("/api/v1/care-plans/{planId}/review-status", {
      params: { path: { planId: plan.id } },
    }),
  ]);
  return {
    plan,
    patient,
    readiness: readinessRes.error ? null : (readinessRes.data as Readiness),
    review: reviewRes.error ? null : (reviewRes.data as ReviewStatus),
    error: readinessRes.error ?? reviewRes.error ?? null,
  };
}

export async function getProposedChanges(
  client: ApiClient,
  planId: string,
  versionId: string,
): Promise<{ proposed: ProposedChanges | null; error: unknown }> {
  const res = await client.GET(
    "/api/v1/care-plans/{planId}/versions/{versionId}/proposed-changes",
    {
      params: { path: { planId, versionId } },
    },
  );
  if (res.error) return { proposed: null, error: res.error };
  return { proposed: res.data as ProposedChanges, error: null };
}

export async function getVersion(
  client: ApiClient,
  planId: string,
  versionId: string,
): Promise<{ version: Version | null; error: unknown }> {
  const res = await client.GET("/api/v1/care-plans/{planId}/versions/{versionId}", {
    params: { path: { planId, versionId } },
  });
  if (res.error) return { version: null, error: res.error };
  return { version: normalizeVersion(res.data), error: null };
}
