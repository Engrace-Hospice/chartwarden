// apps/web/src/modules/18-evv — the M18 WRITE access layer the §5.1 screens share
// (Track B / ADR-0030; #91).
//
// Until this file, `apps/web/src/modules/18-evv` issued ZERO mutations: nine read screens, every one a
// read. EVV is a FEDERAL requirement — the 21st Century Cures Act obliges every state Medicaid programme
// to verify home-visit delivery electronically, and a visit with no verified bracket is a visit the state
// aggregator will not accept and the payer will not pay. The three queues on this surface are the ones a
// human has to work for that to happen, and none of them had a control:
//
//   • the MISSING-EVV RESOLUTION queue. A capture that never arrived — dead handset, no signal, a
//     clinician who forgot — opens an `evv_missing_resolution` row, and an OPEN row is what blocks the
//     visit downstream (a `documented_missing` close never gates a Medicare claim, ADR-0008; an
//     `unresolved_missing` one does). Closing it is a human attestation, on a §7.3 24-hour clock for the
//     clinician and a §7.4 7-day one for a supervisor. With no control, every row aged out of both.
//   • the AGGREGATOR SUBMISSION queue. A state rejection is fixed and resubmitted by an operator (§7.9);
//     a submission for a voided visit is cancelled so the state never sees it. Neither was callable.
//   • the DEVICE roster. Capture requires an APPROVED `evv_device` (D8) — `resolveApprovedDevice` refuses
//     the capture outright without one. A clinician who self-registered from the handset sat in
//     `pending_approval` until someone approved them, and nothing on this platform could.
//
// The geofence policy is the fourth: tenant tighten-only defaults and per-address overrides are what
// decide whether a capture reads `pass` or `outside_geofence`, and a rural address whose driveway sits
// 180m from the road-network centroid produces a false breach on every single visit until someone
// overrides it.
//
// Every wire shape below is a TYPE ALIAS into the generated `operations` map, never a hand-copied
// interface — the same rule the other modules' api layers follow.
//
// WHAT THE SERVER OWNS, WHICH NOTHING HERE RE-DECIDES (ADR-0030 — no frontend authz).
//
//   • §2.2.4 D6 — the resolution machine. Whether this caller is the assigned clinician, whether the
//     24h/7d window is still open, and whether the reason clears its floor are all decided server-side;
//     the refusals come back as named codes and are surfaced verbatim.
//   • §2.2.5 D7 — the submission machine. Resubmit is legal only from `rejected`/`timeout`, cancel only
//     from a non-terminal status. The status lists below narrow which button to OFFER on a row; they are
//     not a gate, and a row whose status this build does not recognise keeps its actions.
//   • §2.2.2 tighten-only — the tenant may narrow below the 200m/50m platform floor and never loosen
//     past it. The form states the floor; the server enforces it and answers 422.
//   • §2.3 — the correction-of-record and the D6 supervisor override require fresh M2 step-up, resolved
//     from the session. Nothing here asserts it.
import type { ApiClient, operations } from "@wardenx/ui";

// ── schema-derived type extraction ─────────────────────────────────────────────────────────────────────

/** The `application/json` payload of an openapi-fetch response/request-body slot. */
type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
/** The success body of operation `Op` — 200 or 201, whichever the route actually sends. */
type Ok<Op> = Op extends { responses: { 200: infer R } }
  ? Json<R>
  : Op extends { responses: { 201: infer R } }
    ? Json<R>
    : never;
/** The request body of operation `Op`. */
type ReqBody<Op> = Op extends { requestBody?: infer RB } ? Json<RB> : never;

// ── wire shapes ────────────────────────────────────────────────────────────────────────────────────────

export type DeviceView = Ok<operations["postApiV1EvvDevicesByIdApprove"]>;
export type GeofencePolicyView = Ok<operations["getApiV1EvvGeofencepolicy"]>;
export type MissingResolutionView = Ok<
  operations["postApiV1EvvMissingresolutionsByIdClinicianattest"]
>;
export type AggregatorSubmissionView = Ok<
  operations["postApiV1EvvAggregatorsubmissionsByIdCancel"]
>;

