// @chartwarden/dosespot — the live DoseSpot v2 HTTP transport (M12 GAP-037 close-out, spec §2.5 / §4.10 / D5).
//
// FAIL-CLOSED BY CONSTRUCTION. `createHttpDoseSpotClient` reads each tenant's configuration through the injected
// {@link DoseSpotTenantConfigResolver}; a tenant with no complete config gets a non-retryable `DegradedError` and
// NOTHING is sent. It never fabricates a success: every resolved value is parsed out of a real vendor response
// body, and a response that lacks what we need (no prescription id after a send) is an error, not a default.
//
// WHAT IT OWNS (spec §4.10): OAuth2 token minting + per-(tenant, clinician) caching with early refresh, the
// `Subscription-Key` + `Authorization: Bearer` headers, a hard timeout, error classification (429/5xx/network ⇒
// retryable with the per-call 250/500 ms backoff, then a retryable `DegradedError` for the BullMQ layer; other 4xx
// and `Result.ResultCode = "ERROR"` ⇒ permanent), one forced re-mint on a 401, the per-tenant circuit breaker
// (pure state in ./circuit-breaker, the open/close edges reported through `onBreakerEdge`), and NewRx
// idempotency (the D8 key rides an `Idempotency-Key` header AND an in-process map remembers a prescription that
// was created but whose send failed, so a retry sends the SAME prescription rather than creating a second).
//
// WHAT IT DOES NOT CLAIM. Endpoint paths and field names that no readable spec confirmed are flagged in
// ./endpoints.ts and ./mappers.ts (`verification` / `WIRE_FIELD_MAPPING_VERIFIED`); the contract tests pin OUR
// behaviour against a recorded fake transport, not the vendor's. Request/response bodies are never logged.
import { randomUUID } from "node:crypto";
import {
  type BreakerSnapshot,
  INITIAL_BREAKER_SNAPSHOT,
  applyOutcome,
  didTransition,
  evaluateBreaker,
  openCircuitError,
} from "./circuit-breaker";
import type {
  DoseSpotClient,
  DoseSpotEpcsSessionResponse,
  DoseSpotMedHistoryItem,
  DoseSpotMedHistoryResponse,
  DoseSpotNewRxResponse,
  DoseSpotPatientResponse,
  DoseSpotPrescriberResponse,
  DoseSpotPrescriptionStatusResponse,
  DoseSpotRxBenefitResponse,
} from "./contract";
import { DOSESPOT_ENDPOINTS, type DoseSpotEndpoint, TOKEN_ENDPOINT, buildPath } from "./endpoints";
import {
  ConfigUnavailableError,
  DegradedError,
  type DoseSpotOperation,
  NotEnabledError,
  RetryableError,
  UnconfirmedOutcomeError,
  isRetryableError,
} from "./errors";
import {
  asString,
  findPrescription,
  identifierOf,
  isRecord,
  phaseOfStatus,
  pick,
  resultError,
  toCodedPrescriptionBody,
  toMedHistoryItem,
  toPatientBody,
} from "./mappers";
import { DOSESPOT_RETRY_CONFIG, classifyRetryableStatus, computeBackoffDelays } from "./retry";
import type {
  DoseSpotConfigPurpose,
  DoseSpotTenantConfig,
  DoseSpotTenantConfigResolver,
} from "./tenant-config";
import { evictOtherGenerations, tokenCacheKey } from "./token-cache";
import { buildTokenRequest } from "./token-request";

/** Minimal fetch surface (the global `fetch` satisfies it; tests inject a recorded fake). */
export type DoseSpotFetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal?: AbortSignal;
    /**
     * Always `"error"`: a redirect is never followed. The token body holds the clinic key and the headers the Subscription-Key, and a
     * 307/308 would re-send both to wherever it points (the standard strips only `Authorization` across origins).
     */
    readonly redirect?: "error";
  },
) => Promise<{
  readonly status: number;
  text(): Promise<string>;
}>;

export interface HttpDoseSpotClientDeps {
  readonly resolver: DoseSpotTenantConfigResolver;
  readonly fetch?: DoseSpotFetch;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly newCorrelationId?: () => string;
  readonly requestTimeoutMs?: number;
  /** Called on the breaker's open/close edge (the worker emits `m12.dosespot_degraded` / `_recovered`). */
  readonly onBreakerEdge?: (event: {
    readonly organizationId: string;
    readonly edge: "opened" | "closed";
    readonly lastErrorClass: string;
  }) => void;
}

