// apps/web/src/modules/12-dosespot — the M12 WRITE access layer the §6.1 screens share
// (Track B / ADR-0030; #91).
//
// Until this file, `apps/web/src/modules/12-dosespot` issued ZERO mutations: nine read screens, every
// one of them a read. Four of them are QUEUES whose entire reason to exist is an action they did not
// offer — the prescriber Sign Inbox, the Verbal-Orders queue, the Refill Inbox and its detail. A
// physician could open "medication orders awaiting your signature" and have no way to sign one, and
// nothing anywhere in the staff app could WRITE a prescription. In a hospice, symptom control IS
// medication: this is the origin of the chain M13's eMAR administers against.
//
// THE LIFECYCLE IS REACHABLE NOW, WHICH IS WHY THIS IS WORTH BUILDING. Until #136, `signed` had exactly
// one exit (`enqueueTransmission`) and no transmission worker exists, so every signed order was frozen —
// never completable, never discontinuable, never `active`, and M13's D6 gate refused all of them.
// `activate` now has a second arm from `signed` when `dosespot_send_state = not_required`. An order
// written here reaches a state the eMAR can administer against.
//
// Every wire shape below is a TYPE ALIAS into the generated `operations` map, never a hand-copied
// interface — the same rule `13-emar/emar-api.ts` and `11-orders/orders-api.ts` follow.
//
// WHAT THE SERVER OWNS, WHICH NOTHING HERE RE-DECIDES (ADR-0030 — no frontend authz).
//
//   • §2.2 the lifecycle. `transitionMedicationOrder` decides whether an order is in a state that
//     permits a transition. No screen pre-computes "this is signable".
//   • §2.4 the EPCS gate. A controlled-substance order must be signed through `signControlled`, and
//     `requestSignature` refuses one outright unless the tenant is DEA EPCS-certified. See
//     `controlledPrescribingAvailable` below: this file READS that status rather than assuming it.
//   • §4.7 prescriber eligibility — `prescriberEligible(discipline, medClass)` is resolved server-side
//     from the caller's own grants. A 403 is the answer, surfaced verbatim.
//   • The §2.3 verbal-order window, and the §2.7 refill SLA.
import type { ApiClient, operations } from "@chartwarden/ui";
import { describeMedicationFindings, medicationFindings } from "./medication-validation";

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

export type MedicationOrderView = Ok<operations["getApiV1MedicationordersById"]>;
export type CreateOrderBody = ReqBody<operations["postApiV1Medicationorders"]>;
export type EditDraftBody = ReqBody<operations["patchApiV1MedicationordersById"]>;
export type RequestSignatureBody = ReqBody<
  operations["postApiV1MedicationordersByIdRequestsignature"]
>;
export type SignOrderBody = ReqBody<operations["postApiV1MedicationordersByIdSign"]>;
export type VerbalOrderBody = ReqBody<operations["postApiV1MedicationordersByIdVerbal"]>;
export type CosignOrderBody = ReqBody<operations["postApiV1MedicationordersByIdCosign"]>;
export type DiscontinueBody = ReqBody<operations["postApiV1MedicationordersByIdDiscontinue"]>;
export type CompleteBody = ReqBody<operations["postApiV1MedicationordersByIdComplete"]>;
/** COP27 — the hospice coverage determination body (reason required when not covered). */
export type CoverageDeterminationBody = ReqBody<
  operations["putApiV1MedicationordersByIdCoveragedetermination"]
>;
export type ApproveRefillBody = ReqBody<operations["postApiV1RefillsByIdApprove"]>;
export type DenyRefillBody = ReqBody<operations["postApiV1RefillsByIdDeny"]>;
export type ControlledPolicyView = Ok<operations["getApiV1AdminControlledsubstancepolicy"]>;
export type ConceptSearchResult = Ok<operations["getApiV1TerminologyBySystemSearch"]>;
export type ConceptView = Ok<operations["getApiV1TerminologyBySystemByCode"]>;
export type ValueSetExpansion = Ok<operations["getApiV1TerminologyValuesetsByIdExpand"]>;

