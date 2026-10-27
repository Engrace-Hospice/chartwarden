// Stedi 276/277 claim-status inquiry: request builder and response parser ONLY. UNBOUND AND UNVERIFIED (issue #820).
//
// STEDI_TRANSPORT_CONTRACT row `fetchClaimStatus` is **U**: no 276/277 call has been observed against a Stedi sandbox. Every field name,
// the endpoint path and the category-code mapping below come from Stedi's published JSON claim-status shape as remembered, NOT from
// an observed answer (DoseSpot rule: vendor field names are unverified until tested against a sandbox). So:
//   - `StediTransport.fetchClaimStatus` still answers CH_NOT_WIRED and does NOT call this module; wiring it is a deliberate follow-up
//     that needs (1) a sandbox run confirming the names here and (2) a port change, because the inquiry needs the subscriber, payer and
//     service dates that `fetchClaimStatus(ctx, controlNumber)` cannot supply today.
//   - the parser never answers `not_found` (a payer "not found" could drive a duplicate resubmission; contract rule) and never invents
//     an AckEvent: `latest` is always null, so the caller learns a state and applies nothing.
//   - the subscriber block is TRANSIENT PHI: built into the request for one call, never returned, logged or placed in a reason.
import { type X12WorkerResult, degraded } from "../types";
import { CH, type ClaimStatus, type SubmissionState } from "./types";

/** UNVERIFIED path (see header). */
export const STEDI_CLAIM_STATUS_PATH = "/2024-04-01/change/medicalnetwork/claimstatus/v2";

export interface StediClaimStatusInquiry {
  readonly controlNumber: string;
  readonly payerId: string;
  readonly billingProvider: { readonly organizationName: string; readonly npi: string };
  /** TRANSIENT PHI. */
  readonly subscriber: {
    readonly memberId: string;
    readonly firstName: string;
    readonly lastName: string;
    /** YYYY-MM-DD */
    readonly dateOfBirth: string;
  };
  /** YYYY-MM-DD */
  readonly serviceFrom: string;
  readonly serviceTo: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const compact = (iso: string): string => iso.replaceAll("-", "");
const CONTROL_NUMBER_SHAPE = /^[A-Za-z0-9-]{1,64}$/;
const PAYER_ID_SHAPE = /^[A-Za-z0-9]{1,80}$/;

/** The request body, or a PHI-free refusal. */
export function buildClaimStatusRequest(
  q: StediClaimStatusInquiry,
): X12WorkerResult<Record<string, unknown>> {
  if (!CONTROL_NUMBER_SHAPE.test(q.controlNumber)) {
    return degraded(CH.INVALID_REQUEST, "claim status: unusable control number");
  }
  if (!PAYER_ID_SHAPE.test(q.payerId)) {
    return degraded(CH.INVALID_REQUEST, "claim status: unusable payer id");
  }
  if (![q.serviceFrom, q.serviceTo, q.subscriber.dateOfBirth].every((d) => ISO_DATE.test(d))) {
    return degraded(CH.INVALID_REQUEST, "claim status: a date is not YYYY-MM-DD");
  }
  if (!q.subscriber.memberId || !q.subscriber.firstName || !q.subscriber.lastName) {
    return degraded(CH.INVALID_REQUEST, "claim status: the subscriber is incomplete");
  }
  return {
    ok: true,
    data: {
      controlNumber: q.controlNumber,
      tradingPartnerServiceId: q.payerId,
      provider: {
        organizationName: q.billingProvider.organizationName,
        npi: q.billingProvider.npi,
        providerType: "BillingProvider",
      },
      subscriber: {
        memberId: q.subscriber.memberId,
        firstName: q.subscriber.firstName,
        lastName: q.subscriber.lastName,
        dateOfBirth: compact(q.subscriber.dateOfBirth),
      },
      encounter: {
        beginningDateOfService: compact(q.serviceFrom),
        endDateOfService: compact(q.serviceTo),
      },
    },
  };
}

/** 277 claim status category codes -> our state. Anything unlisted is "received" (we only know the payer has it), never a terminal one. */
const CATEGORY_STATE: Readonly<Record<string, SubmissionState | "unknown_claim">> = {
  A1: "received",
  A2: "received",
  A3: "payer_rejected",
  A4: "unknown_claim",
  A6: "payer_rejected",
  A7: "payer_rejected",
  A8: "payer_rejected",
  F1: "payer_accepted",
  F2: "payer_rejected",
};
const CATEGORY_SHAPE = /^[A-Z][0-9A-Z]{1,2}$/;

interface StatusAnswer {
  readonly errors?: unknown;
  readonly claims?: readonly {
    readonly claimStatus?: {
      readonly statusInformation?: readonly {
        readonly healthCareClaimStatusCategoryCode?: unknown;
      }[];
    };
  }[];
}

/** Reduce a 277 JSON answer to a ClaimStatus. `latest` is always null (see header). Codes only; the body is never echoed. */
export function parseClaimStatusResponse(
  controlNumber: string,
  body: unknown,
): X12WorkerResult<ClaimStatus> {
  if (body === null || typeof body !== "object") {
    return degraded(CH.INVALID_REQUEST, "claim status: the answer is not an object");
  }
  const root = body as StatusAnswer;
  if (Array.isArray(root.errors) && root.errors.length > 0) {
    return degraded(CH.INVALID_REQUEST, "claim status: the vendor reported errors");
  }
  const codes = (root.claims ?? [])
    .flatMap((c) => c.claimStatus?.statusInformation ?? [])
    .map((i) => i.healthCareClaimStatusCategoryCode)
    .filter((c): c is string => typeof c === "string" && CATEGORY_SHAPE.test(c));
  if (codes.length === 0) {
    return degraded(CH.UNAVAILABLE, "claim status: the answer carried no category code");
  }
  const states = codes.map((c) => CATEGORY_STATE[c] ?? "received");
  if (states.includes("unknown_claim")) {
    // never `not_found`: a payer that cannot find the claim must not read as "not received" (duplicate resubmission)
    return degraded(CH.UNAVAILABLE, "claim status: the payer could not locate the claim");
  }
  // several lines answered: a rejection anywhere wins, then the least final state
  const state: SubmissionState = states.includes("payer_rejected")
    ? "payer_rejected"
    : states.every((s) => s === "payer_accepted")
      ? "payer_accepted"
      : "received";
  return { ok: true, data: { controlNumber, state, latest: null } };
}