/** The hard timeout of ONE DoseSpot request. The enrolment's claim window is sized from it. */
export const DOSESPOT_REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;
/**
 * Endpoints that are NEVER re-sent inside one call. `addClinician` creates a clinician and carries no idempotency key (DoseSpot's own
 * dedupe by NPI is unverified), so a 5xx or a timeout, which may well mean the clinician WAS created, is ONE attempt and then a retryable
 * degraded error; the enrolment's claim decides when a second attempt is allowed. Calls that carry an `Idempotency-Key` keep their retries.
 */
const NO_IN_CALL_RETRY: ReadonlySet<keyof typeof DOSESPOT_ENDPOINTS> = new Set([
  "addClinician",
  // the SEND transmits to the pharmacy and DoseSpot's dedupe of a repeated send is unverified: one attempt per call, and a timeout is held
  "sendPrescriptions",
]);
/**
 * Endpoints whose request, once it may have left, cannot be assumed unanswered: a timeout or a dropped connection (anything but a connection
 * that was never made) is an {@link UnconfirmedOutcomeError}, so the caller holds the order instead of re-sending it.
 */
const AMBIGUOUS_ON_LOST_ANSWER: ReadonlySet<keyof typeof DOSESPOT_ENDPOINTS> = new Set([
  "sendPrescriptions",
]);
/**
 * For those same endpoints, every 5xx but a 503 is held like a lost answer: a 500 (failed mid-way), a 502/504 (a gateway lost the
 * upstream's answer), a 501, a 505-511 or a proxy's 52x/599 may follow a send that reached the pharmacy. A 503 (and a 429) says the
 * request was not taken and stays retryable.
 */
const isAmbiguousStatus = (status: number): boolean => status >= 500 && status !== 503;
/** Socket errors that mean the connection was never made, so nothing reached DoseSpot (a connect TIMEOUT is an abort, not one of these: it is held). */
const NOT_CONNECTED_CODES: ReadonlySet<string> = new Set([
  // Bun 1.3.5 (production's runtime) reports a refused connection AND a failed DNS lookup as a plain Error with code "ConnectionRefused"
  "ConnectionRefused",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
]);
const UNSUPPORTED_MESSAGE =
  "This operation is not available against the verified DoseSpot API surface; it requires DoseSpot sandbox verification before it can be enabled.";

interface CachedToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

interface NewRxProgress {
  readonly prescriptionId: string;
}

const defaultFetch: DoseSpotFetch = (url, init) =>
  fetch(url, init as RequestInit) as unknown as ReturnType<DoseSpotFetch>;