/** The §2.1 medication classes the server accepts. Derived, so a vocabulary change breaks the build. */
export type MedClass = CreateOrderBody["medClass"];
/** The §2.3 discontinuation reasons. */
export type DiscontinueReason = DiscontinueBody["reason"];
/** The §2.5 cosigner roles. */
export type CosignerRole = CosignOrderBody["cosignerRole"];
/** The DEA schedules the server accepts on a controlled order. */
export type DeaSchedule = NonNullable<CreateOrderBody["deaSchedule"]>;

/**
 * The §2.11 structured sig — the ONLY part of the opaque `data` payload anything downstream reads.
 *
 * `medication_order.data` is `Type.Unknown()` at the route boundary and stored as opaque jsonb, so a
 * composer could put anything in it. What it must put in it is this: M12's own seam store projects
 * `data.sigStructured` through an ALLOWLIST (`sigStructuredOf` in `seams/drizzle-store.ts`) into the
 * `SigStructuredDto` M13's eMAR reads — dose, unit, route, frequency, PRN, and the D11 titration bounds
 * that decide whether an infusion rate change is authorised. Anything outside these keys is dropped by
 * that projection, so writing it would be writing to nobody.
 */
export interface SigStructured {
  doseQuantity: number;
  doseUnit: string;
  route: string;
  frequencyCode: string;
  asNeeded: boolean;
  asNeededReasonCode?: string;
  duration?: { durationValue: number; durationUnit: "days" | "weeks" | "months" };
  ivContinuousPolicy?: { minRate: number; maxRate: number; rateUnit?: string };
}

/**
 * The outcome of one write. A DISCRIMINATED result rather than a thrown error: each of these screens
 * renders the failure in place, and several of the failures are controls working rather than bugs.
 */
export type WriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: number | null;
      readonly code: string | null;
      readonly message: string;
    };

/**
 * Turn an openapi-fetch error into copy a prescriber can act on.
 *
 * The §2.2/§2.4 codes are named rather than flattened, because each is a different next step and two of
 * them are the platform refusing on purpose: `EPCS_NOT_CERTIFIED` means controlled-substance prescribing
 * is unavailable until the agency completes DEA EPCS certification (D18) — nothing the prescriber can
 * retry — and `SIGN_REQUIRES_EPCS` means the order took the wrong signing path.
 */
function failure(status: number | undefined, body: unknown): WriteResult<never> {
  const httpStatus = typeof status === "number" ? status : null;
  const err =
    body && typeof body === "object" && "error" in body
      ? (body as { error?: { code?: unknown; message?: unknown; details?: unknown } }).error
      : undefined;
  const detail = typeof err?.message === "string" ? err.message : null;
  const code = typeof err?.code === "string" ? err.code : null;
  const findings = medicationFindings(body);
  const abacDenied = httpStatus === 403 && detail !== null && /^abac predicate '/.test(detail);
  const message =
    findings.length > 0
      ? `${detail ?? "The order is not ready"}: ${describeMedicationFindings(findings)}`
      : abacDenied
        ? (ABAC_DENIED_COPY[/^abac predicate '([^']+)'/.exec(detail ?? "")?.[1] ?? ""] ??
          "Your role is not permitted to take this action on this order.")
        : code && CODE_COPY[code]
          ? CODE_COPY[code]
          : failureByStatus(code, httpStatus, detail);
  return { ok: false, status: httpStatus, code, message };
}

/** Plain-language copy for refusal codes (the server messages stay as they are). */
const CODE_COPY: Record<string, string> = {
  SIGNER_NOT_ORDERING_PHYSICIAN:
    "Only the order's prescriber or the named ordering physician can sign this order.",
  COSIGN_REQUIRED:
    "This order needs a physician cosignature before it can be signed. Ask the cosigner to cosign it first.",
};

/** The ABAC predicate behind a 403, by name; unknown predicates fall back to a generic sentence. */
const ABAC_DENIED_COPY: Record<string, string> = {
  medication_signer_eligible:
    "You cannot sign this order: none of your roles is eligible to sign medication orders. A physician, nurse practitioner or physician assistant must sign.",
};

