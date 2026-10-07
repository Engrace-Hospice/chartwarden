// @wardenx/dosespot — the live DoseSpot v2 HTTP transport (M12 GAP-037 close-out, spec §2.5 / §4.10 / D5).
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
import { DegradedError, type DoseSpotOperation, RetryableError, isRetryableError } from "./errors";
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
import type { DoseSpotTenantConfig, DoseSpotTenantConfigResolver } from "./tenant-config";

/** Minimal fetch surface (the global `fetch` satisfies it; tests inject a recorded fake). */
export type DoseSpotFetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal?: AbortSignal;
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

const DEFAULT_TIMEOUT_MS = 15_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;
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
  const timeoutMs = deps.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const tokens = new Map<string, CachedToken>();
  const breakers = new Map<string, BreakerSnapshot>();
  const newRxProgress = new Map<string, NewRxProgress>();

  const degraded = (
    op: DoseSpotOperation,
    retryable: boolean,
    message: string,
    correlationId: string,
  ) => new DegradedError("dosespot", op, retryable, message, correlationId);

  function configOrDeny(
    op: DoseSpotOperation,
    orgId: string,
    correlationId: string,
  ): DoseSpotTenantConfig {
    const cfg = deps.resolver.configFor(orgId);
    if (cfg === null) {
      throw degraded(
        op,
        false,
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
      });
      return { status: res.status, text: await res.text() };
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      throw new RetryableError("network_timeout", aborted ? "timeout" : "network_error");
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
    const basic = Buffer.from(`${cfg.clinicId}:${cfg.clinicKey}`, "utf8").toString("base64");
    const form = new URLSearchParams({
      grant_type: "password",
      Username: clinicianId,
      Password: cfg.clinicKey,
      scope: "api",
    }).toString();
    const res = await exchange(
      cfg,
      TOKEN_ENDPOINT,
      TOKEN_ENDPOINT.path,
      {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
        "Subscription-Key": cfg.subscriptionKey,
        Accept: "application/json",
      },
      form,
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
    tokens.set(`${orgId}|${clinicianId}`, {
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
    const cached = tokens.get(`${orgId}|${clinicianId}`);
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
  ): Promise<unknown> {
    let forceFresh = false;
    for (let auth = 0; auth < 2; auth += 1) {
      const token = await tokenFor(op, orgId, cfg, clinicianId, correlationId, forceFresh);
      const res = await exchange(
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
      if (res.status === 401 && auth === 0) {
        tokens.delete(`${orgId}|${clinicianId}`);
        forceFresh = true;
        continue;
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
        throw degraded(op, false, "DoseSpot returned an unreadable response.", correlationId);
      }
      const err = resultError(parsed);
      if (err !== null) {
        throw degraded(op, false, `DoseSpot reported an error: ${err}`, correlationId);
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
  ): Promise<unknown> {
    const correlationId = newCorrelationId();
    const endpoint: DoseSpotEndpoint = DOSESPOT_ENDPOINTS[name];
    if (endpoint.verification === "none")
      throw degraded(op, false, UNSUPPORTED_MESSAGE, correlationId);
    const cfg = configOrDeny(op, orgId, correlationId);
    const gate = evaluateBreaker(
      breakers.get(orgId) ?? INITIAL_BREAKER_SNAPSHOT,
      now().toISOString(),
    );
    if (!gate.allowed) throw openCircuitError(op, correlationId);
    const path = buildPath(endpoint.path, params);
    const delays = computeBackoffDelays();
    for (let i = 0; i < DOSESPOT_RETRY_CONFIG.maxAttempts; i += 1) {
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
        );
        noteBreaker(orgId, "success", "");
        return out;
      } catch (err) {
        if (!isRetryableError(err)) throw err; // permanent: does not count against the breaker
        if (i < DOSESPOT_RETRY_CONFIG.maxAttempts - 1) {
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

  const unsupported = (op: DoseSpotOperation, orgId: string): Promise<never> =>
    Promise.reject(
      deps.resolver.configFor(orgId) === null
        ? degraded(
            op,
            false,
            "E-prescribe is not enabled for this organization; DoseSpot credentials are not configured.",
            newCorrelationId(),
          )
        : degraded(op, false, UNSUPPORTED_MESSAGE, newCorrelationId()),
    );

  return {
    async upsertPatient(orgId, payload, idempotencyKey): Promise<DoseSpotPatientResponse> {
      configOrDeny("upsertPatient", orgId, newCorrelationId()); // fail closed BEFORE touching the payload
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
      );
      const id = identifierOf(out);
      if (id === undefined) {
        throw degraded(
          "enrollPrescriber",
          false,
          "DoseSpot returned no clinician id.",
          newCorrelationId(),
        );
      }
      // Identity proofing (IAL2) is a separate DoseSpot flow; enrolment alone never starts EPCS.
      return { dosespotPrescriberId: id, epcsEnrollmentStarted: false };
    },

    revokePrescriber: (orgId) => unsupported("revokePrescriber", orgId),

    async transmitNewRx(orgId, payload, idempotencyKey): Promise<DoseSpotNewRxResponse> {
      const correlationId = newCorrelationId();
      const cfg = configOrDeny("transmitNewRx", orgId, correlationId);
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
      let prescriptionId = newRxProgress.get(progressKey)?.prescriptionId;
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
          throw degraded(
            "transmitNewRx",
            false,
            "DoseSpot returned no prescription id.",
            correlationId,
          );
        }
        newRxProgress.set(progressKey, { prescriptionId });
      }
      const sent = await call(
        "transmitNewRx",
        orgId,
        payload.dosespotPrescriberId,
        "sendPrescriptions",
        { patientId: payload.dosespotPatientId },
        { prescriptionIds: [Number(prescriptionId)] },
        idempotencyKey,
      );
      // The send response is an array of IdentifierResponse; our id must be among them. Anything else is NOT
      // proof it left, so it is an error and the worker retries the SEND (the prescription is remembered above).
      const items = Array.isArray(sent)
        ? sent
        : isRecord(sent)
          ? (pick(sent, "Items") as unknown)
          : undefined;
      const confirmed =
        Array.isArray(items) && items.some((it) => identifierOf(it) === prescriptionId);
      if (!confirmed) {
        throw degraded(
          "transmitNewRx",
          true,
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