export type RejectDeviceBody = ReqBody<operations["postApiV1EvvDevicesByIdReject"]>;
export type EditTenantPolicyBody = ReqBody<operations["patchApiV1EvvGeofencepolicyTenant"]>;
export type PerAddressOverrideBody = ReqBody<operations["postApiV1EvvGeofencepolicyPeraddress"]>;
export type ClinicianAttestBody = ReqBody<
  operations["postApiV1EvvMissingresolutionsByIdClinicianattest"]
>;
export type SupervisorOverrideBody = ReqBody<
  operations["postApiV1EvvMissingresolutionsByIdSupervisoroverride"]
>;
export type CancelSubmissionBody = ReqBody<
  operations["postApiV1EvvAggregatorsubmissionsByIdCancel"]
>;

/**
 * The reason floors, mirrored from the domain so a form can say "40 more characters" instead of letting
 * the server answer 422 on submit. The server still decides — `EVV_RESOLUTION_REASON_TOO_SHORT` and the
 * TypeBox `minLength` are both behind this — but a length a form can count is worth counting in the form.
 *
 * These four numbers are the ONE thing in this file that duplicates a server constant. They are stated
 * here rather than derived because the generated `operations` map carries `minLength` in the JSON Schema
 * and not in the TypeScript type, so there is nothing to alias.
 */
export const REASON_MIN = {
  /** §7.3 `CLINICIAN_ATTEST_REASON_MIN`. */
  clinicianAttest: 40,
  /** §7.4 `SUPERVISOR_OVERRIDE_REASON_MIN`. */
  supervisorOverride: 60,
  /** The per-address override's `override_reason` floor (§2.2.2 D3). */
  geofenceOverride: 30,
  /** Device reject/suspend and submission cancel: a non-empty reason. */
  free: 1,
} as const;

/** §7.3 — how long the assigned clinician may still self-attest. Stated in the form, enforced server-side. */
export const SELF_ATTEST_WINDOW_HOURS = 24;
/** §7.4 — how long a supervisor may still override. */
export const SUPERVISOR_OVERRIDE_WINDOW_DAYS = 7;

/** The platform geofence floor a tenant may tighten below and never loosen past (§2.2.2). */
export const PLATFORM_GEOFENCE_FLOOR = { radiusM: 200, maxAccuracyM: 50 } as const;

// ── which action to OFFER on a row (an affordance, never a gate) ───────────────────────────────────────
//
// The authoritative machines are `AGGREGATOR_SUBMISSION_GRAPH` and the device lifecycle, both in
// `apps/backend/src/modules/18-evv/domain` — which `apps/web` cannot import. These sets narrow the
// buttons a row shows so an operator is not offered a cancel that is certain to 409. A status this build
// has never heard of is treated as actionable rather than inert: an unrecognised value is the one case
// where guessing "no" would hide a real action behind a stale frontend.

/** D8 — a device awaiting a decision. `approve` and `reject` are offered here and nowhere else. */
const DEVICE_PENDING: readonly string[] = ["pending_approval"];
/** D8 — a live device that can still be suspended. */
const DEVICE_SUSPENDABLE: readonly string[] = ["approved"];
/** D8 — terminal; nothing is offered. */
const DEVICE_TERMINAL: readonly string[] = ["rejected", "retired"];
/** D7 — resubmit is legal only after the state said no, or never answered. */
const SUBMISSION_RESUBMITTABLE: readonly string[] = ["rejected", "timeout"];
/** D7 — cancel is legal from any non-terminal status. */
const SUBMISSION_TERMINAL: readonly string[] = ["accepted", "cancelled"];

export const deviceActions = (
  status: string,
): { approve: boolean; reject: boolean; suspend: boolean; retire: boolean } => ({
  approve: DEVICE_PENDING.includes(status),
  reject: DEVICE_PENDING.includes(status),
  suspend: DEVICE_SUSPENDABLE.includes(status),
  retire: !DEVICE_TERMINAL.includes(status),
});

export const submissionActions = (status: string): { resubmit: boolean; cancel: boolean } => ({
  resubmit: SUBMISSION_RESUBMITTABLE.includes(status),
  cancel: !SUBMISSION_TERMINAL.includes(status),
});

