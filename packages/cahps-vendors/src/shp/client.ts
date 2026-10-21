// @wardenx/cahps-vendors — SHP intake API client SHAPE (M30 §4.5 SHP-specific notes).
//
// The platform-default vendor, Strategic Healthcare Programs (SHP), exposes an mTLS + HMAC-SHA256-signed
// intake endpoint (`https://api.shpdata.com/cahps/intake/v2`). This module owns the request-signing helper
// and the client SHAPE only — it performs NO real network I/O. The actual transport is an injected
// `ShpHttpPort`; in P2a no port is wired, so the default port fails closed (degraded). The worker that
// owns the real fetch is a later phase.
import { createHmac } from "node:crypto";
import { ChartWardenError } from "@wardenx/types";

/** SHP's documented intake endpoint (platform default). */
export const SHP_INTAKE_URL = "https://api.shpdata.com/cahps/intake/v2";

/** The decrypted org-bound SHP credentials (from `cahps_vendor_binding.configuration_cipher`). */
export interface ShpClientConfig {
  /** Org-bound API key (sent as the `X-SHP-Key` header). */
  readonly apiKey: string;
  /** Org-bound shared secret used to HMAC-sign the request body. Never logged. */
  readonly apiSecret: string;
  /** Override the intake base URL (tests/staging); defaults to {@link SHP_INTAKE_URL}. */
  readonly baseUrl?: string;
}

/** A fully-formed, signed intake request — the value handed to the injected transport port. */
export interface ShpSignedRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

/** The transport-port response the client maps into a vendor job id. */
export interface ShpHttpResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * The injected transport port — the ONLY way bytes leave the process. P2a ships no real implementation;
 * the worker provides one (an mTLS-pinned fetch) in a later phase.
 */
export type ShpHttpPort = (request: ShpSignedRequest) => Promise<ShpHttpResponse>;

/**
 * Compute the SHP request signature: lowercase-hex HMAC-SHA256 over `"<timestamp>.<body>"` keyed by the
 * org's shared secret. Pure given its inputs. The signed string binds the timestamp so a captured body
 * cannot be replayed outside its window.
 */
export function signShpRequest(secret: string, body: Buffer, timestamp: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
}

/** The default port: no transport is wired in P2a, so any push fails closed as degraded. */
const NO_TRANSPORT_PORT: ShpHttpPort = () => {
  throw new ChartWardenError(
    "CAHPS_TRANSPORT_UNAVAILABLE",
    "no SHP transport port is wired (P2a ships the client shape only)",
    503,
  );
};

/**
 * The SHP intake client SHAPE. Builds + signs the request, then delegates the bytes to the injected
 * {@link ShpHttpPort}. Constructs the signed request deterministically; the only non-purity is the
 * injected port (and the timestamp, which the caller may pass for reproducibility).
 */
export class ShpClient {
  private readonly http: ShpHttpPort;

  constructor(
    private readonly config: ShpClientConfig,
    http: ShpHttpPort = NO_TRANSPORT_PORT,
  ) {
    this.http = http;
  }

  /** Build the signed intake request for a rendered export file (no I/O). */
  buildIntakeRequest(
    file: { filename: string; bytes: Buffer },
    timestamp: string,
  ): ShpSignedRequest {
    const signature = signShpRequest(this.config.apiSecret, file.bytes, timestamp);
    return {
      url: this.config.baseUrl ?? SHP_INTAKE_URL,
      method: "POST",
      headers: {
        "content-type": "text/csv",
        "x-shp-key": this.config.apiKey,
        "x-shp-timestamp": timestamp,
        "x-shp-signature": signature,
        "x-shp-filename": file.filename,
      },
      body: file.bytes,
    };
  }

  /**
   * Push a rendered export through the injected transport and return the SHP job id. Throws
   * `CAHPS_PUSH_REJECTED` when the vendor responds non-2xx. Uses the injected/default port — never a
   * direct fetch.
   */
  async postIntake(
    file: { filename: string; bytes: Buffer },
    timestamp: string,
  ): Promise<{ vendorJobId: string }> {
    const request = this.buildIntakeRequest(file, timestamp);
    const response = await this.http(request);
    if (response.status < 200 || response.status >= 300) {
      throw new ChartWardenError(
        "CAHPS_PUSH_REJECTED",
        `SHP intake rejected the export (status ${response.status})`,
        502,
      );
    }
    return { vendorJobId: parseVendorJobId(response.body) };
  }
}

/** Extract the SHP-assigned job id from the intake response body (`{"jobId":"..."}`). */
function parseVendorJobId(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "jobId" in parsed &&
      typeof (parsed as { jobId: unknown }).jobId === "string"
    ) {
      return (parsed as { jobId: string }).jobId;
    }
  } catch {
    // fall through to the structured error below
  }
  throw new ChartWardenError("CAHPS_PUSH_REJECTED", "SHP intake response did not carry a jobId", 502);
}
