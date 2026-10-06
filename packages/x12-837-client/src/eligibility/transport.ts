// @wardenx/x12-837-client — the HETS real-time transport port + the CAQH CORE "HTTP MIME Multipart"
// adapter.
//
// Connectivity (CMS HETS 270/271 5010 Companion Guide §4.3.2–4.3.4 + §4.4): HETS accepts real-time 270s
// over SOAP+WSDL or HTTP MIME multipart/form-data (CAQH CORE Phase II Connectivity Rule v2.2.0) over TLS 1.2
// with X.509 client-certificate authentication, authorised by the CMS-issued Submitter ID (via a Trading
// Partner Agreement), or through a Network Service Vendor / clearinghouse that holds that connectivity.
// CORE MIME is also the de-facto clearinghouse real-time interface, so ONE adapter covers both: direct to
// CMS (client certificate) or to a clearinghouse/NSV endpoint (bearer token), selected by configuration.
//
// The MIME body parts carry the CORE envelope fields (CG Table 4): PayloadType, ProcessingMode, PayloadID,
// TimeStamp, SenderID (10 chars), ReceiverID (CMS), CORERuleVersion (2.2.0), Payload (the raw X12 — not an
// attachment). The response is multipart/form-data with the X12 271 / 999 / TA1 in `Payload` (CG Table 5).
//
// Errors are content-free: never a response body, never X12, never a credential (the 270 carries the MBI).

/** One real-time HETS exchange. `x12` is the 270 interchange (contains the transient MBI). */
export interface HetsTransportRequest {
  readonly x12: string;
  /** CORE PayloadID — a PHI-free unique id (we use the TRN trace number). */
  readonly payloadId: string;
}

export interface HetsTransportResponse {
  /** The X12 interchange HETS answered with (271, or a 999 / TA1 rejection). */
  readonly x12: string;
}

/** The transport port the M23 HETS eligibility service sends a 270 through. */
export interface HetsTransport {
  /** `core_mime` = a real endpoint; `sandbox` = synthetic fixtures (dev/test only, never production). */
  readonly kind: "core_mime" | "sandbox";
  exchange(request: HetsTransportRequest): Promise<HetsTransportResponse>;
}

/** Thrown on any transport failure. `code` is a stable, PHI-free reason. */
export class HetsTransportError extends Error {
  public override readonly name = "HetsTransportError";
  constructor(
    public readonly code:
      | "HETS_HTTP_ERROR"
      | "HETS_TIMEOUT"
      | "HETS_NETWORK_ERROR"
      | "HETS_CORE_ERROR"
      | "HETS_INVALID_RESPONSE",
    message: string,
  ) {
    super(message);
  }
}

export interface CoreMimeHetsTransportConfig {
  /** https endpoint (the CMS HETS MIME URL from the SOAP/MIME Connectivity Instructions, or the NSV's). */
  readonly endpointUrl: string;
  /** CORE SenderID: the submitter id right-padded with zeros to 10 chars (CG Table 4). */
  readonly submitterId: string;
  /** Bearer token for a clearinghouse/NSV endpoint (omit for direct CMS mTLS). */
  readonly bearerToken?: string;
  /** PEM client certificate + key for direct CMS connectivity (TLS 1.2 mutual auth, SHA-256 cert). */
  readonly clientCertificate?: { readonly certPem: string; readonly keyPem: string };
  readonly timeoutMs: number;
}

/** The fetch surface the adapter needs (injected in tests). */
export type HetsFetch = (url: string, init: RequestInit & { tls?: unknown }) => Promise<Response>;

/** CORE SenderID: exactly 10 characters, the submitter id followed by trailing zeros (CG Table 4). */
export function coreSenderId(submitterId: string): string {
  return submitterId.trim().toUpperCase().padEnd(10, "0").slice(0, 10);
}

/** Build the CORE MIME form for one 270 (exported for tests). */
export function buildCoreMimeForm(
  request: HetsTransportRequest,
  submitterId: string,
  now: Date,
): FormData {
  const form = new FormData();
  form.set("PayloadType", "X12_270_Request_005010X279A1");
  form.set("ProcessingMode", "RealTime");
  form.set("PayloadID", request.payloadId);
  form.set("TimeStamp", `${now.toISOString().slice(0, 19)}Z`);
  form.set("SenderID", coreSenderId(submitterId));
  form.set("ReceiverID", "CMS");
  form.set("CORERuleVersion", "2.2.0");
  form.set("Payload", request.x12);
  return form;
}