/** A resolution row is workable only while it is still `open`; every other status is a closed row. */
export const isResolutionOpen = (status: string): boolean => status === "open";

// ── write plumbing ─────────────────────────────────────────────────────────────────────────────────────

/** The outcome of one write — discriminated, because every caller renders the failure in place. */
export type WriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: number | null;
      readonly code: string | null;
      readonly message: string;
    };

/**
 * Turn an openapi-fetch error into copy someone working one of these queues can act on.
 *
 * The D6 refusals are named individually because each has a DIFFERENT next step, and a generic error
 * message makes all three look like "try again": a closed self-attest window means escalate to a
 * supervisor, "not the assigned clinician" means this row belongs to someone else, and a closed override
 * window means the visit is now a documentation problem rather than an EVV one. The server's own message
 * follows the platform copy in each case rather than replacing it — it names the specific hours or days.
 */
function failure(status: number | undefined, body: unknown): WriteResult<never> {
  const httpStatus = typeof status === "number" ? status : null;
  const err =
    body && typeof body === "object" && "error" in body
      ? (body as { error?: { code?: unknown; message?: unknown } }).error
      : undefined;
  const detail = typeof err?.message === "string" ? err.message : null;
  const code = typeof err?.code === "string" ? err.code : null;
  const suffix = detail ? ` ${detail}` : "";
  const message =
    code === "EVV_RESOLUTION_NOT_ASSIGNED_CLINICIAN"
      ? `Only the clinician assigned to this visit can self-attest to it — a supervisor override is the other route.${suffix}`
      : code === "EVV_RESOLUTION_WINDOW_CLOSED" ||
          code === "EVV_RESOLUTION_SELF_ATTEST_WINDOW_CLOSED"
        ? `The self-attest window has closed on this row; a supervisor override is required.${suffix}`
        : code === "EVV_RESOLUTION_REASON_TOO_SHORT"
          ? (detail ?? "The reason supplied is shorter than this attestation requires.")
          : code === "EVV_AGGREGATOR_NOT_RESUBMITTABLE"
            ? `A submission can only be resubmitted after the state rejected it or timed out.${suffix}`
            : code === "EVV_AGGREGATOR_NOT_CANCELLABLE"
              ? `This submission has already reached a terminal status; there is nothing left to cancel.${suffix}`
              : httpStatus === 403
                ? (detail ?? "Your role is not permitted to take this action.")
                : httpStatus === 409
                  ? (detail ??
                    "That row has moved on since this page loaded. Reload and try again.")
                  : httpStatus === 404
                    ? "That record is no longer available to you."
                    : httpStatus === 422
                      ? (detail ?? "The server rejected the details supplied.")
                      : (detail ?? "The action could not be completed.");
  return { ok: false, status: httpStatus, code, message };
}

const ok = <T>(value: T): WriteResult<T> => ({ ok: true, value });

// ── device lifecycle (§4.1 routes 10–13) ───────────────────────────────────────────────────────────────

