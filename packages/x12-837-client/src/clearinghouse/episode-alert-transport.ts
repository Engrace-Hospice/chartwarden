// @chartwarden/x12-837-client — the Episode Alert ClearinghouseTransport (#758, ADR-0053). Eligibility only.
//
// Episode Alert (https://episodealert.com, a CMS Network Service Vendor) publishes a REST API of POST calls whose
// X12 answers are translated to XML, but its endpoint paths, authentication scheme and field names are given only
// after signup. So this adapter is built to the port and everything vendor-specific is UNVERIFIED and isolated:
//   - the base URL is REQUIRED configuration (EPISODE_ALERT_BASE_URL), never a guessed default;
//   - the request body and the `/eligibility` path below, and the auth header, are placeholders to confirm on a trial;
//   - the response element names live in ./episode-alert-eligibility.
// Only eligibility is implemented: the vendor lists daily claim status and remits retrieval, but nothing public shows
// their shape (UNVERIFIED: the claim identifier the vendor keys status on, the status-code vocabulary, the 835 format,
// pagination), so those methods answer CH_NOT_WIRED until a trial account supplies it; the capture list is
// docs/audits/clearinghouse-integration/EPISODE_ALERT_TRIAL_CAPTURE_RUNBOOK_20261025.md. Submission and acknowledgments
// are not offered through this adapter at all.
//
// NOT bindable as CLEARINGHOUSE_VENDOR (review of 0882c4eb8, H1): that setting is platform-wide and routes the M23
// submit workers and acknowledgment crons through the one vendor, so binding an eligibility-only adapter there would
// stop claim submission. It is bound through the separate ELIGIBILITY_VENDOR setting (./eligibility-vendor-registry) instead.
//
// Safety: the MBI exists only inside the request body of one call and never appears in a result, reason or log; the
// response body is never echoed. Episode Alert documents no test mode, so `usage: "test"` is refused unless the
// adapter is explicitly built with `allowTestUsage` (conformance tests only), because the port requires `test` to
// reach only vendor test mode.
import { type X12WorkerResult, degraded } from "../types";
import { eligibilityOutcomeFromXml, toIsoDate } from "./episode-alert-eligibility";
import {
  type AckEvent,
  CH,
  type ClaimStatus,
  type ClearinghouseContext,
  type ClearinghouseEligibilityRequest,
  type ClearinghouseEligibilityResult,
  type ClearinghouseEvent,
  type ClearinghouseSubmission,
  type ClearinghouseTransport,
  type Page,
  type RawWebhook,
  type RemittanceFile,
  type SubmissionReceipt,
  type ValidationReport,
  isCommercialEligibilityRequest,
} from "./types";

export const EPISODE_ALERT_API_KEY_ENV = "EPISODE_ALERT_API_KEY";
export const EPISODE_ALERT_BASE_URL_ENV = "EPISODE_ALERT_BASE_URL";
const ELIGIBILITY_PATH = "/eligibility"; // UNVERIFIED
const REQUEST_TIMEOUT_MS = 30_000;
const MBI_SHAPE = /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{3}-?[A-Za-z0-9]{4}$/;
const MAX_BODY_BYTES = 1_000_000;
/** Statuses that mean "you may not use this" (credential or plan), not "try again". */
const NOT_PROVISIONED_STATUSES: ReadonlySet<number> = new Set([401, 402, 403]);
const REFUSED_STATUSES: ReadonlySet<number> = new Set([400, 404, 422]);

type EnvMap = Readonly<Record<string, string | undefined>>;

export interface EpisodeAlertTransportOptions {
  /** The platform credential. Never logged, never returned. */
  readonly apiKey: string;
  /** The vendor's API root, from signup (no trailing slash needed). */
  readonly baseUrl: string;
  /** Injected so tests own the network. Defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  /** Lets `usage: "test"` through; the vendor has no test mode, so only conformance tests set this. */
  readonly allowTestUsage?: boolean;
}

/** Builds the transport from the platform environment, reading only EPISODE_ALERT_API_KEY and _BASE_URL. */
export function createEpisodeAlertTransportFromEnv(env: EnvMap): EpisodeAlertTransport {
  const apiKey = env[EPISODE_ALERT_API_KEY_ENV]?.trim();
  if (!apiKey) {
    throw new Error(`${EPISODE_ALERT_API_KEY_ENV} is required for Episode Alert`);
  }
  const baseUrl = env[EPISODE_ALERT_BASE_URL_ENV]?.trim();
  if (!baseUrl) {
    throw new Error(
      `${EPISODE_ALERT_BASE_URL_ENV} is required for Episode Alert (from the vendor's signup docs)`,
    );
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`${EPISODE_ALERT_BASE_URL_ENV} must be an https:// URL`);
  }
  if (url.protocol !== "https:" || url.search || url.hash) {
    throw new Error(
      `${EPISODE_ALERT_BASE_URL_ENV} must be an https:// URL with no query or fragment`,
    );
  }
  return new EpisodeAlertTransport({ apiKey, baseUrl });
}

