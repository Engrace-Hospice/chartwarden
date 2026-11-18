import { readBoundedResponseText } from "../http/read-bounded-response-text";
import { parseSafeHttpsBaseUrl } from "../http/url-safety";
import { type LocalFakeHttpClient, isLocalFakeHttpClient } from "../testing/local-fake-http-client";
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
// Safety: the MBI exists only inside a request and never appears in a result, reason or log; response bodies are never
// echoed. No test mode is confirmed. Test-usage calls need LocalFakeHttpClient, which cannot perform network I/O.
import { type X12WorkerResult, degraded } from "../types";
import { parseEpisodeAlertEligibilityXml, toIsoDate } from "./episode-alert-eligibility";
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
// No vendor contract or approved API origin has been verified. These are code-owned gates, never environment flags.
const ELIGIBILITY_WIRE_VERIFIED = false;
const APPROVED_API_ORIGIN: string | null = null;
/** Statuses that mean "you may not use this" (credential or plan), not "try again". */
const NOT_PROVISIONED_STATUSES: ReadonlySet<number> = new Set([401, 402, 403]);
const REFUSED_STATUSES: ReadonlySet<number> = new Set([400, 404, 422]);

type EnvMap = Readonly<Record<string, string | undefined>>;

export interface EpisodeAlertTransportOptions {
  /** The platform credential. Never logged, never returned. */
  readonly apiKey: string;
  /** The vendor's API root, from signup (no trailing slash needed). */
  readonly baseUrl: string;
}

/** Builds the transport from the platform environment, reading only EPISODE_ALERT_API_KEY and _BASE_URL. */
export function createEpisodeAlertTransportFromEnv(env: EnvMap): EpisodeAlertTransport {
  if (!ELIGIBILITY_WIRE_VERIFIED || APPROVED_API_ORIGIN === null) {
    throw new Error(
      "Episode Alert eligibility cannot be bound: its vendor wire and approved API destination are unverified (see issue #758)",
    );
  }
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
  const url = parseSafeHttpsBaseUrl(baseUrl, EPISODE_ALERT_BASE_URL_ENV);
  if (url.origin !== APPROVED_API_ORIGIN) {
    throw new Error(`${EPISODE_ALERT_BASE_URL_ENV} is not an approved Episode Alert API origin`);
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
  private readonly localTestClient: LocalFakeHttpClient | null;

  constructor(options: EpisodeAlertTransportOptions, localTestClient?: LocalFakeHttpClient) {
    parseSafeHttpsBaseUrl(options.baseUrl, EPISODE_ALERT_BASE_URL_ENV);
    if (localTestClient !== undefined && !isLocalFakeHttpClient(localTestClient)) {
      throw new Error("Episode Alert local tests require LocalFakeHttpClient");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.localTestClient = localTestClient ?? null;
    this.fetchImpl = this.localTestClient?.fetch ?? fetch;
  }

  async checkEligibility(
    ctx: ClearinghouseContext,
    req: ClearinghouseEligibilityRequest,
  ): Promise<X12WorkerResult<ClearinghouseEligibilityResult>> {
    if (ctx.usage === "test" && this.localTestClient === null) {
      return degraded(
        CH.INVALID_REQUEST,
        "Episode Alert has no verified test mode; test usage is refused",
      );
    }
    if (isCommercialEligibilityRequest(req)) {
      // Episode Alert answers Medicare (MBI) eligibility only; a commercial member id is never sent to it.
      return degraded(CH.INVALID_REQUEST, "episode_alert answers Medicare eligibility only");
    }
    if (!MBI_SHAPE.test(req.mbi) || toIsoDate(req.serviceDate) !== req.serviceDate) {
      return degraded(CH.INVALID_REQUEST, "the eligibility request is malformed");
    }
    // Guessed wire assumptions can execute only against the response-only local fake. No environment switch approves
    // the vendor endpoint, authentication or payload mapping.
    if (
      this.localTestClient === null &&
      (!ELIGIBILITY_WIRE_VERIFIED ||
        APPROVED_API_ORIGIN === null ||
        new URL(this.baseUrl).origin !== APPROVED_API_ORIGIN)
    ) {
      return degraded(
        CH.NOT_WIRED,
        "Episode Alert eligibility is unavailable until its wire and destination are verified",
      );
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
    const body = await readBoundedResponseText(res, MAX_BODY_BYTES);
    if (!body.ok) {
      return degraded(
        CH.UNAVAILABLE,
        body.reason === "too_large"
          ? "the Episode Alert response is too large"
          : "the Episode Alert response could not be read",
      );
    }
    const parsed = parseEpisodeAlertEligibilityXml(body.text, req.serviceDate);
    if (parsed.kind === "malformed") {
      return degraded(CH.UNAVAILABLE, "the Episode Alert response could not be read");
    }
    if (parsed.kind === "unsupported") {
      return degraded(CH.NOT_WIRED, "the Episode Alert response contract is not verified");
    }
    return {
      ok: true,
      data: {
        outcome: parsed.outcome,
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