function failureByStatus(
  code: string | null,
  httpStatus: number | null,
  detail: string | null,
): string {
  return code === "EPCS_NOT_CERTIFIED"
    ? "Controlled-substance prescribing is unavailable until the agency completes DEA EPCS certification. This order cannot be signed electronically."
    : code === "SIGN_REQUIRES_EPCS"
      ? "A controlled-substance order must be signed through the EPCS path, not this one."
      : code === "SIGNER_NOT_ELIGIBLE"
        ? "Your prescribing discipline is not eligible to sign this class of medication order."
        : httpStatus === 403
          ? (detail ?? "Your role is not permitted to take this action on this order.")
          : httpStatus === 409
            ? (detail ?? "This order changed before your action was applied. Reload the queue.")
            : httpStatus === 404
              ? "That order is no longer available to you."
              : httpStatus === 422
                ? (detail ?? "The server rejected the details supplied.")
                : (detail ?? "The action could not be completed.");
}

const ok = <T>(value: T): WriteResult<T> => ({ ok: true, value });

// ── the drug picker's reads (M38 terminology) ──────────────────────────────────────────────────────────

/**
 * Search RxNorm for a drug. The `rxnormRxcui` and `ndc` a create REQUIRES are identity codes: they must
 * come from the terminology service, never from a prescriber typing them, which is why this screen is
 * built on M38's search rather than on free-text fields.
 */
export async function searchDrugs(
  client: ApiClient,
  q: string,
  limit = 20,
): Promise<ConceptSearchResult["results"]> {
  if (q.trim().length < 2) return [];
  const { data } = await client.GET("/api/v1/terminology/{system}/search", {
    params: { path: { system: "rxnorm" }, query: { q: q.trim(), limit } },
  });
  return (data?.results ?? []) as ConceptSearchResult["results"];
}

/**
 * Resolve one RxNorm concept. `properties.ndcs` is where the create's required `ndc` comes from — the
 * packaged forms of the clinical drug, published by the terminology service rather than transcribed.
 */
export async function lookupDrug(client: ApiClient, rxcui: string): Promise<ConceptView | null> {
  const { data } = await client.GET("/api/v1/terminology/{system}/{code}", {
    params: { path: { system: "rxnorm", code: rxcui } },
  });
  return (data ?? null) as ConceptView | null;
}

/** Expand a platform value set — the route / dose-form vocabularies the med classes bind (§2.1). */
export async function expandValueSet(
  client: ApiClient,
  id: string,
): Promise<ValueSetExpansion["items"]> {
  const { data } = await client.GET("/api/v1/terminology/value-sets/{id}/expand", {
    params: { path: { id } },
  });
  return (data?.items ?? []) as ValueSetExpansion["items"];
}

/**
 * The agency's controlled-substance posture. Read rather than assumed: D18 ships Phase 1
 * `not_certified`, and `requestSignature` refuses a controlled order on exactly this fact — so the
 * prescribe surface asks the server what is true instead of hard-coding what was true when it was
 * written.
 */
export async function controlledPrescribingAvailable(client: ApiClient): Promise<boolean> {
  const { data } = await client.GET("/api/v1/admin/controlled-substance-policy");
  return (data as ControlledPolicyView | undefined)?.epcsCertificationStatus === "certified";
}

/**
 * The patient's admissions, newest first (F-065). `POST /api/v1/medication-orders` requires
 * `admissionId`, and until this route existed nothing could resolve one for a patient: the org-wide
 * census takes no patient filter and its items carry no `patientId`. The two workarounds already in the
 * tree are M07 declining to offer plan creation for exactly this reason, and M24's claim wizard asking
 * a clerk to type the uuid.
 */
export async function loadPatientAdmissions(
  client: ApiClient,
  patientId: string,
): Promise<
  { id: string; state: string; admissionAt: string | null; dischargedAt: string | null }[]