/** Create the CORE MIME transport. Bun's `fetch` honours `tls: { cert, key }` for the client certificate. */
export function createCoreMimeHetsTransport(
  config: CoreMimeHetsTransportConfig,
  fetchImpl: HetsFetch = (url, init) => fetch(url, init),
  clock: () => Date = () => new Date(),
): HetsTransport {
  if (!/^https:\/\//.test(config.endpointUrl)) {
    throw new Error("HETS endpoint must be an https:// URL");
  }
  return {
    kind: "core_mime",
    async exchange(request) {
      let response: Response;
      try {
        response = await fetchImpl(config.endpointUrl, {
          method: "POST",
          headers: config.bearerToken ? { authorization: `Bearer ${config.bearerToken}` } : {},
          body: buildCoreMimeForm(request, config.submitterId, clock()),
          signal: AbortSignal.timeout(config.timeoutMs),
          ...(config.clientCertificate
            ? {
                tls: {
                  cert: config.clientCertificate.certPem,
                  key: config.clientCertificate.keyPem,
                },
              }
            : {}),
        });
      } catch (err) {
        const timedOut = err instanceof Error && err.name === "TimeoutError";
        throw new HetsTransportError(
          timedOut ? "HETS_TIMEOUT" : "HETS_NETWORK_ERROR",
          timedOut ? "HETS request timed out" : "HETS endpoint unreachable",
        );
      }
      if (response.status < 200 || response.status >= 300) {
        throw new HetsTransportError(
          "HETS_HTTP_ERROR",
          `HETS endpoint returned HTTP ${response.status}`,
        );
      }
      return { x12: await readPayload(response) };
    },
  };
}

/** A CORE envelope larger than this cannot be a 271 (the parser's own cap is 4 MiB of X12). */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function tooLarge(): HetsTransportError {
  return new HetsTransportError("HETS_INVALID_RESPONSE", "HETS response exceeds the size limit");
}

/** The declared Content-Length, or null when absent / not a non-negative integer (then the stream cap decides). */
function declaredLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Read the body as a stream, counting bytes as they arrive; past `MAX_RESPONSE_BYTES` the reader is cancelled and
 * the read refused — a chunked or lying response is never buffered whole before the cap is checked.
 */
async function readCappedBody(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return bytes;
}

async function readPayload(response: Response): Promise<string> {
  const declared = declaredLength(response);
  if (declared !== null && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const contentType = response.headers.get("content-type") ?? "";
  const bytes = await readCappedBody(response);
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    // Some clearinghouses answer the raw X12 body; accept it only if it is an interchange.
    const text = new TextDecoder().decode(bytes);
    if (text.trimStart().startsWith("ISA")) return text;
    throw new HetsTransportError("HETS_INVALID_RESPONSE", "HETS response is not a CORE envelope");
  }
  let form: FormData;
  try {
    // Built from the capped bytes, never from the unbounded response.
    form = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new HetsTransportError("HETS_INVALID_RESPONSE", "HETS CORE envelope is malformed");
  }
  const errorCode = form.get("ErrorCode");
  if (typeof errorCode === "string" && errorCode !== "" && errorCode !== "Success") {
    // CORE error codes are fixed vocabulary (e.g. "PayloadTypeIncorrect"), safe to surface.
    throw new HetsTransportError(
      "HETS_CORE_ERROR",
      `HETS CORE error ${errorCode.replace(/[^A-Za-z0-9]/g, "").slice(0, 40)}`,
    );
  }
  const payload = form.get("Payload");
  const text = typeof payload === "string" ? payload : payload ? await payload.text() : "";
  if (text.length > MAX_RESPONSE_BYTES) throw tooLarge();
  if (!text.trimStart().startsWith("ISA")) {
    throw new HetsTransportError(
      "HETS_INVALID_RESPONSE",
      "HETS CORE envelope carried no X12 payload",
    );
  }
  return text;
}
