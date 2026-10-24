// apps/web/src/modules/25-remittance — the access layer for milestone 13a: beneficiary-filed appeals and appointments of
// representative. Every wire shape is an alias into the generated `operations` map. The server owns every rule and refusal; no
// deadline, validity period, form element or representative rule is computed, defaulted or hard-coded on this side.
import type { ApiClient, operations } from "@chartwarden/ui";
import { type WriteResult, failure, guarded, ifMatch, ok } from "./remittance-api";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Ok<Op> = Op extends { responses: { 200: infer R } } ? Json<R> : never;
type ReqBody<Op> = Op extends { requestBody?: infer RB } ? Json<RB> : never;

export type ClaimBeneficiaryAppeals = Ok<operations["getApiV1ClaimsByClaimIdBeneficiaryappeals"]>;
export type BeneficiaryAppeal = ClaimBeneficiaryAppeals["items"][number];
export type BeneficiaryIntakeInput = ReqBody<
  operations["postApiV1ClaimsByClaimIdBeneficiaryappeals"]
>;
export type BeneficiaryPatchInput = ReqBody<operations["patchApiV1BeneficiaryappealsById"]>;
export type BeneficiaryMoveInput = ReqBody<operations["postApiV1BeneficiaryappealsByIdState"]>;
export type BeneficiaryVersioned = Ok<operations["postApiV1BeneficiaryappealsByIdState"]>;

export type ClaimAppointments = Ok<operations["getApiV1ClaimsByClaimIdRepresentativeappointments"]>;
export type Appointment = ClaimAppointments["items"][number];
export type AppointmentDraftInput = ReqBody<
  operations["postApiV1ClaimsByClaimIdRepresentativeappointments"]
>;
export type AppointmentPatchInput = ReqBody<operations["patchApiV1RepresentativeappointmentsById"]>;
export type AppointmentVersioned = Ok<operations["patchApiV1RepresentativeappointmentsById"]>;
export type AppointmentActivated = Ok<operations["postApiV1RepresentativeappointmentsByIdActivate"]>;
export type FormVersionsPage = Ok<operations["getApiV1Representativeformversions"]>;
export type FormVersion = FormVersionsPage["items"][number];
export type FormVersionInput = ReqBody<operations["postApiV1Representativeformversions"]>;

export const FILER_KINDS = ["beneficiary", "representative"] as const;
export const TIER_LABELS = [
  "redetermination",
  "reconsideration",
  "alj",
  "council",
  "federal_court",
  "other",
] as const;
export const OUTCOME_LABELS = [
  "favorable",
  "partial",
  "unfavorable",
  "dismissed",
  "other",
] as const;
export const REPRESENTATIVE_KINDS = [
  "family_or_friend",
  "legal_representative",
  "attorney",
  "other",
] as const;

// ── beneficiary appeals ─────────────────────────────────────────────────────────────────────────────────

