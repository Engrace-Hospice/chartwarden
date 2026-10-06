// apps/web/src/modules/37-ipu — the M37 WRITE access layer the §5 IPU screens share
// (Track B / ADR-0030; #91).
//
// Until this file, `apps/web/src/modules/37-ipu` issued ZERO mutations: four read screens — units,
// admissions, census, equipment — against a module with 48 write routes. An inpatient unit is the one
// place in a hospice where care is delivered around the clock by staff who change every shift, and none
// of the things that happen there could be recorded:
//
//   • the ADMISSION never moved. `request-bed → assign-bed → confirm → discharge` (and the transfer
//     pair) are the lifecycle, and the worklist rendered a state column with nothing that could change
//     it. An IPU admission opened by the API sat in `pending` forever.
//   • the RESTRAINT was never reassessed or released. A behavioral restraint carries a 15-minute
//     reassessment floor (§2.10, CoP 418.110) and a medical one 120 minutes; the watchdog raises
//     `m37.restraint.reassessment_due` on a schedule that nothing could answer.
//   • the GIP CRITERIA were never attested. `confirm` refuses an admission with no attested criterion,
//     so without this ceremony a GIP admission could not legally reach `active` at all — and CoP 418.108
//     requires the criterion to be reassessed as the stay continues.
//   • the IRC CAP OVERRIDE could not be invoked. Respite is capped at 5 consecutive days; the override
//     buys at most 2 more and is the difference between a covered day and an unbilled one.
//   • the VISITOR was never checked in or out, and a visitor RESTRICTION — `full_block`,
//     `mask_required` — could not be applied or lifted at the bedside.
//
// #168/#169 and #170/#172 are why this file can exist honestly. Three of these writes were keyed by ids
// that NO read route returned (restraint reassess/release, visitor check-out), one gated CoP 418.110 on
// whether the caller had typed anything into a field, and one asked the browser to assert that M6 had
// recorded a discharge. Building this surface first would have meant a bedside pane that could not find
// the restraint it was standing next to, and a Discharge dialog with a checkbox no clinician can answer.
//
// Every wire shape below is a TYPE ALIAS into the generated `operations` map, never a hand-copied
// interface — the same rule the other modules' api layers follow.
//
// WHAT THE SERVER OWNS, WHICH NOTHING HERE RE-DECIDES (ADR-0030 — no frontend authz).
//
//   • §2.2 — the admission state graph. Which transition is legal from which state is
//     `transitionAdmission`'s, and the D3 RN-coverage precondition on open/request-bed/transfer/restraint
//     is resolved inside the write transaction against `ipu_rn_coverage_window`. The action sets below
//     narrow which BUTTON a row shows; they are affordances, and a state this build does not recognise
//     keeps its actions rather than losing them.
//   • §2.10 — the restraint gate. The physician order is RESOLVED through M11 (#169): it must exist, be
//     for this admission's patient, be signed, and name an ordering physician. The order picker here
//     offers only signed orders for the right patient, so the common refusals are unreachable — but it
//     is a convenience, not the check, and the server answers each of the four separately.
//   • §2.4 — the GIP criteria payload is validated against the CoP 418.108 discriminated union
//     server-side. This form builds one arm of it; `GIP_CRITERIA_INVALID_PAYLOAD` is the answer if it
//     builds it wrong.
//   • §2.2 discharge — that M6 has recorded the discharge is resolved from M6's `AdmissionStatusReader`
//     (#172). Nothing here asserts it, and the refusal says what to do.
//   • Step-up (§D14) on restraint apply, GIP attest and the IRC cap override is resolved from the M2
//     session. Nothing here asserts it; a 403 is the answer and it says what to do about it.
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

export type AdmissionView = Ok<operations["getApiV1IpuadmissionsById"]>;
export type RestraintListView = Ok<operations["getApiV1IpuadmissionsByIdRestraints"]>;
export type RestraintRow = RestraintListView["items"][number];
export type GipCriteriaListView = Ok<operations["getApiV1IpuadmissionsByIdGipcriteria"]>;
export type GipCriteriaRow = GipCriteriaListView["items"][number];
export type IrcEpisodeListView = Ok<operations["getApiV1IpuadmissionsByIdIrcepisodes"]>;
export type IrcEpisodeRow = IrcEpisodeListView["items"][number];
export type VisitorListView = Ok<operations["getApiV1Ipuvisitors"]>;
export type VisitorRow = VisitorListView["items"][number];
export type RestrictionListView = Ok<operations["getApiV1Ipuvisitorrestrictions"]>;
export type RestrictionRow = RestrictionListView["items"][number];