const notImplemented = <T>(what: string): Promise<X12WorkerResult<T>> =>
  Promise.resolve(
    degraded<T>(CH.NOT_WIRED, `episode_alert ${what} is not implemented in this build`),
  );

export class EpisodeAlertTransport implements ClearinghouseTransport {
  readonly vendor = "episode_alert" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly allowTestUsage: boolean;

  constructor(options: EpisodeAlertTransportOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.allowTestUsage = options.allowTestUsage ?? false;
  }

  async checkEligibility(
    ctx: ClearinghouseContext,
    req: ClearinghouseEligibilityRequest,
  ): Promise<X12WorkerResult<ClearinghouseEligibilityResult>> {
    if (ctx.usage === "test" && !this.allowTestUsage) {
      return degraded(
        CH.INVALID_REQUEST,
        "episode_alert has no test mode, so a test-usage call is refused",
      );
    }
    if (isCommercialEligibilityRequest(req)) {
      // Episode Alert answers Medicare (MBI) eligibility only; a commercial member id is never sent to it.
      return degraded(CH.INVALID_REQUEST, "episode_alert answers Medicare eligibility only");
    }
    if (!MBI_SHAPE.test(req.mbi) || toIsoDate(req.serviceDate) !== req.serviceDate) {
      return degraded(CH.INVALID_REQUEST, "the eligibility request is malformed");
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${ELIGIBILITY_PATH}`, {
        method: "POST",
        // The Authorization scheme is UNVERIFIED: a placeholder until the trial docs name it.
        headers: { Authorization: this.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ mbi: req.mbi, serviceDate: req.serviceDate }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        // A 30x must never turn the POST into a GET or carry the MBI and key to another origin.
        redirect: "error",
      });
    } catch {
      return degraded(CH.UNAVAILABLE, "Episode Alert could not be reached");
    }
    if (!res.ok) await res.body?.cancel().catch(() => undefined);
    if (NOT_PROVISIONED_STATUSES.has(res.status)) {
      return degraded(
        CH.NOT_PROVISIONED,
        "the Episode Alert account is not provisioned for eligibility",
      );
    }
    if (REFUSED_STATUSES.has(res.status)) {
      return degraded(CH.INVALID_REQUEST, "Episode Alert refused the eligibility request");
    }
    if (!res.ok) return degraded(CH.UNAVAILABLE, "Episode Alert is unavailable");
    let body: string;
    try {
      if (Number(res.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: true, data: { outcome: "unknown", asOfDate: req.serviceDate } };
      }
      body = await res.text();
    } catch {
      return degraded(CH.UNAVAILABLE, "the Episode Alert response could not be read");
    }
    return {
      ok: true,
      data: {
        outcome: eligibilityOutcomeFromXml(body, req.serviceDate),
        asOfDate: req.serviceDate,
      },
    };
  }

  validateOnly(
    _ctx: ClearinghouseContext,
    _submission: ClearinghouseSubmission,
  ): Promise<X12WorkerResult<ValidationReport>> {
    return notImplemented("validateOnly");
  }

  submitNotice(
    _ctx: ClearinghouseContext,
    _submission: ClearinghouseSubmission,
  ): Promise<X12WorkerResult<SubmissionReceipt>> {
    return notImplemented("submitNotice");
  }

  submitClaim(
    _ctx: ClearinghouseContext,
    _submission: ClearinghouseSubmission,
  ): Promise<X12WorkerResult<SubmissionReceipt>> {
    return notImplemented("submitClaim");
  }

  fetchAcknowledgments(
    _ctx: ClearinghouseContext,
    _cursor: string | null,
  ): Promise<X12WorkerResult<Page<AckEvent>>> {
    return notImplemented("acknowledgments");
  }

  fetchRemittances(
    _ctx: ClearinghouseContext,
    _cursor: string | null,
  ): Promise<X12WorkerResult<Page<RemittanceFile>>> {
    return notImplemented("remittances (response shape unavailable until a trial account)");
  }

  fetchClaimStatus(
    _ctx: ClearinghouseContext,
    _controlNumber: string,
  ): Promise<X12WorkerResult<ClaimStatus>> {
    return notImplemented("claim status (response shape unavailable until a trial account)");
  }

  verifyAndParseEvent(_webhook: RawWebhook): Promise<X12WorkerResult<ClearinghouseEvent>> {
    return notImplemented("event verification");
  }
}
