// @wardenx/dosespot — the DoseSpot v2 REST endpoint table (M12 GAP-037 close-out).
//
// SOURCE OF TRUTH FOR "WHAT WAS CHECKED". DoseSpot's public documentation (docs.dosespot.com) is a portal that
// needs a login for the field-level reference; what is publicly retrievable is the staging swagger
// (https://my.staging.dosespot.com/webapi/v2/swagger/docs/FullV2) and community clients generated from it.
// Every entry below carries how far it was verified:
//   • `swagger`   — the PATH, METHOD and operation id appear in the public v2 swagger (FullV2).
//   • `sandbox`   — the path/method is the best reading of the documented flow but was NOT confirmed by a
//                   spec we could read; it needs a DoseSpot sandbox call before it can be trusted. The adapter
//                   still calls it (so the sandbox run exercises it) but the boot log and docs/history list it.
//   • `none`      — no endpoint could be found at all; the adapter FAILS CLOSED with a non-retryable
//                   `DegradedError` ("not available against the verified API surface") rather than inventing a
//                   path. Nothing is ever reported as sent.
// Field-level request/response shapes are isolated in ./mappers.ts for the same reason.
export type EndpointVerification = "swagger" | "sandbox" | "none";

export interface DoseSpotEndpoint {
  readonly method: "GET" | "POST" | "PUT";
  /** Path under `<baseUrl>`; `{name}` segments are substituted by the caller. */
  readonly path: string;
  readonly verification: EndpointVerification;
  readonly swaggerOperationId?: string;
}

/** The OAuth2 token endpoint. Absent from the public swagger; documented only in vendor onboarding material
 * and mirrored by community clients (Basic clinicId:clinicKey, form grant_type=password, Username=clinicianId,
 * Password=clinicKey, plus the `Subscription-Key` header). */
export const TOKEN_ENDPOINT: DoseSpotEndpoint = {
  method: "POST",
  path: "/connect/token",
  verification: "sandbox",
};

export const DOSESPOT_ENDPOINTS = {
  addPatient: {
    method: "POST",
    path: "/api/patients",
    verification: "swagger",
    swaggerOperationId: "Patients_AddPatientV2",
  },
  editPatient: {
    method: "PUT",
    path: "/api/patients/{patientId}",
    verification: "swagger",
    swaggerOperationId: "Patients_EditPatientDemographicDataV2",
  },
  addCodedPrescription: {
    method: "POST",
    path: "/api/patients/{patientId}/prescriptions/coded",
    verification: "swagger",
    swaggerOperationId: "Prescriptions_AddCodedPrescriptionV2",
  },
  sendPrescriptions: {
    method: "POST",
    path: "/api/patients/{patientId}/prescriptions/send",
    verification: "swagger",
    swaggerOperationId: "Prescriptions_SendPrescriptionsV2",
  },
  getPatientPrescriptions: {
    method: "GET",
    path: "/api/patients/{patientId}/prescriptions",
    verification: "swagger",
    swaggerOperationId: "Prescriptions_GetPatientPrescriptionsV2",
  },
  getMedicationHistory: {
    method: "GET",
    path: "/api/patients/{patientId}/medications/history",
    verification: "swagger",
    swaggerOperationId: "MedicationHistory_GetMedicationHistoryV2",
  },
  logMedicationHistoryConsent: {
    method: "POST",
    path: "/api/patients/{patientId}/medications/history/consent",
    verification: "swagger",
    swaggerOperationId: "MedicationHistory_LogPatientMedicationHistoryConsentV2",
  },
  addClinician: {
    method: "POST",
    path: "/api/clinicians",
    verification: "swagger",
    swaggerOperationId: "Clinicians_ClinicianAddV2",
  },
  // No refill / renewal respond endpoint, rx-benefit lookup, or clinician revoke appears in the public swagger.
  respondToRefillRequest: { method: "POST", path: "", verification: "none" },
  lookupRxBenefit: { method: "POST", path: "", verification: "none" },
  revokeClinician: { method: "PUT", path: "", verification: "none" },
  initiateEpcsSigning: { method: "POST", path: "", verification: "none" },
} as const satisfies Record<string, DoseSpotEndpoint>;

export type DoseSpotEndpointName = keyof typeof DOSESPOT_ENDPOINTS;

/** Substitute `{name}` segments (URL-encoded). Throws on a missing value so a bad call never hits the wire. */
export function buildPath(template: string, params: Readonly<Record<string, string>> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const value = params[name];
    if (value === undefined || value === "") throw new Error(`missing path parameter ${name}`);
    return encodeURIComponent(value);
  });
}

/** Everything the boot log / docs must disclose: endpoints used that were not confirmed by the swagger. */
export function unverifiedEndpoints(): readonly string[] {
  const all: Record<string, DoseSpotEndpoint> = { token: TOKEN_ENDPOINT, ...DOSESPOT_ENDPOINTS };
  return Object.entries(all)
    .filter(([, e]) => e.verification !== "swagger")
    .map(([name, e]) => `${name}:${e.verification}`);
}