export type ApplyRestraintBody = ReqBody<operations["postApiV1IpuadmissionsByIdRestraint"]>;
export type ReassessRestraintBody = ReqBody<operations["postApiV1IpurestraintByIdReassess"]>;
export type AttestGipBody = ReqBody<operations["postApiV1IpuadmissionsByIdGipcriteria"]>;
export type ReassessGipBody = ReqBody<operations["postApiV1IpuadmissionsByIdGipcriteriaReassess"]>;
export type IrcOverrideBody = ReqBody<operations["postApiV1IpuadmissionsByIdIrccapoverride"]>;
export type CheckInVisitorBody = ReqBody<operations["postApiV1Ipuvisitors"]>;
export type ApplyRestrictionBody = ReqBody<operations["postApiV1Ipuvisitorrestrictions"]>;
export type InitiateTransferBody = ReqBody<
  operations["postApiV1IpuadmissionsByIdInitiatetransfer"]
>;
export type DischargeBody = ReqBody<operations["postApiV1IpuadmissionsByIdDischarge"]>;

/** The `category` a restraint is applied under — it selects the reassessment floor. */
export type RestraintCategory = ApplyRestraintBody["category"];
/** The reason an IPU stay is closed out. */
export type DischargeReason = DischargeBody["reason"];

// ── domain constants mirrored for the FORMS, never as a gate ───────────────────────────────────────────
//
// These duplicate server constants. They are stated here rather than derived because the generated
// `operations` map carries `minLength`/`maximum` in the JSON Schema and not in the TypeScript type, so
// there is nothing to alias. The server decides in every case; the form counts so a clinician writing a
// restraint justification learns it is 40 characters short while writing it rather than on submit.

/** §2.10 `RESTRAINT_JUSTIFICATION_MIN` — a restraint's justification floor (chars). */
export const RESTRAINT_JUSTIFICATION_MIN = 100;
/**
 * §2.10 `RESTRAINT_REASSESS_FLOOR_MINUTES` — the reassessment cadence CEILINGS, tighten-only. A
 * behavioral restraint is reassessed at least every 15 minutes and a medical one every 120; a configured
 * interval may go LOWER and never higher (`RESTRAINT_INTERVAL_NOT_TIGHTENING`, 422).
 */
export const RESTRAINT_REASSESS_FLOOR_MINUTES: Record<RestraintCategory, number> = {
  behavioral: 15,
  medical: 120,
};
/** §2.5 `IRC_CAP_DAYS` — consecutive respite days before the cap bites. */
export const IRC_CAP_DAYS = 5;
/** §2.5 `IRC_CAP_OVERRIDE_MAX_DAYS` — the most an override may extend the cap by. */
export const IRC_CAP_OVERRIDE_MAX_DAYS = 2;
/** §2.5 `IRC_CAP_OVERRIDE_REASON_MIN` — the override's reason floor (chars). */
export const IRC_CAP_OVERRIDE_REASON_MIN = 100;
/** §2.4 — the GIP reassessment rationale floor (chars). */
export const GIP_REASSESS_RATIONALE_MIN = 50;
/** §2.4 — the GIP attestation rationale floor, shared by all three CoP 418.108 arms. */
export const GIP_RATIONALE_MIN = 100;
/** §2.4 — the imminent-death arm's home-environment assessment floor. */
export const GIP_HOME_ASSESSMENT_MIN = 50;
/** §2.7 — a visitor restriction's rationale floor (a non-empty string on the wire). */
export const RESTRICTION_RATIONALE_MIN = 1;

// ── which action to OFFER on a row (an affordance, never a gate) ───────────────────────────────────────
//
// The authoritative graph is `ADMISSION_STATE_GRAPH` in `packages/inpatient`, which `apps/web` cannot
// import. These sets narrow the buttons a row shows so a coordinator is not offered a transition certain
// to 409. A state this build has never heard of is treated as ACTIONABLE rather than inert: an
// unrecognised value is the one case where guessing "no" hides a real action behind a stale frontend.

