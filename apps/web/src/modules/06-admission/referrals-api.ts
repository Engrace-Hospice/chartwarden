import type { ApiClient } from "@wardenx/ui";

export type ReferralStatus =
  | "received"
  | "under_review"
  | "pending_information"
  | "qualified"
  | "declined"
  | "duplicate"
  | "withdrawn"
  | "converted";

export type PatientResolutionStatus = "unresolved" | "possible_match" | "matched" | "created";
export type ReferralPriority = "routine" | "high" | "urgent";

export interface QualificationBlocker {
  code: string;
  message: string;
}

export interface ReferralView {
  id: string;
  state: ReferralStatus;
  status: ReferralStatus;
  version: number;
  patientId: string | null;
  patientResolutionStatus: PatientResolutionStatus;
  patientNameAtReceipt: string;
  patientDobAtReceipt: string | null;
  referringDxText: string | null;
  icd10TerminalPrimary: string | null;
  source: string;
  referrerName: string | null;
  referrerOrganization: string | null;
  referrerPhone: string | null;
  externalReferralId: string | null;
  priority: ReferralPriority;
  assignedToUserId: string | null;
  receivedAt: string;
  reviewedAt: string | null;
  qualifiedAt: string | null;
  declinedAt: string | null;
  convertedAt: string | null;
  convertedAdmissionId: string | null;
  rejectionReason: string | null;
  qualificationBlockers: QualificationBlocker[];
}

export interface ReferralNote {
  id: string;
  referralId: string;
  authorId: string | null;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReferralActivity {
  id: string;
  referralId: string;
  actorId: string | null;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ReferralCandidate {
  id?: string;
  patientId?: string;
  name?: string;
  displayName?: string;
  dob?: string | null;
  mrn?: string | null;
  phoneLast4?: string | null;
  confidence?: string | number | null;
  score?: number | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ReferralListQuery {
  status?: string;
  source?: string;
  patientResolutionStatus?: string;
  priority?: string;
  assigned?: "mine" | "unassigned";
  q?: string;
  cursor?: string;
  limit?: number;
}

type DynamicClient = {
  POST: (
    path: string,
    init?: unknown,
  ) => Promise<{ data?: unknown; error?: unknown; response?: Response }>;
  PATCH: (
    path: string,
    init?: unknown,
  ) => Promise<{ data?: unknown; error?: unknown; response?: Response }>;
};

export async function listReferrals(
  client: ApiClient,
  query: ReferralListQuery,
): Promise<Page<ReferralView>> {
  const { data, error } = await client.GET("/api/v1/referrals", {
    params: { query },
  } as never);
  if (error) throw error;
  return (data ?? { items: [], nextCursor: null }) as Page<ReferralView>;
}

export async function getReferral(client: ApiClient, id: string): Promise<ReferralView> {
  const { data, error } = await client.GET("/api/v1/referrals/{id}", {
    params: { path: { id } },
  });
  if (error || !data) throw error ?? new Error("Referral not found");
  return data as ReferralView;
}

export async function createReferral(
  client: ApiClient,
  body: Record<string, unknown>,
): Promise<{ id: string; state: string; version: number }> {
  const { data, error } = await client.POST("/api/v1/referrals", { body } as never);
  if (error || !data) throw error ?? new Error("Referral create failed");
  return data as { id: string; state: string; version: number };
}

export async function patchReferral(
  client: ApiClient,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  const { error } = await client.PATCH("/api/v1/referrals/{id}", {
    params: { path: { id } },
    body,
  } as never);
  if (error) throw error;
}

export async function referralCommand<T = { id: string; state: string; version: number }>(
  client: ApiClient,
  id: string,
  command: string,
  body: Record<string, unknown>,
): Promise<T> {
  const api = client as unknown as DynamicClient;
  const { data, error } = await api.POST(`/api/v1/referrals/${id}/${command}`, {
    body,
  });
  if (error || !data) throw error ?? new Error("Referral command failed");
  return data as T;
}

export async function listReferralNotes(client: ApiClient, id: string): Promise<ReferralNote[]> {
  const { data, error } = await client.GET("/api/v1/referrals/{id}/notes", {
    params: { path: { id } },
  });
  if (error) throw error;
  return ((data as { items?: ReferralNote[] } | undefined)?.items ?? []) as ReferralNote[];
}

export async function listReferralActivity(
  client: ApiClient,
  id: string,
): Promise<ReferralActivity[]> {
  const { data, error } = await client.GET("/api/v1/referrals/{id}/activity", {
    params: { path: { id } },
  });
  if (error) throw error;
  return ((data as { items?: ReferralActivity[] } | undefined)?.items ?? []) as ReferralActivity[];
}
