import type { TradingPartnerCredentials } from "../credentials";
// @chartwarden/medicaid-adapters — the Oregon launch-gateway (WX-PR-011). Mirrors M23's
// `createM23LaunchGateway`/`m23LaunchGatewayConfigFromEnv` shape (apps/backend/.../jobs/launch-gateway.ts)
// EXCEPT for one deliberate difference: M23's MAC/X12 sidecars are platform-wide (one bearer/URL pair from
// env for the whole cluster), but Oregon's OHA MMIS / CCO endpoints are PER-PROVIDER-ENTITY — each PE's own
// `state_medicaid_trading_partner_credential` row (§3.3) carries its own `portalUrl` + `clientId`/
// `clientSecret`, configured per-tenant through the M34 credential wizard. So this gateway takes NO baseUrl/
// token at construction — every call resolves its endpoint + auth from the `TradingPartnerCredentials` the
// caller already holds (the adapter interface passes `credentials` into every wire-I/O method). The env
// config here gates ONLY whether real outbound calls are permitted at all (capability gate — unset in
// dev/test/CI so nothing calls out by accident), matching M23's "workers only construct when the gateway
// resolves" boot posture.
//
// SIMPLIFICATION (documented, not a real-sandbox claim): Oregon's channel is modeled here as a JSON REST API
// (state MMIS modernization programs commonly expose one), NOT raw X12 837I generation — that is a separate,
// comparably-sized undertaking (M23's own `x12-837-client` sidecar). `assembleSubmissionPayload` stays a PURE
// local JSON envelope build (no network); only submit/poll/eligibility/rate-lookup/parse hit the wire.
import type {
  AckParsedDto,
  EligibilityResult,
  MedicaidClaimAssemblySnapshot,
  PollResult,
  RemittanceParsedDto,
  SubmitResult,
} from "../interface";

export interface M24LaunchGatewayConfig {
  readonly timeoutMs: number;
}

export interface GatewayHttpRequest {
  readonly baseUrl: string;
  readonly bearerToken: string | null;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
  readonly timeoutMs: number;
}

export interface GatewayHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface GatewayHttpPort {
  request(input: GatewayHttpRequest): Promise<GatewayHttpResponse>;
}