const REQUEST_BED_FROM: readonly string[] = ["pending"];
const ASSIGN_BED_FROM: readonly string[] = ["bed_pending"];
/** GAP-106 — a bed-assigned admission is activated by M6's LCP acknowledgement, not by a tenant session. */
const AWAITING_LCP_ACK_FROM: readonly string[] = ["bed_assigned"];
const TRANSFER_FROM: readonly string[] = ["active"];
const CONFIRM_TRANSFER_FROM: readonly string[] = ["transferring"];
const DISCHARGE_FROM: readonly string[] = ["active"];
/** Terminal — nothing is offered, and the bedside pane is a record rather than a workspace. */
const ADMISSION_TERMINAL: readonly string[] = ["discharged", "transferred", "deceased", "closed"];

export interface AdmissionActions {
  readonly requestBed: boolean;
  readonly assignBed: boolean;
  /**
   * READ-ONLY status, never an action: `POST /ipu-admissions/:id/confirm` is system-internal (always 403 for
   * a tenant session), so the worklist shows "Awaiting M6 LCP acknowledgement" instead of a Confirm button.
   */
  readonly awaitingLcpAck: boolean;
  readonly initiateTransfer: boolean;
  readonly confirmTransfer: boolean;
  readonly discharge: boolean;
}

export const admissionActions = (state: string): AdmissionActions => {
  const known =
    ADMISSION_TERMINAL.includes(state) ||
    REQUEST_BED_FROM.includes(state) ||
    ASSIGN_BED_FROM.includes(state) ||
    AWAITING_LCP_ACK_FROM.includes(state) ||
    TRANSFER_FROM.includes(state) ||
    CONFIRM_TRANSFER_FROM.includes(state);
  // An unrecognised state offers every tenant action; a recognised terminal one offers nothing. The
  // M6-ack status is a fact about a KNOWN state only, so an unknown state never claims it.
  if (!known) {
    return {
      requestBed: true,
      assignBed: true,
      awaitingLcpAck: false,
      initiateTransfer: true,
      confirmTransfer: true,
      discharge: true,
    };
  }
  return {
    requestBed: REQUEST_BED_FROM.includes(state),
    assignBed: ASSIGN_BED_FROM.includes(state),
    awaitingLcpAck: AWAITING_LCP_ACK_FROM.includes(state),
    initiateTransfer: TRANSFER_FROM.includes(state),
    confirmTransfer: CONFIRM_TRANSFER_FROM.includes(state),
    discharge: DISCHARGE_FROM.includes(state),
  };
};

/** Is this admission still a workspace (bedside writes offered) rather than a closed record? */
export const isAdmissionOpen = (state: string): boolean => !ADMISSION_TERMINAL.includes(state);

/** A restraint is reassessed and released only while it is live. */
export const isRestraintLive = (state: string): boolean => state !== "released";

/**
 * When the next reassessment is due: the last one's `nextDueAt`, or — before the first — the interval
 * measured from `appliedAt`. §2.10's `isRestraintReassessmentDue` uses exactly this pair of anchors.
 */
