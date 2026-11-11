// Claim.MD real-time eligibility (`/services/eligdata/`) for ClaimMdTransport.checkEligibility.
//
// Claim.MD searches coverage by the insured's name, so the request must carry the transient search facts
// (EligibilitySearchFacts: name, optional DOB, the billing provider's EIN). Without them nothing is sent. Every identity
// value goes into the one POST body and nowhere else: never a reason, a log, a URL or the returned result. The answer is
// reduced to outcome + as-of date, the same shape every other transport returns.
import { type EligibilityOutcome, type X12WorkerResult, degraded } from "../types";
import { listOf, postForm, str, vendorError } from "./claimmd-wire";
import {
  CH,
  type ClearinghouseContext,
  type ClearinghouseEligibilityRequest,
  type ClearinghouseEligibilityResult,
  isCommercialEligibilityRequest,
} from "./types";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const EIN = /^\d{9}$/;
const MEMBER_ID = /^[A-Za-z0-9-]{1,80}$/;
const NAME_MAX = 60;
/** Health Benefit Plan Coverage: the coverage question, not a service-type detail. */
const PLAN_COVERAGE = "30";
/** Patient relationship 18 = self: the patient is the insured (hospice coverage is the patient's own). */
const SELF = "18";
/** EB01 values. 1-4 are active coverage, 6-8 inactive; 5 (pending investigation) and the rest stay unknown. */
const ACTIVE = new Set(["1", "2", "3", "4"]);
const INACTIVE = new Set(["6", "7", "8"]);

const refuse = (reason: string): X12WorkerResult<ClearinghouseEligibilityResult> =>
  degraded(CH.INVALID_REQUEST, reason);

const x12Day = (iso: string): string => iso.replaceAll("-", "");

/** The name, cleaned to what a payer search matches on; null when nothing is left. */
function searchName(value: string | undefined): string | null {
  const cleaned = (value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^A-Za-z0-9 '-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX)
    .trim();
  return cleaned === "" ? null : cleaned;
}

export type EligibilityFields = Readonly<Record<string, string>>;

/** The form fields, or the (value-free) reason they cannot be built. */
export function claimMdEligibilityFields(
  ctx: ClearinghouseContext,
  req: ClearinghouseEligibilityRequest,
): { readonly fields: EligibilityFields } | { readonly problem: string } {
  const memberId = (isCommercialEligibilityRequest(req) ? req.memberId : req.mbi).trim();
  const last = searchName(req.subscriber?.lastName);
  const first = searchName(req.subscriber?.firstName);
  const dob = req.subscriber?.dateOfBirth;
  const taxId = req.billingProviderTaxId?.replace(/\D/g, "");
  if (!ctx.billingNpi) return { problem: "eligibility needs the billing provider NPI" };
  if (!ISO_DAY.test(req.serviceDate)) return { problem: "the service date is not YYYY-MM-DD" };
  if (!MEMBER_ID.test(memberId)) return { problem: "the member id is malformed" };
  if (!last || !first)
    return { problem: "Claim.MD eligibility needs the subscriber's first and last name" };
  if (dob !== undefined && !ISO_DAY.test(dob))
    return { problem: "the subscriber's date of birth is not YYYY-MM-DD" };
  if (!taxId || !EIN.test(taxId))
    return { problem: "Claim.MD eligibility needs the billing provider's tax id" };
  return {
    fields: {
      ins_name_l: last,
      ins_name_f: first,
      ins_number: memberId,
      ...(dob ? { ins_dob: x12Day(dob) } : {}),
      pat_rel: SELF,
      payerid: ctx.payerId,
      service_code: PLAN_COVERAGE,
      fdos: x12Day(req.serviceDate),
      prov_npi: ctx.billingNpi,
      prov_taxid: taxId,
      prov_taxid_type: "E",
    },
  };
}

/** Active when any benefit says active, else inactive when any says inactive, else unknown. Never a guess. */
export function claimMdEligibilityOutcome(
  body: Readonly<Record<string, unknown>>,
): EligibilityOutcome {
  const coverage = listOf(body, "elig")
    .flatMap((e) => listOf(e, "benefit"))
    .map((b) => str(b.benefit_coverage_code) ?? "");
  if (coverage.some((c) => ACTIVE.has(c))) return "active";
  if (coverage.some((c) => INACTIVE.has(c))) return "inactive";
  return "unknown";
}

export async function claimMdCheckEligibility(
  fetchImpl: typeof fetch,
  key: string,
  credentialRejected: string,
  ctx: ClearinghouseContext,
  req: ClearinghouseEligibilityRequest,
): Promise<X12WorkerResult<ClearinghouseEligibilityResult>> {
  const built = claimMdEligibilityFields(ctx, req);
  if ("problem" in built) return refuse(built.problem);
  const w = await postForm(fetchImpl, "eligdata", key, built.fields);
  if (!w.ok) {
    if (w.status === 401) return degraded(CH.NOT_WIRED, credentialRejected);
    // A read with no side effect: every failure is retryable except a plain 4xx refusal of the request itself.
    const refused =
      w.status !== null &&
      w.status >= 400 &&
      w.status < 500 &&
      w.status !== 403 &&
      w.status !== 429;
    return refused
      ? refuse(`Claim.MD refused the eligibility request, HTTP ${w.status}`)
      : degraded(CH.UNAVAILABLE, "Claim.MD eligibility is unavailable");
  }
  const error = vendorError(w.body);
  if (error?.credential) return degraded(CH.NOT_WIRED, credentialRejected);
  if (error) {
    // Codes only: Claim.MD's message text can echo the subscriber.
    const suffix = error.codes.length > 0 ? ` (${error.codes.join(", ")})` : "";
    return refuse(`Claim.MD could not answer the eligibility request${suffix}`);
  }
  return {
    ok: true,
    data: { outcome: claimMdEligibilityOutcome(w.body), asOfDate: req.serviceDate },
  };
}