const fetchHttp: GatewayHttpPort = {
  async request(input) {
    const response = await fetch(`${input.baseUrl.replace(/\/$/, "")}${input.path}`, {
      method: input.method,
      headers: {
        ...(input.bearerToken === null ? {} : { authorization: `Bearer ${input.bearerToken}` }),
        accept: "application/json",
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // A malformed response is rejected by the operation-specific validator below.
    }
    return { status: response.status, body };
  },
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string";
const nullableString = (value: unknown): value is string | null => value === null || string(value);
const number = (value: unknown): value is number => typeof value === "number";

/** Every Oregon call needs the PE's own portal URL — no baseUrl, no call. Named at the throw site. */
function requirePortal(credentials: TradingPartnerCredentials): {
  baseUrl: string;
  token: string | null;
} {
  if (!credentials.portalUrl) {
    throw new Error(
      `Oregon gateway: provider entity ${credentials.providerEntityId} has no portalUrl configured on its trading-partner credential`,
    );
  }
  return { baseUrl: credentials.portalUrl, token: credentials.clientSecret };
}

async function requestJson(
  http: GatewayHttpPort,
  credentials: TradingPartnerCredentials,
  timeoutMs: number,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const { baseUrl, token } = requirePortal(credentials);
  const response = await http.request({
    baseUrl,
    bearerToken: token,
    method,
    path,
    body,
    timeoutMs,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Oregon MMIS gateway returned HTTP ${response.status}`);
  }
  return response.body;
}

export interface OregonGatewayPort {
  eligibilityCheck(args: {
    recipientIdPlain: string;
    asOfServiceDate: string;
    credentials: TradingPartnerCredentials;
  }): Promise<EligibilityResult>;
  submit(args: {
    body: Uint8Array;
    idempotencyKey: string;
    credentials: TradingPartnerCredentials;
  }): Promise<SubmitResult>;
  poll(args: {
    vendorTransactionId: string;
    credentials: TradingPartnerCredentials;
  }): Promise<PollResult>;
  parseAcknowledgment(args: {
    rawPayload: Uint8Array;
    expectedKind: string;
  }): Promise<AckParsedDto>;
  parseRemittance(args: {
    rawPayload: Uint8Array;
    credentials: TradingPartnerCredentials;
  }): Promise<RemittanceParsedDto>;
  rateLookup(args: {
    serviceDate: string;
    loc: string;
    county: string | null;
    credentials: TradingPartnerCredentials;
  }): Promise<{ rateCents: number; scheduleId: string }>;
  healthy(
    credentials: TradingPartnerCredentials,
  ): Promise<{ ok: boolean; lastChecked: string; latencyMs: number }>;
}

/** Pure, local — no network. Renders the assembled claim snapshot into a canonical JSON submission envelope. */
export function assembleOregonSubmissionPayload(snapshot: MedicaidClaimAssemblySnapshot): {
  body: Uint8Array;
  idempotencyKey: string;
} {
  const envelope = {
    schema: "chartwarden.oregon-direct-mmis.v1",
    claimId: snapshot.claimId,
    patientId: snapshot.patientId,
    serviceState: snapshot.serviceState,
    tob: snapshot.tob,
    serviceFrom: snapshot.serviceFrom,
    serviceTo: snapshot.serviceTo,
    mcoId: snapshot.mcoId,
    medicaidClaimControlNumber: snapshot.medicaidClaimControlNumber,
    lines: snapshot.lines,
  };
  const body = new TextEncoder().encode(JSON.stringify(envelope));
  return { body, idempotencyKey: snapshot.medicaidClaimControlNumber };
}

function isSubmitResult(value: unknown): value is SubmitResult {
  if (!record(value) || !string(value.result)) return false;
  switch (value.result) {
    case "accepted_sync":
      return string(value.vendorTransactionId);
    case "pending_async":
      return string(value.vendorTransactionId) && string(value.nextPollAt);
    case "rejected_sync":
      return (
        string(value.rejectionCode) &&
        string(value.rejectionReason) &&
        nullableString(value.vendorTransactionId ?? null)
      );
    case "transport_failure":
      return string(value.nextRetryAt);
    default:
      return false;
  }
}

function isPollResult(value: unknown): value is PollResult {
  if (!record(value) || !string(value.result)) return false;
  switch (value.result) {
    case "accepted":
      return record(value.ack);
    case "still_pending":
      return string(value.nextPollAt);
    case "rejected":
      return string(value.rejectionCode) && string(value.rejectionReason);
    case "timeout":
      return true;
    default:
      return false;
  }
}

function isEligibilityResult(value: unknown): value is EligibilityResult {
  return (
    record(value) &&
    string(value.outcome) &&
    (value.mcoId === null || string(value.mcoId)) &&
    (value.mcoName === null || string(value.mcoName)) &&
    (value.routingChannel === null || string(value.routingChannel)) &&
    typeof value.recipientIdFormatValid === "boolean" &&
    nullableString(value.recipientIdMasked ?? null) &&
    nullableString(value.vendorTransactionId ?? null)
  );
}

function isAckParsed(value: unknown): value is AckParsedDto {
  return record(value) && string(value.kind) && string(value.outcome);
}

/**
 * Bind Oregon's launch-gateway wire I/O. Consumed by both the Oregon adapter (submit/poll/eligibility/rate)
 * and the M24 worker layer directly (parse-on-receipt during ack-pull) — the same split M23 uses between the
 * adapter and its X12/MAC-portal clients.
 */
export function createM24OregonGateway(
  config: M24LaunchGatewayConfig,
  http: GatewayHttpPort = fetchHttp,
): OregonGatewayPort {
  return {
    async eligibilityCheck({ recipientIdPlain, asOfServiceDate, credentials }) {
      const body = await requestJson(http, credentials, config.timeoutMs, "POST", "/eligibility", {
        recipientId: recipientIdPlain,
        asOfServiceDate,
        tradingPartnerId: credentials.tradingPartnerId,
      });
      if (!isEligibilityResult(body)) {
        throw new Error("Oregon gateway returned an invalid eligibility response");
      }
      return body;
    },
    async submit({ body: payload, idempotencyKey, credentials }) {
      const body = await requestJson(http, credentials, config.timeoutMs, "POST", "/claims", {
        idempotencyKey,
        tradingPartnerId: credentials.tradingPartnerId,
        payload: Buffer.from(payload).toString("base64"),
      });
      if (!isSubmitResult(body)) {
        throw new Error("Oregon gateway returned an invalid submit response");
      }
      return body;
    },
    async poll({ vendorTransactionId, credentials }) {
      const body = await requestJson(
        http,
        credentials,
        config.timeoutMs,
        "GET",
        `/claims/${encodeURIComponent(vendorTransactionId)}/status`,
      );
      if (!isPollResult(body)) {
        throw new Error("Oregon gateway returned an invalid poll response");
      }
      return body;
    },
    async parseAcknowledgment({ rawPayload, expectedKind }) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(rawPayload));
      } catch {
        throw new Error("Oregon gateway acknowledgment payload is not valid JSON");
      }
      if (!isAckParsed(parsed)) {
        throw new Error("Oregon gateway returned an invalid acknowledgment payload");
      }
      if (parsed.kind !== expectedKind) {
        throw new Error(
          `Oregon acknowledgment kind mismatch: expected ${expectedKind}, got ${parsed.kind}`,
        );
      }
      return parsed;
    },
    async parseRemittance({ rawPayload, credentials }) {
      const body = await requestJson(
        http,
        credentials,
        config.timeoutMs,
        "POST",
        "/remittances/parse",
        {
          payload: Buffer.from(rawPayload).toString("base64"),
        },
      );
      if (
        !record(body) ||
        !nullableString(body.payerClaimControlNumber ?? null) ||
        !number(body.paidAmountCents) ||
        !Array.isArray(body.adjustments)
      ) {
        throw new Error("Oregon gateway returned an invalid remittance-parse response");
      }
      return body as unknown as RemittanceParsedDto;
    },
    async rateLookup({ serviceDate, loc, county, credentials }) {
      const body = await requestJson(
        http,
        credentials,
        config.timeoutMs,
        "GET",
        `/rates?serviceDate=${encodeURIComponent(serviceDate)}&loc=${encodeURIComponent(loc)}&county=${encodeURIComponent(county ?? "")}`,
      );
      if (!record(body) || !number(body.rateCents) || !string(body.scheduleId)) {
        throw new Error("Oregon gateway returned an invalid rate-lookup response");
      }
      return { rateCents: body.rateCents, scheduleId: body.scheduleId };
    },
    async healthy(credentials) {
      const started = Date.now();
      const body = await requestJson(http, credentials, config.timeoutMs, "GET", "/health");
      if (!record(body) || typeof body.ok !== "boolean") {
        throw new Error("Oregon gateway returned an invalid health response");
      }
      return {
        ok: body.ok,
        lastChecked: new Date().toISOString(),
        latencyMs: Date.now() - started,
      };
    },
  };
}

/** Capability gate ONLY — real per-call endpoints come from each PE's own trading-partner credential. */
export function m24LaunchGatewayConfigFromEnv(
  env: NodeJS.ProcessEnv,
): M24LaunchGatewayConfig | null {
  if (env.M24_LAUNCH_GATEWAY_ENABLED?.trim() !== "true") return null;
  const timeout = Number(env.M24_GATEWAY_TIMEOUT_MS ?? "30000");
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) {
    throw new Error("M24_GATEWAY_TIMEOUT_MS must be an integer from 1000 through 120000");
  }
  return { timeoutMs: timeout };
}
