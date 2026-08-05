import type { MacPortalPort, X12ClientPort } from "./m23-jobs";

export interface M23LaunchGatewayConfig {
  readonly x12BaseUrl: string;
  readonly x12BearerToken: string;
  readonly macBaseUrl: string;
  readonly macBearerToken: string;
  readonly timeoutMs: number;
}

export interface GatewayHttpRequest {
  readonly baseUrl: string;
  readonly bearerToken: string;
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
        authorization: `Bearer ${input.bearerToken}`,
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
const strings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(string);

async function requestJson(http: GatewayHttpPort, input: GatewayHttpRequest): Promise<unknown> {
  const response = await http.request(input);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Medicare gateway returned HTTP ${response.status}`);
  }
  return response.body;
}

/**
 * Bind the launch gateway contract used by the M23 workers. Authentication stays inside the HTTP port;
 * errors never include response bodies, credentials, X12 bytes, or acknowledgment contents.
 */
export function createM23LaunchGateway(
  config: M23LaunchGatewayConfig,
  http: GatewayHttpPort = fetchHttp,
): { readonly x12: X12ClientPort; readonly macPortal: MacPortalPort } {
  const x12Request = (path: string, body: unknown) =>
    requestJson(http, {
      baseUrl: config.x12BaseUrl,
      bearerToken: config.x12BearerToken,
      method: "POST",
      path,
      body,
      timeoutMs: config.timeoutMs,
    });
  const macRequest = (method: "GET" | "POST", path: string, body?: unknown) =>
    requestJson(http, {
      baseUrl: config.macBaseUrl,
      bearerToken: config.macBearerToken,
      method,
      path,
      body,
      timeoutMs: config.timeoutMs,
    });

  const generated = async (path: string, input: unknown) => {
    const body = await x12Request(path, input);
    if (
      !record(body) ||
      !string(body.x12) ||
      !string(body.correlationId) ||
      body.x12.length === 0
    ) {
      throw new Error("X12 gateway returned an invalid generation response");
    }
    return { x12: body.x12, correlationId: body.correlationId };
  };

  const x12: X12ClientPort = {
    generate837i: (input) => generated("/generate-837i", input),
    generateNoe: (input) => generated("/generate-noe", input),
    generateNotr: (input) => generated("/generate-notr", input),
    async parse999(input) {
      const body = await x12Request("/parse-999", input);
      if (!Array.isArray(body) || !body.every(isParsed999)) {
        throw new Error("X12 gateway returned an invalid 999 response");
      }
      return body;
    },
    async parse277ca(input) {
      const body = await x12Request("/parse-277ca", input);
      if (!Array.isArray(body) || !body.every(isParsed277ca)) {
        throw new Error("X12 gateway returned an invalid 277CA response");
      }
      return body;
    },
  };

  const macPortal: MacPortalPort = {
    async upload(input) {
      const body = await macRequest("POST", "/uploads", input);
      if (!record(body) || typeof body.accepted !== "boolean" || !string(body.generatedFileUri)) {
        throw new Error("MAC gateway returned an invalid upload response");
      }
      return { accepted: body.accepted, generatedFileUri: body.generatedFileUri };
    },
    async pullPending999(macJurisdiction) {
      return pendingFiles(
        await macRequest(
          "GET",
          `/acknowledgments/999?jurisdiction=${encodeURIComponent(macJurisdiction)}`,
        ),
      );
    },
    async pullPending277ca(macJurisdiction) {
      return pendingFiles(
        await macRequest(
          "GET",
          `/acknowledgments/277ca?jurisdiction=${encodeURIComponent(macJurisdiction)}`,
        ),
      );
    },
    async probeHealth(macJurisdiction) {
      const body = await macRequest(
        "GET",
        `/health?jurisdiction=${encodeURIComponent(macJurisdiction)}`,
      );
      if (!record(body) || typeof body.available !== "boolean") {
        throw new Error("MAC gateway returned an invalid health response");
      }
      return body.available;
    },
  };
  return { x12, macPortal };
}

function pendingFiles(value: unknown): readonly { readonly rawFileUri: string }[] {
  if (!record(value) || !Array.isArray(value.files)) {
    throw new Error("MAC gateway returned an invalid acknowledgment listing");
  }
  const files = value.files.map((item) => {
    if (!record(item) || !string(item.rawFileUri)) {
      throw new Error("MAC gateway returned an invalid acknowledgment file reference");
    }
    return { rawFileUri: item.rawFileUri };
  });
  return files;
}

function isParsed999(value: unknown): boolean {
  return (
    record(value) &&
    string(value.organizationId) &&
    string(value.claimId) &&
    string(value.submissionId) &&
    string(value.claimControlNumber) &&
    typeof value.accepted === "boolean" &&
    strings(value.reasonCodes) &&
    string(value.ackFileUri)
  );
}

function isParsed277ca(value: unknown): boolean {
  return (
    record(value) &&
    string(value.organizationId) &&
    string(value.claimId) &&
    string(value.submissionId) &&
    (value.outcome === "accepted" || value.outcome === "rejected" || value.outcome === "partial") &&
    string(value.payerClaimControlNumber) &&
    strings(value.reasonCodes) &&
    string(value.ackFileUri)
  );
}

export function m23LaunchGatewayConfigFromEnv(
  env: NodeJS.ProcessEnv,
): M23LaunchGatewayConfig | null {
  const x12BaseUrl = env.M23_X12_GATEWAY_URL?.trim();
  const x12BearerToken = env.M23_X12_GATEWAY_TOKEN?.trim();
  const macBaseUrl = env.M23_MAC_GATEWAY_URL?.trim();
  const macBearerToken = env.M23_MAC_GATEWAY_TOKEN?.trim();
  if (!x12BaseUrl || !x12BearerToken || !macBaseUrl || !macBearerToken) return null;
  const timeout = Number(env.M23_GATEWAY_TIMEOUT_MS ?? "30000");
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) {
    throw new Error("M23_GATEWAY_TIMEOUT_MS must be an integer from 1000 through 120000");
  }
  return { x12BaseUrl, x12BearerToken, macBaseUrl, macBearerToken, timeoutMs: timeout };
}