export async function approveDevice(
  client: ApiClient,
  id: string,
): Promise<WriteResult<DeviceView>> {
  const { data, error, response } = await client.POST("/api/v1/evv/devices/{id}/approve", {
    params: { path: { id } },
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

export async function rejectDevice(
  client: ApiClient,
  id: string,
  reason: string,
): Promise<WriteResult<DeviceView>> {
  const { data, error, response } = await client.POST("/api/v1/evv/devices/{id}/reject", {
    params: { path: { id } },
    body: { reason },
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

export async function suspendDevice(
  client: ApiClient,
  id: string,
  reason: string,
): Promise<WriteResult<DeviceView>> {
  const { data, error, response } = await client.POST("/api/v1/evv/devices/{id}/suspend", {
    params: { path: { id } },
    body: { reason },
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

export async function retireDevice(
  client: ApiClient,
  id: string,
  reason: string,
): Promise<WriteResult<DeviceView>> {
  const { data, error, response } = await client.POST("/api/v1/evv/devices/{id}/retire", {
    params: { path: { id } },
    // Optional on the wire, unlike reject/suspend. Sent when given and omitted when not, rather than
    // sent as `""` — an empty string is a reason someone typed nothing into, not the absence of one.
    body: reason.trim() ? { reason } : {},
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

// ── geofence policy (§4.1 routes 15–16) ────────────────────────────────────────────────────────────────

export async function editTenantPolicy(
  client: ApiClient,
  body: EditTenantPolicyBody,
): Promise<WriteResult<GeofencePolicyView>> {
  const { data, error, response } = await client.PATCH("/api/v1/evv/geofence-policy/tenant", {
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

export async function createPerAddressOverride(
  client: ApiClient,
  body: PerAddressOverrideBody,
): Promise<WriteResult<GeofencePolicyView>> {
  const { data, error, response } = await client.POST("/api/v1/evv/geofence-policy/per-address", {
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

// ── missing-EVV resolution (§4.1 routes 18–19; §2.2.4 D6) ──────────────────────────────────────────────

export async function clinicianAttestResolution(
  client: ApiClient,
  id: string,
  reason: string,
): Promise<WriteResult<MissingResolutionView>> {
  const { data, error, response } = await client.POST(
    "/api/v1/evv/missing-resolutions/{id}/clinician-attest",
    { params: { path: { id } }, body: { reason } },
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

export async function supervisorOverrideResolution(
  client: ApiClient,
  id: string,
  reason: string,
): Promise<WriteResult<MissingResolutionView>> {
  const { data, error, response } = await client.POST(
    "/api/v1/evv/missing-resolutions/{id}/supervisor-override",
    // No `stepUpAuthRefId`. It was a required uuid no caller could obtain and the route discarded it
    // (#165); the step-up is resolved from the session server-side, which is the only reading that was
    // ever real. A 403 here means the session has not re-authenticated recently enough.
    { params: { path: { id } }, body: { reason } },
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

// ── aggregator submissions (§4.1 routes 21–22; §2.2.5 D7) ──────────────────────────────────────────────

export async function resubmitSubmission(
  client: ApiClient,
  id: string,
  reason: string,
): Promise<WriteResult<AggregatorSubmissionView>> {
  const { data, error, response } = await client.POST(
    "/api/v1/evv/aggregator-submissions/{id}/resubmit",
    { params: { path: { id } }, body: reason.trim() ? { reason } : {} },
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

export async function cancelSubmission(
  client: ApiClient,
  id: string,
  reason: string,
): Promise<WriteResult<AggregatorSubmissionView>> {
  const { data, error, response } = await client.POST(
    "/api/v1/evv/aggregator-submissions/{id}/cancel",
    { params: { path: { id } }, body: { reason } },
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

// ── the reads a geofence override needs ────────────────────────────────────────────────────────────────

/** One of the patient's addresses — what a per-address override is keyed to. */
export interface PatientAddressOption {
  readonly id: string;
  readonly label: string;
}
/** One patient match from the search box. */
export interface PatientOption {
  readonly id: string;
  readonly label: string;
}

/**
 * Search the org's patients. A per-address override needs a `patientAddressId`, and this screen is
 * org-scoped rather than patient-scoped, so the address is reached the same two-step way M17's day view
 * reaches one: find the patient, then pick among their addresses.
 */
export async function searchPatients(client: ApiClient, q: string): Promise<PatientOption[]> {
  const { data } = await client.GET("/api/v1/patients", {
    params: { query: q.trim() ? { q: q.trim(), limit: 10 } : { limit: 10 } },
  });
  return (data?.items ?? []).map((p) => ({
    id: p.id,
    label: `${p.lastName}, ${p.firstName} · ${p.mrn}`,
  }));
}

/** The chosen patient's addresses. */
export async function loadPatientAddresses(
  client: ApiClient,
  patientId: string,
): Promise<PatientAddressOption[]> {
  const { data } = await client.GET("/api/v1/patients/{id}/addresses", {
    params: { path: { id: patientId } },
  });
  const rows = (data?.addresses ?? []) as {
    id: string;
    line1?: string | null;
    city?: string | null;
    kind?: string | null;
  }[];
  return rows.map((a) => ({
    id: a.id,
    label: [a.line1, a.city].filter(Boolean).join(", ") || (a.kind ?? a.id.slice(0, 8)),
  }));
}