export async function loadBeneficiaryAppeals(
  client: ApiClient,
  claimId: string,
): Promise<WriteResult<ClaimBeneficiaryAppeals>> {
  return guarded(async () => {
    const { data, error, response } = await client.GET(
      "/api/v1/claims/{claimId}/beneficiary-appeals",
      {
        params: { path: { claimId } },
      },
    );
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function recordBeneficiaryAppeal(
  client: ApiClient,
  claimId: string,
  body: BeneficiaryIntakeInput,
): Promise<WriteResult<BeneficiaryVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST(
      "/api/v1/claims/{claimId}/beneficiary-appeals",
      { params: { path: { claimId } }, body },
    );
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function patchBeneficiaryAppeal(
  client: ApiClient,
  a: Pick<BeneficiaryAppeal, "id" | "version">,
  body: BeneficiaryPatchInput,
): Promise<WriteResult<BeneficiaryVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.PATCH("/api/v1/beneficiary-appeals/{id}", {
      params: { path: { id: a.id } },
      headers: ifMatch(a.version),
      body,
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function moveBeneficiaryAppeal(
  client: ApiClient,
  a: Pick<BeneficiaryAppeal, "id" | "version">,
  body: BeneficiaryMoveInput,
): Promise<WriteResult<BeneficiaryVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/beneficiary-appeals/{id}/state", {
      params: { path: { id: a.id } },
      headers: ifMatch(a.version),
      body,
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function attachBeneficiaryDocument(
  client: ApiClient,
  a: Pick<BeneficiaryAppeal, "id" | "version">,
  body: { documentId: string; documentVersionId: string },
): Promise<WriteResult<BeneficiaryVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST(
      "/api/v1/beneficiary-appeals/{id}/documents",
      { params: { path: { id: a.id } }, headers: ifMatch(a.version), body },
    );
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function detachBeneficiaryDocument(
  client: ApiClient,
  a: Pick<BeneficiaryAppeal, "id" | "version">,
  documentId: string,
): Promise<WriteResult<BeneficiaryVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST(
      "/api/v1/beneficiary-appeals/{id}/documents/{documentId}/remove",
      { params: { path: { id: a.id, documentId } }, headers: ifMatch(a.version) },
    );
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

// ── appointments of representative ─────────────────────────────────────────────────────────────────────

export async function loadAppointments(
  client: ApiClient,
  claimId: string,
): Promise<WriteResult<ClaimAppointments>> {
  return guarded(async () => {
    const { data, error, response } = await client.GET(
      "/api/v1/claims/{claimId}/representative-appointments",
      { params: { path: { claimId } } },
    );
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function createAppointmentDraft(
  client: ApiClient,
  claimId: string,
  body: AppointmentDraftInput,
): Promise<WriteResult<AppointmentVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST(
      "/api/v1/claims/{claimId}/representative-appointments",
      { params: { path: { claimId } }, body },
    );
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function patchAppointment(
  client: ApiClient,
  a: Pick<Appointment, "id" | "version">,
  body: AppointmentPatchInput,
): Promise<WriteResult<AppointmentVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.PATCH(
      "/api/v1/representative-appointments/{id}",
      {
        params: { path: { id: a.id } },
        headers: ifMatch(a.version),
        body,
      },
    );
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function attachAppointmentDocument(
  client: ApiClient,
  a: Pick<Appointment, "id" | "version">,
  body: { documentId: string; documentVersionId: string },
): Promise<WriteResult<AppointmentVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.PUT(
      "/api/v1/representative-appointments/{id}/document",
      { params: { path: { id: a.id } }, headers: ifMatch(a.version), body },
    );
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function confirmAppointmentElements(
  client: ApiClient,
  a: Pick<Appointment, "id" | "version">,
  confirmedLabels: string[],
): Promise<WriteResult<AppointmentVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.PUT(
      "/api/v1/representative-appointments/{id}/elements",
      { params: { path: { id: a.id } }, headers: ifMatch(a.version), body: { confirmedLabels } },
    );
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function activateAppointment(
  client: ApiClient,
  a: Pick<Appointment, "id" | "version">,
): Promise<WriteResult<AppointmentActivated>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST(
      "/api/v1/representative-appointments/{id}/activate",
      { params: { path: { id: a.id } }, headers: ifMatch(a.version) },
    );
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function revokeAppointment(
  client: ApiClient,
  a: Pick<Appointment, "id" | "version">,
  body: { revokedOn: string; note: string },
): Promise<WriteResult<AppointmentVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST(
      "/api/v1/representative-appointments/{id}/revoke",
      { params: { path: { id: a.id } }, headers: ifMatch(a.version), body },
    );
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

// ── the organization's form versions ───────────────────────────────────────────────────────────────────

export async function loadFormVersions(client: ApiClient): Promise<WriteResult<FormVersionsPage>> {
  return guarded(async () => {
    const { data, error, response } = await client.GET("/api/v1/representative-form-versions", {});
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function createFormVersion(
  client: ApiClient,
  body: FormVersionInput,
): Promise<WriteResult<AppointmentVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/representative-form-versions", {
      body,
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function retireFormVersion(
  client: ApiClient,
  f: Pick<FormVersion, "id" | "version">,
): Promise<WriteResult<AppointmentVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST(
      "/api/v1/representative-form-versions/{id}/retire",
      { params: { path: { id: f.id } }, headers: ifMatch(f.version) },
    );
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}