export function restraintDueAt(row: RestraintRow): Date | null {
  if (row.nextDueAt) {
    const d = new Date(row.nextDueAt);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const applied = new Date(row.appliedAt);
  if (Number.isNaN(applied.getTime())) return null;
  return new Date(applied.getTime() + row.reassessmentIntervalMinutes * 60_000);
}

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
 * Turn an openapi-fetch error into copy someone standing at a bedside can act on.
 *
 * The M37 refusals are named individually because each has a DIFFERENT next step, and a generic message
 * makes them all read as "try again". The four restraint-order refusals (#169) are the clearest case:
 * "no such order", "that order is another patient's", "unsigned", and "names no physician" are four
 * different problems, and the server distinguishes them precisely so this can too. The server's own
 * message follows the platform copy rather than replacing it — it names the specific id or interval.
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
  const message = ipuMessage(code, httpStatus, detail, suffix);
  return { ok: false, status: httpStatus, code, message };
}

function ipuMessage(
  code: string | null,
  httpStatus: number | null,
  detail: string | null,
  suffix: string,
): string {
  switch (code) {
    case "RESTRAINT_ORDER_REQUIRED":
      // The one refusal a nurse must not read as a form error: CoP 418.110 permits no restraint without
      // a physician's order, and the server's message says which of the four checks failed.
      return (
        detail ??
        "A restraint requires a signed physician order for this patient (CoP 418.110 — required even in an emergency)."
      );
    case "RESTRAINT_STEP_UP_REQUIRED":
      return `Applying a restraint requires re-authentication. Sign in again and retry.${suffix}`;
    case "RESTRAINT_JUSTIFICATION_TOO_SHORT":
      return (
        detail ??
        `The justification is shorter than the ${RESTRAINT_JUSTIFICATION_MIN}-character floor.`
      );
    case "RESTRAINT_INTERVAL_NOT_TIGHTENING":
      return (
        detail ??
        "The reassessment interval may be tightened below the category floor but never loosened above it."
      );
    case "IPU_RN_COVERAGE_UNAVAILABLE":
      return `This unit has no active RN coverage for the current hour (§2.3, CoP 418.110(e)). A coverage break-glass is the other route.${suffix}`;
    case "ADMISSION_DISCHARGE_EVENT_MISSING":
      // #172 — this used to be a boolean the browser sent. Now it is a real precondition, so the copy
      // has to tell someone what to go and do.
      return `Record the discharge on the M6 admission first; the IPU stay is closed out behind it, not ahead of it.${suffix}`;
    case "ADMISSION_GIP_CRITERIA_REQUIRED":
      return `A GIP admission cannot be confirmed until a physician has attested the CoP 418.108 criterion.${suffix}`;
    case "IRC_CAP_OVERRIDE_REASON_TOO_SHORT":
      return (
        detail ??
        `The override reason is shorter than the ${IRC_CAP_OVERRIDE_REASON_MIN}-character floor.`
      );
    case "IRC_CAP_OVERRIDE_ALREADY_INVOKED":
      return `This respite episode has already used its cap override; it may be invoked once.${suffix}`;
    case "GIP_CRITERIA_INVALID_PAYLOAD":
      return detail ?? "The attestation does not match the CoP 418.108 criterion it names.";
    case "VISITOR_RESTRICTED":
      return `A visitor restriction in force on this unit or patient blocks this check-in.${suffix}`;
    default:
      break;
  }
  if (httpStatus === 403) return detail ?? "Your role is not permitted to take this action.";
  if (httpStatus === 412) return detail ?? "A precondition for this action is not met right now.";
  if (httpStatus === 409)
    return detail ?? "That record has moved on since this page loaded. Reload and try again.";
  if (httpStatus === 404) return "That record is no longer available to you.";
  if (httpStatus === 422) return detail ?? "The server rejected the details supplied.";
  return detail ?? "The action could not be completed.";
}

const ok = <T>(value: T): WriteResult<T> => ({ ok: true, value });

// ── admission lifecycle (§4.1 routes 13-18) ────────────────────────────────────────────────────────────

export async function requestBed(
  client: ApiClient,
  id: string,
  unitId: string,
): Promise<WriteResult<AdmissionView>> {
  const { data, error, response } = await client.POST("/api/v1/ipu-admissions/{id}/request-bed", {
    params: { path: { id } },
    body: { unitId },
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

export async function assignBed(
  client: ApiClient,
  id: string,
  bedId: string,
): Promise<WriteResult<AdmissionView>> {
  const { data, error, response } = await client.POST("/api/v1/ipu-admissions/{id}/assign-bed", {
    params: { path: { id } },
    body: { bedId },
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

// There is deliberately NO `confirmAdmission` here: `POST /ipu-admissions/{id}/confirm` is system-internal
// (GAP-106, driven by M6's LCP acknowledgement) and always 403s a tenant session, so a client for it
// could only dead-end. The worklist shows `AdmissionActions.awaitingLcpAck` as a read-only status instead.

export async function dischargeAdmission(
  client: ApiClient,
  id: string,
  reason: DischargeReason,
): Promise<WriteResult<AdmissionView>> {
  // No `dischargeEventExists` — #172 removed it. The server resolves whether M6 recorded the discharge
  // through `AdmissionStatusReader`; this form has nothing to assert about it and does not pretend to.
  const { data, error, response } = await client.POST("/api/v1/ipu-admissions/{id}/discharge", {
    params: { path: { id } },
    body: { reason },
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

export async function initiateTransfer(
  client: ApiClient,
  id: string,
  body: InitiateTransferBody,
): Promise<WriteResult<AdmissionView>> {
  const { data, error, response } = await client.POST(
    "/api/v1/ipu-admissions/{id}/initiate-transfer",
    { params: { path: { id } }, body },
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

export async function confirmTransfer(
  client: ApiClient,
  id: string,
): Promise<WriteResult<AdmissionView>> {
  const { data, error, response } = await client.POST(
    "/api/v1/ipu-admissions/{id}/confirm-transfer",
    // The receiving side acknowledging the handover is the whole content of this transition; a
    // confirm-transfer nobody acknowledged is not one the machine will take.
    { params: { path: { id } }, body: { destinationAcknowledged: true } },
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

// ── restraint (§4.1 routes 22-24; §2.10 D11) ───────────────────────────────────────────────────────────

export async function applyRestraint(
  client: ApiClient,
  admissionId: string,
  body: ApplyRestraintBody,
): Promise<WriteResult<unknown>> {
  const { data, error, response } = await client.POST("/api/v1/ipu-admissions/{id}/restraint", {
    params: { path: { id: admissionId } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

export async function reassessRestraint(
  client: ApiClient,
  restraintId: string,
  body: ReassessRestraintBody,
): Promise<WriteResult<unknown>> {
  const { data, error, response } = await client.POST("/api/v1/ipu-restraint/{id}/reassess", {
    params: { path: { id: restraintId } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

export async function releaseRestraint(
  client: ApiClient,
  restraintId: string,
): Promise<WriteResult<unknown>> {
  const { data, error, response } = await client.POST("/api/v1/ipu-restraint/{id}/release", {
    params: { path: { id: restraintId } },
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

// ── GIP criteria (§4.1 routes 19-20; §2.4, CoP 418.108) ────────────────────────────────────────────────

export async function attestGipCriteria(
  client: ApiClient,
  admissionId: string,
  body: AttestGipBody,
): Promise<WriteResult<unknown>> {
  const { data, error, response } = await client.POST("/api/v1/ipu-admissions/{id}/gip-criteria", {
    params: { path: { id: admissionId } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

export async function reassessGipCriteria(
  client: ApiClient,
  admissionId: string,
  criterionStillMet: boolean,
  rationale: string,
): Promise<WriteResult<unknown>> {
  const { data, error, response } = await client.POST(
    "/api/v1/ipu-admissions/{id}/gip-criteria/reassess",
    { params: { path: { id: admissionId } }, body: { criterionStillMet, rationale } },
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

// ── IRC cap override (§4.1 route 21; §2.5) ─────────────────────────────────────────────────────────────

export async function overrideIrcCap(
  client: ApiClient,
  admissionId: string,
  reason: string,
  extensionDays: number,
): Promise<WriteResult<IrcEpisodeRow>> {
  const { data, error, response } = await client.POST(
    "/api/v1/ipu-admissions/{id}/irc-cap-override",
    { params: { path: { id: admissionId } }, body: { reason, extensionDays } },
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data as IrcEpisodeRow);
}

// ── visitors + restrictions (§4.1 routes 29-31; §2.7) ──────────────────────────────────────────────────

export async function checkInVisitor(
  client: ApiClient,
  body: CheckInVisitorBody,
): Promise<WriteResult<VisitorRow>> {
  const { data, error, response } = await client.POST("/api/v1/ipu-visitors", { body });
  if (error || !data) return failure(response?.status, error);
  return ok(data as VisitorRow);
}

export async function checkOutVisitor(
  client: ApiClient,
  visitorId: string,
): Promise<WriteResult<VisitorRow>> {
  const { data, error, response } = await client.POST("/api/v1/ipu-visitors/{id}/check-out", {
    params: { path: { id: visitorId } },
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data as VisitorRow);
}

export async function applyVisitorRestriction(
  client: ApiClient,
  body: ApplyRestrictionBody,
): Promise<WriteResult<unknown>> {
  const { data, error, response } = await client.POST("/api/v1/ipu-visitor-restrictions", {
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

export async function liftVisitorRestriction(
  client: ApiClient,
  restrictionId: string,
): Promise<WriteResult<unknown>> {
  const { data, error, response } = await client.DELETE("/api/v1/ipu-visitor-restrictions", {
    body: { restrictionId },
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

// ── pickers: the ids these forms need, from the reads that actually carry them ─────────────────────────

/** One signed M11 order a restraint may cite. */
export interface OrderOption {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly signedAt: string | null;
}

/**
 * The orders a restraint application may name, for ONE patient.
 *
 * #169 made the server resolve `orderingOrderId` through M11 rather than checking the string is
 * non-empty, and it refuses on four distinct grounds. Filtering to this patient's SIGNED orders makes
 * three of them unreachable from the picker — but they remain the server's to answer, and the fourth
 * ("names no ordering physician") is not visible from here at all.
 */
export async function loadSignedOrdersForPatient(
  client: ApiClient,
  patientId: string,
): Promise<OrderOption[]> {
  const { data } = await client.GET("/api/v1/orders", { params: { query: { patientId } } });
  const orders = (data as { orders?: OrderOption[] } | undefined)?.orders ?? [];
  return orders.filter((o) => o.signedAt !== null);
}

/** One physician from M40's canonical register — the GIP attestation names one. */
export interface PhysicianOption {
  readonly id: string;
  readonly displayName: string;
  readonly identifierValue: string;
}

/**
 * Search M40's canonical physician register.
 *
 * The GIP attestation stores `attestingPhysicianId`, an MDM id. The server does not currently validate
 * it (recorded in #170 as a decision rather than a diagnosis — who may be attested for is a policy
 * question), which makes it MORE important that this field is a picker over the canonical register and
 * not a free-text uuid box: the one place a wrong value can be caught cheaply is before it is sent.
 */
export async function searchPhysicians(
  client: ApiClient,
  query: string,
  limit = 25,
): Promise<PhysicianOption[]> {
  const { data } = await client.GET("/api/v1/mdm/{kind}/search", {
    params: { path: { kind: "physician" }, query: { q: query, limit } },
  });
  const results =
    (
      data as
        | {
            results?: {
              id: string;
              canonical?: { displayName?: string; identifierValue?: string };
            }[];
          }
        | undefined
    )?.results ?? [];
  return results.map((r) => ({
    id: r.id,
    displayName: r.canonical?.displayName ?? r.id,
    identifierValue: r.canonical?.identifierValue ?? "",
  }));
}

/** One bed a pending admission may be assigned to. */
export interface BedOption {
  readonly id: string;
  readonly bedLabel: string;
  readonly roomId: string;
  readonly cleaningStatus: string;
}

/**
 * Every bed in a unit, walked rooms-then-beds because that is the shape of the read routes
 * (`GET /inpatient-units/:id/rooms` → `GET /ipu-rooms/:id/beds`; there is no unit-wide bed list).
 *
 * Beds are NOT filtered to `ready` here. §2.2 refuses an assignment to a bed that is not ready and says
 * so; hiding the others would leave a coordinator staring at an empty picker with no explanation of why
 * the bed they can see through the window is missing. The status is shown beside each one instead.
 */
export async function loadBedsForUnit(client: ApiClient, unitId: string): Promise<BedOption[]> {
  const { data: roomsData } = await client.GET("/api/v1/inpatient-units/{id}/rooms", {
    params: { path: { id: unitId } },
  });
  const rooms = (roomsData as { items?: { id: string }[] } | undefined)?.items ?? [];
  const perRoom = await Promise.all(
    rooms.map(async (room) => {
      const { data } = await client.GET("/api/v1/ipu-rooms/{id}/beds", {
        params: { path: { id: room.id } },
      });
      return (data as { items?: BedOption[] } | undefined)?.items ?? [];
    }),
  );
  return perRoom.flat();
}

/** One unit a bed may be requested in. */
export interface UnitOption {
  readonly id: string;
  readonly displayName: string;
  readonly isActive: boolean;
}

/** The org's units. Inactive ones are dropped — a deactivated unit takes no new admissions (§2.1). */
export async function loadUnits(client: ApiClient): Promise<UnitOption[]> {
  const { data } = await client.GET("/api/v1/inpatient-units");
  const items = (data as { items?: UnitOption[] } | undefined)?.items ?? [];
  return items.filter((u) => u.isActive);
}