> {
  const { data } = await client.GET("/api/v1/patients/{patientId}/admissions", {
    params: { path: { patientId } },
  });
  return (data?.items ?? []) as {
    id: string;
    state: string;
    admissionAt: string | null;
    dischargedAt: string | null;
  }[];
}

// ── §2.2 authoring + lifecycle ─────────────────────────────────────────────────────────────────────────

/** §2.2 — draft a new medication order. */
export async function createOrder(
  client: ApiClient,
  body: CreateOrderBody,
): Promise<WriteResult<MedicationOrderView>> {
  const { data, error, response } = await client.POST("/api/v1/medication-orders", { body });
  if (error || !data) return failure(response?.status, error);
  return ok(data as MedicationOrderView);
}

/** COP27 (42 CFR 418.24(c)) — set/change the order's hospice coverage determination. */
export async function setCoverageDetermination(
  client: ApiClient,
  id: string,
  body: CoverageDeterminationBody,
): Promise<WriteResult<MedicationOrderView>> {
  const { data, error, response } = await client.PUT(
    "/api/v1/medication-orders/{id}/coverage-determination",
    { params: { path: { id } }, body },
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data as MedicationOrderView);
}

/** §2.2 — amend a draft before signature. Draft-only; the server refuses any later status. */
export async function editDraft(
  client: ApiClient,
  id: string,
  body: EditDraftBody,
): Promise<WriteResult<MedicationOrderView>> {
  const { data, error, response } = await client.PATCH("/api/v1/medication-orders/{id}", {
    params: { path: { id } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data as MedicationOrderView);
}

/** §2.2 — send the draft to the prescriber's Sign Inbox (draft → pending_signature). */
export async function requestSignature(
  client: ApiClient,
  id: string,
  signerDiscipline: string,
  /** GAP-036: a written reason acknowledging a drug-allergy conflict the server flagged (422 `ALLERGY_CHECK_NOT_PASSED`). */
  allergyOverrideReason?: string,
): Promise<WriteResult<MedicationOrderView>> {
  const { data, error, response } = await client.POST(
    "/api/v1/medication-orders/{id}/request-signature",
    {
      params: { path: { id } },
      body: {
        signerDiscipline,
        ...(allergyOverrideReason ? { allergyOverrideReason } : {}),
      } as RequestSignatureBody,
    },
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data as MedicationOrderView);
}

/**
 * §2.2 — sign. The route the Sign Inbox exists for. A controlled order is refused here by design
 * (`SIGN_REQUIRES_EPCS`); with `dosespot_send_state = not_required` the signature also ACTIVATES the
 * order in the same transaction (#136), which is what makes it administrable in M13.
 */
export async function signOrder(
  client: ApiClient,
  id: string,
  body: SignOrderBody,
): Promise<WriteResult<MedicationOrderView>> {
  const { data, error, response } = await client.POST("/api/v1/medication-orders/{id}/sign", {
    params: { path: { id } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data as MedicationOrderView);
}

/**
 * §2.3 — record a verbal order. CMS treats a verbal order as a valid order pending signature, and M12's
 * §1 names the 2 AM verbal-order workflow as the module's reason to exist; #136 made `verbal_pending`
 * administrable in M13's D6 gate for exactly that reason. A controlled verbal order cannot exist in
 * Phase 1 (D18), so this cannot admit an unwitnessed controlled substance.
 */
export async function recordVerbalOrder(
  client: ApiClient,
  id: string,
  body: VerbalOrderBody,
): Promise<WriteResult<MedicationOrderView>> {
  const { data, error, response } = await client.POST("/api/v1/medication-orders/{id}/verbal", {
    params: { path: { id } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data as MedicationOrderView);
}

/** §2.5 — attach the required cosignature. */
export async function cosignOrder(
  client: ApiClient,
  id: string,
  body: CosignOrderBody,
): Promise<WriteResult<MedicationOrderView>> {
  const { data, error, response } = await client.POST("/api/v1/medication-orders/{id}/cosign", {
    params: { path: { id } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data as MedicationOrderView);
}

/** §2.3 — discontinue an active order. Legal only from `active` (#136). */
export async function discontinueOrder(
  client: ApiClient,
  id: string,
  body: DiscontinueBody,
): Promise<WriteResult<MedicationOrderView>> {
  const { data, error, response } = await client.POST(
    "/api/v1/medication-orders/{id}/discontinue",
    { params: { path: { id } }, body },
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data as MedicationOrderView);
}

/** §2.2 — complete a course. Also legal only from `active`. */
export async function completeOrder(
  client: ApiClient,
  id: string,
  reason?: string,
): Promise<WriteResult<MedicationOrderView>> {
  const { data, error, response } = await client.POST("/api/v1/medication-orders/{id}/complete", {
    params: { path: { id } },
    body: (reason ? { reason } : {}) as CompleteBody,
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data as MedicationOrderView);
}

/**
 * §2.6 route 14 (GAP-125) — retransmit a `transmission_failed` order. Mints a REPLACEMENT draft
 * (`replacesMedicationOrderId` = this order) rather than resending in place; the prescriber sends it for
 * signature and signs it, and the GAP-037 DoseSpot worker transmits it. `prescribing.sign` + the signer
 * ABAC, and the service applies the sign standing rule (the authoring prescriber or the named physician).
 * No step-up — the route mounts none. A 404 also means "this order is not transmission_failed".
 */
export async function retransmitOrder(
  client: ApiClient,
  id: string,
): Promise<WriteResult<{ newOrderId: string }>> {
  const { data, error, response } = await client.POST("/api/v1/medication-orders/{id}/retransmit", {
    params: { path: { id } },
  });
  if (error || !data) {
    const res = failure(response?.status, error);
    const detail = (error as { error?: { message?: unknown } } | undefined)?.error?.message;
    return res.ok === false && res.status === 404 && typeof detail === "string"
      ? { ...res, message: detail }
      : res;
  }
  return ok({ newOrderId: data.newOrderId });
}

// ── §2.7 refills ───────────────────────────────────────────────────────────────────────────────────────

/** §2.7 — approve a refill request. `refillsAuthorized` is capped per DEA schedule by policy. */
export async function approveRefill(
  client: ApiClient,
  id: string,
  body: ApproveRefillBody,
): Promise<WriteResult<{ id: string }>> {
  const { data, error, response } = await client.POST("/api/v1/refills/{id}/approve", {
    params: { path: { id } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data as { id: string });
}

/** §2.7 — deny a refill request, with the reason the pharmacy is told. */
export async function denyRefill(
  client: ApiClient,
  id: string,
  body: DenyRefillBody,
): Promise<WriteResult<{ id: string }>> {
  const { data, error, response } = await client.POST("/api/v1/refills/{id}/deny", {
    params: { path: { id } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data as { id: string });
}

// ── §6.1 admin ─────────────────────────────────────────────────────────────────────────────────────────

/** Enrol a membership as a DoseSpot prescriber. */
export async function enrollPrescriber(
  client: ApiClient,
  membershipId: string,
  deaAuthorizedSchedules?: readonly DeaSchedule[],
): Promise<WriteResult<unknown>> {
  const { data, error, response } = await client.POST(
    "/api/v1/admin/dosespot-prescribers/{membershipId}/enroll",
    {
      params: { path: { membershipId } },
      body: deaAuthorizedSchedules ? { deaAuthorizedSchedules: [...deaAuthorizedSchedules] } : {},
    },
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

/** Revoke a prescriber's DoseSpot enrolment. The reason is required — a revocation is a DEA-relevant
 * change to who may prescribe, and an unexplained one is not auditable. */
export async function revokePrescriber(
  client: ApiClient,
  membershipId: string,
  reason: string,
): Promise<WriteResult<unknown>> {
  const { data, error, response } = await client.POST(
    "/api/v1/admin/dosespot-prescribers/{membershipId}/revoke",
    { params: { path: { membershipId } }, body: { reason } },
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

/** ISO instant for a `date-time` field the server records as client-observed time. */
export const nowIso = (): string => new Date().toISOString();