export function createHttpDoseSpotClient(deps: HttpDoseSpotClientDeps): DoseSpotClient {
  const doFetch = deps.fetch ?? defaultFetch;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const newCorrelationId = deps.newCorrelationId ?? randomUUID;
  const timeoutMs = deps.requestTimeoutMs ?? DOSESPOT_REQUEST_TIMEOUT_MS;

  const tokens = new Map<string, CachedToken>();
  const breakers = new Map<string, BreakerSnapshot>();
  const newRxProgress = new Map<string, NewRxProgress>();

  const degraded = (
    op: DoseSpotOperation,
    retryable: boolean,
    message: string,
    correlationId: string,
  ) => new DegradedError("dosespot", op, retryable, message, correlationId);

  /** A resolver fault (database, key ring, KEK, credential): a retryable degraded error naming nothing of the cause, which rides on `cause`. */
  const configUnavailable = (op: DoseSpotOperation, correlationId: string, cause: unknown) =>
    new ConfigUnavailableError(
      "dosespot",
      op,
      "E-prescribe is temporarily unavailable for this organization; the request will retry automatically.",
      correlationId,
      cause,
    );

  /**
   * The tenant's config for `purpose`, or a non-retryable denial. The resolver is awaited on EVERY call (a database-backed one
   * re-reads the row), so a deactivation or rotation takes effect on the very next call. A resolver that THROWS (a sealed
   * credential that cannot be opened, a key ring or database fault) becomes a retryable {@link ConfigUnavailableError} with the
   * original on `cause`: a fault, never "not configured". A WORKER holding queued orders does not meet it order by order: the
   * transmit pass resolves the config once before claiming and skips the org, so only a caller without that preflight sees it here.
   */
  async function configOrDeny(
    op: DoseSpotOperation,
    orgId: string,
    correlationId: string,
    purpose: DoseSpotConfigPurpose = "operate",
  ): Promise<DoseSpotTenantConfig> {
    let cfg: DoseSpotTenantConfig | null;
    try {
      cfg = await deps.resolver.configFor(orgId, purpose);
    } catch (cause) {
      throw configUnavailable(op, correlationId, cause);
    }
    if (cfg === null) {
      throw new NotEnabledError(
        "dosespot",
        op,
        "E-prescribe is not enabled for this organization; DoseSpot credentials are not configured.",
        correlationId,
      );
    }
    return cfg;
  }

  /** One raw HTTP exchange → status + body text. Network failures and timeouts become RetryableError. */
  async function exchange(
    cfg: DoseSpotTenantConfig,
    endpoint: DoseSpotEndpoint,
    path: string,
    headers: Record<string, string>,
    body: string | undefined,
  ): Promise<{ status: number; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${cfg.baseUrl}${path}`, {
        method: endpoint.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
        redirect: "error",
      });
      return { status: res.status, text: await res.text() };
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      // Bun puts the code on the error itself (`code: "ConnectionRefused"`, no cause); undici puts the socket code on `cause`
      const shaped = err as { code?: unknown; cause?: { code?: unknown } } | null;
      const code = shaped?.code ?? shaped?.cause?.code;
      const notConnected = typeof code === "string" && NOT_CONNECTED_CODES.has(code);
      throw new RetryableError(
        "network_timeout",
        aborted ? "timeout" : notConnected ? "connect_failed" : "network_error",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function mintToken(
    op: DoseSpotOperation,
    orgId: string,
    cfg: DoseSpotTenantConfig,
    clinicianId: string,
    correlationId: string,
  ): Promise<string> {
    const request = buildTokenRequest(cfg, clinicianId);
    const res = await exchange(
      cfg,
      TOKEN_ENDPOINT,
      TOKEN_ENDPOINT.path,
      request.headers,
      request.body,
    );
    const retryable = classifyRetryableStatus(res.status);
    if (retryable) throw retryable;
    if (res.status < 200 || res.status >= 300) {
      // 400/401 on the token endpoint = bad clinic credentials or clinician id: permanent, operator-facing.
      throw degraded(
        op,
        false,
        `DoseSpot rejected the clinic credentials (token endpoint HTTP ${res.status}).`,
        correlationId,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      throw degraded(op, false, "DoseSpot returned an unreadable token response.", correlationId);
    }
    const accessToken = asString(pick(parsed, "access_token"));
    if (accessToken === undefined) {
      throw degraded(op, false, "DoseSpot token response carried no access_token.", correlationId);
    }
    const expiresIn = Number(pick(parsed, "expires_in"));
    const ttlMs = (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 600) * 1000;
    const key = tokenCacheKey(orgId, clinicianId, cfg.version);
    evictOtherGenerations(tokens, orgId, clinicianId, key);
    tokens.set(key, {
      token: accessToken,
      expiresAtMs: now().getTime() + ttlMs,
    });
    return accessToken;
  }

  async function tokenFor(
    op: DoseSpotOperation,
    orgId: string,
    cfg: DoseSpotTenantConfig,
    clinicianId: string,
    correlationId: string,
    forceFresh: boolean,
  ): Promise<string> {
    const cached = tokens.get(tokenCacheKey(orgId, clinicianId, cfg.version));
    if (!forceFresh && cached && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > now().getTime()) {
      return cached.token;
    }
    return mintToken(op, orgId, cfg, clinicianId, correlationId);
  }

  /** One authenticated attempt: 401 ⇒ re-mint once. Returns parsed JSON (or null for an empty body). */
  async function attempt(
    op: DoseSpotOperation,
    orgId: string,
    cfg: DoseSpotTenantConfig,
    clinicianId: string,
    endpoint: DoseSpotEndpoint,
    path: string,
    body: unknown,
    idempotencyKey: string | undefined,
    correlationId: string,
    ambiguousOnLostAnswer: boolean,
  ): Promise<unknown> {
    let forceFresh = false;
    for (let auth = 0; auth < 2; auth += 1) {
      const token = await tokenFor(op, orgId, cfg, clinicianId, correlationId, forceFresh);
      let res: { status: number; text: string };
      try {
        res = await exchange(
          cfg,
          endpoint,
          path,
          {
            Authorization: `Bearer ${token}`,
            "Subscription-Key": cfg.subscriptionKey,
            Accept: "application/json",
            "X-Correlation-Id": correlationId,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(idempotencyKey !== undefined ? { "Idempotency-Key": idempotencyKey } : {}),
          },
          body === undefined ? undefined : JSON.stringify(body),
        );
      } catch (err) {
        // the request may have reached DoseSpot and been acted on before its answer was lost: AMBIGUOUS, not an outage (the token mint
        // above is outside this: a failed mint sent nothing)
        if (ambiguousOnLostAnswer && isRetryableError(err) && err.errorClass !== "connect_failed") {
          throw new UnconfirmedOutcomeError(
            "dosespot",
            op,
            "DoseSpot did not answer in time.",
            correlationId,
          );
        }
        throw err;
      }
      if (res.status === 401 && auth === 0) {
        tokens.delete(tokenCacheKey(orgId, clinicianId, cfg.version));
        forceFresh = true;
        continue;
      }
      if (ambiguousOnLostAnswer && isAmbiguousStatus(res.status)) {
        throw new UnconfirmedOutcomeError(
          "dosespot",
          op,
          `DoseSpot failed without confirming the outcome (HTTP ${res.status}).`,
          correlationId,
        );
      }
      const retryable = classifyRetryableStatus(res.status);
      if (retryable) throw retryable;
      if (res.status < 200 || res.status >= 300) {
        throw degraded(
          op,
          false,
          `DoseSpot rejected the request (HTTP ${res.status}).`,
          correlationId,
        );
      }
      if (res.text.trim() === "") return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.text);
      } catch {
        // accepted (2xx) but unreadable: what was asked for may exist, so the outcome is AMBIGUOUS, not a refusal
        throw new UnconfirmedOutcomeError(
          "dosespot",
          op,
          "DoseSpot returned an unreadable response.",
          correlationId,
        );
      }
      // a refusal; the vendor's description is never carried (free text: it can echo a name or a drug, and the message reaches responses)
      if (resultError(parsed) !== null) {
        throw degraded(op, false, "DoseSpot reported an error.", correlationId);
      }
      return parsed;
    }
    throw degraded(op, false, "DoseSpot rejected the access token twice.", correlationId);
  }

  function noteBreaker(orgId: string, outcome: "success" | "failure", errorClass: string): void {
    const before = breakers.get(orgId) ?? INITIAL_BREAKER_SNAPSHOT;
    const after = applyOutcome(before, outcome, now().toISOString());
    breakers.set(orgId, after);
    const edge = didTransition(before, after);
    if (edge !== null)
      deps.onBreakerEdge?.({ organizationId: orgId, edge, lastErrorClass: errorClass });
  }

  /** The §4.10 `call()`: breaker gate → attempts with backoff → classified DegradedError. */
  async function call(
    op: DoseSpotOperation,
    orgId: string,
    clinicianId: string | undefined,
    name: keyof typeof DOSESPOT_ENDPOINTS,
    params: Record<string, string>,
    body?: unknown,
    idempotencyKey?: string,
    purpose: DoseSpotConfigPurpose = "operate",
  ): Promise<unknown> {
    const correlationId = newCorrelationId();
    const endpoint: DoseSpotEndpoint = DOSESPOT_ENDPOINTS[name];
    if (endpoint.verification === "none")
      throw degraded(op, false, UNSUPPORTED_MESSAGE, correlationId);
    const cfg = await configOrDeny(op, orgId, correlationId, purpose);
    const gate = evaluateBreaker(
      breakers.get(orgId) ?? INITIAL_BREAKER_SNAPSHOT,
      now().toISOString(),
    );
    if (!gate.allowed) throw openCircuitError(op, correlationId);
    const path = buildPath(endpoint.path, params);
    const delays = computeBackoffDelays();
    const maxAttempts = NO_IN_CALL_RETRY.has(name) ? 1 : DOSESPOT_RETRY_CONFIG.maxAttempts;
    for (let i = 0; i < maxAttempts; i += 1) {
      try {
        const out = await attempt(
          op,
          orgId,
          cfg,
          clinicianId ?? cfg.serviceClinicianId,
          endpoint,
          path,
          body,
          idempotencyKey,
          correlationId,
          AMBIGUOUS_ON_LOST_ANSWER.has(name),
        );
        noteBreaker(orgId, "success", "");
        return out;
      } catch (err) {
        if (!isRetryableError(err)) throw err; // permanent: does not count against the breaker
        if (i < maxAttempts - 1) {
          await sleep(delays[i] ?? DOSESPOT_RETRY_CONFIG.baseDelayMs);
          continue;
        }
        noteBreaker(orgId, "failure", err.errorClass);
        throw degraded(
          op,
          true,
          "E-prescribe service is temporarily unavailable; the request will retry automatically.",
          correlationId,
        );
      }
    }
    throw degraded(op, true, "E-prescribe retry budget exhausted.", correlationId);
  }

  const unsupported = async (op: DoseSpotOperation, orgId: string): Promise<never> => {
    const correlationId = newCorrelationId();
    let cfg: DoseSpotTenantConfig | null;
    try {
      cfg = await deps.resolver.configFor(orgId);
    } catch (cause) {
      throw configUnavailable(op, correlationId, cause);
    }
    throw cfg === null
      ? new NotEnabledError(
          "dosespot",
          op,
          "E-prescribe is not enabled for this organization; DoseSpot credentials are not configured.",
          newCorrelationId(),
        )
      : degraded(op, false, UNSUPPORTED_MESSAGE, newCorrelationId());
  };

  return {
    async upsertPatient(orgId, payload, idempotencyKey): Promise<DoseSpotPatientResponse> {
      await configOrDeny("upsertPatient", orgId, newCorrelationId()); // fail closed BEFORE touching the payload
      const body = toPatientBody(payload);
      const existing = payload.existingDosespotPatientId;
      const out =
        existing !== undefined
          ? await call(
              "upsertPatient",
              orgId,
              undefined,
              "editPatient",
              { patientId: existing },
              body,
              idempotencyKey,
            )
          : await call("upsertPatient", orgId, undefined, "addPatient", {}, body, idempotencyKey);
      const id = existing ?? identifierOf(out);
      if (id === undefined) {
        throw degraded(
          "upsertPatient",
          false,
          "DoseSpot returned no patient id.",
          newCorrelationId(),
        );
      }
      return { dosespotPatientId: id, upsertedAt: now().toISOString() };
    },

    async enrollPrescriber(orgId, payload): Promise<DoseSpotPrescriberResponse> {
      const out = await call(
        "enrollPrescriber",
        orgId,
        undefined,
        "addClinician",
        {},
        {
          FirstName: payload.firstName,
          LastName: payload.lastName,
          NPINumber: payload.npi,
          ...(payload.deaNumber ? { DEANumber: payload.deaNumber } : {}),
        },
        undefined,
        "setup", // a verified (not yet active) config may enrol its prescribers
      );
      const id = identifierOf(out);
      if (id === undefined) {
        // accepted (2xx) with no id: the clinician may exist at DoseSpot, so the outcome is AMBIGUOUS, not a refusal
        throw new UnconfirmedOutcomeError(
          "dosespot",
          "enrollPrescriber",
          "DoseSpot returned no clinician id.",
          newCorrelationId(),
        );
      }
      // Identity proofing (IAL2) is a separate DoseSpot flow; enrolment alone never starts EPCS.
      return { dosespotPrescriberId: id, epcsEnrollmentStarted: false };
    },

    revokePrescriber: (orgId) => unsupported("revokePrescriber", orgId),

    async transmitNewRx(orgId, payload, idempotencyKey, resume): Promise<DoseSpotNewRxResponse> {
      const correlationId = newCorrelationId();
      const cfg = await configOrDeny("transmitNewRx", orgId, correlationId);
      if (payload.deaSchedule !== undefined && !cfg.epcsCertified) {
        // 21 CFR 1311: a controlled substance never leaves through a non-certified tenant (D18).
        throw degraded(
          "transmitNewRx",
          false,
          "Controlled-substance e-prescribing is not certified for this organization (EPCS_NOT_CERTIFIED).",
          correlationId,
        );
      }
      const progressKey = `${orgId}|${idempotencyKey}`;
      // a persisted id from an earlier attempt (any process) wins over this process's own memory
      let prescriptionId =
        resume?.createdPrescriptionId ?? newRxProgress.get(progressKey)?.prescriptionId;
      if (prescriptionId === undefined) {
        const created = await call(
          "transmitNewRx",
          orgId,
          payload.dosespotPrescriberId,
          "addCodedPrescription",
          { patientId: payload.dosespotPatientId },
          toCodedPrescriptionBody(payload),
          idempotencyKey,
        );
        prescriptionId = identifierOf(created);
        if (prescriptionId === undefined) {
          // accepted (2xx) with no id: the prescription may exist at DoseSpot, so the outcome is AMBIGUOUS, not a refusal (a worker holds the
          // order for a person instead of failing it, and never re-sends it)
          throw new UnconfirmedOutcomeError(
            "dosespot",
            "transmitNewRx",
            "DoseSpot returned no prescription id.",
            correlationId,
          );
        }
        newRxProgress.set(progressKey, { prescriptionId });
        // remember it OUTSIDE this process before the send: a retry elsewhere then re-runs only the send
        await resume?.onCreated?.(prescriptionId);
      }
      // the caller's last chance to refuse, on the create path AND the resumed one (a persisted id skips the create, and `onCreated` with it)
      await resume?.beforeSend?.();
      const sent = await call(
        "transmitNewRx",
        orgId,
        payload.dosespotPrescriberId,
        "sendPrescriptions",
        { patientId: payload.dosespotPatientId },
        { prescriptionIds: [Number(prescriptionId)] },
        idempotencyKey,
      );
      // The send response is an array of IdentifierResponse; our id must be among them. A 2xx that does not echo it (an empty body included)
      // is NOT proof it left, but DoseSpot ACCEPTED the send, so it may have: an UNCONFIRMED outcome (the worker holds the order for a
      // person), never a retry that could send the prescription to the pharmacy twice.
      const items = Array.isArray(sent)
        ? sent
        : isRecord(sent)
          ? (pick(sent, "Items") as unknown)
          : undefined;
      const confirmed =
        Array.isArray(items) && items.some((it) => identifierOf(it) === prescriptionId);
      if (!confirmed) {
        throw new UnconfirmedOutcomeError(
          "dosespot",
          "transmitNewRx",
          "DoseSpot did not confirm the prescription was sent.",
          correlationId,
        );
      }
      newRxProgress.delete(progressKey);
      return { dosespotPrescriptionId: prescriptionId, transmittedAt: now().toISOString() };
    },

    lookupRxBenefit: (orgId): Promise<DoseSpotRxBenefitResponse> =>
      unsupported("lookupRxBenefit", orgId),

    async pullMedicationHistory(orgId, payload): Promise<DoseSpotMedHistoryResponse> {
      // One page: the public swagger shows a `PagedListResponse` but its paging parameters were not readable,
      // so none are sent (nothing unverified goes on the wire). Multi-page pulls need sandbox verification.
      const out = await call("pullMedicationHistory", orgId, undefined, "getMedicationHistory", {
        patientId: payload.dosespotPatientId,
      });
      const list = pick(out, "Items", "Data", "Medications");
      const items: DoseSpotMedHistoryItem[] = [];
      for (const raw of Array.isArray(list) ? list : []) {
        const mapped = toMedHistoryItem(raw);
        if (mapped !== null) items.push(mapped);
      }
      return { items, pulledAt: now().toISOString() };
    },

    respondToRefillRequest: (orgId) => unsupported("respondToRefillRequest", orgId),

    async getPrescriptionStatus(
      orgId,
      dosespotPatientId,
      dosespotPrescriptionId,
    ): Promise<DoseSpotPrescriptionStatusResponse> {
      const out = await call("getPrescriptionStatus", orgId, undefined, "getPatientPrescriptions", {
        patientId: dosespotPatientId,
      });
      const item = findPrescription(out, dosespotPrescriptionId);
      const raw = item === null ? undefined : asString(pick(item, "Status"));
      if (raw === undefined) {
        throw degraded(
          "getPrescriptionStatus",
          false,
          "DoseSpot did not list the prescription or its status.",
          newCorrelationId(),
        );
      }
      return {
        dosespotPrescriptionId,
        phase: phaseOfStatus(raw),
        rawStatus: raw,
        observedAt: now().toISOString(),
      };
    },

    initiateEpcsSigningSession: (orgId): Promise<DoseSpotEpcsSessionResponse> =>
      unsupported("initiateEpcsSigningSession", orgId),
  };
}
