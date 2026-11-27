// @chartwarden/x12-837-client — the Claim.MD webhook CAPTURE file (CW-TX-02). PURE: no I/O, no clock.
//
// A capture is one delivery as it arrived: the exact body bytes (base64) and the few headers the receiver reads. It is what the
// replay report (`claimmd-webhook-replay.ts`) consumes, so the first real delivery can be checked offline without changing the
// receiver. A capture of a real delivery can hold a provider TIN or an NPI: it stays on the machine that took it (never in the
// repository, a ticket or an agent session); only the replay REPORT, which carries no field value, is meant to be shared.
//
// Header handling: only an allowlist of header VALUES is kept (the signature and the transport headers that decide how the bytes
// must be read). Every other header contributes its NAME only, so a cookie or an authorization value never reaches the file.
import { Buffer } from "node:buffer";

export const CLAIMMD_CAPTURE_FORMAT = "claimmd-webhook-capture/1";
/** Largest body a capture may hold: the receiver's own 1 MiB limit (a larger delivery is a 413 and is not worth keeping). */
export const CLAIMMD_CAPTURE_MAX_BODY_BYTES = 1024 * 1024;
const MAX_OTHER_HEADER_NAMES = 50;

const KEPT_HEADERS = [
  "auth-signature-base64",
  "content-type",
  "content-length",
  "content-encoding",
  "user-agent",
] as const;
const HEADER_NAME_RE = /^[a-z0-9_-]{1,64}$/;

export interface ClaimMdCapture {
  readonly format: typeof CLAIMMD_CAPTURE_FORMAT;
  /** ISO 8601, when the capture listener took the request; absent in a hand-built capture. */
  readonly receivedAt?: string;
  readonly method: string;
  /** The request path, query string removed. */
  readonly path: string;
  /** The allowlisted headers, lower-cased names. */
  readonly headers: Readonly<Record<string, string>>;
  /** The names (never values) of every other header, so an unknown vendor header is visible. */
  readonly otherHeaderNames: readonly string[];
  /** The exact request body. */
  readonly bodyBase64: string;
}

type RawHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

/** Build a capture from a request as Node exposes it (headers lower-cased; a repeated header arrives joined or as an array). */
export function buildClaimMdCapture(input: {
  readonly method: string;
  readonly url: string;
  readonly headers: RawHeaders;
  readonly rawBody: Uint8Array;
  readonly receivedAt?: Date;
}): ClaimMdCapture {
  const kept: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = input.headers[name];
    if (value === undefined) continue;
    kept[name] = typeof value === "string" ? value : value.join(", ");
  }
  const otherHeaderNames = Object.keys(input.headers)
    .map((name) => name.toLowerCase())
    .filter(
      (name) => HEADER_NAME_RE.test(name) && !(KEPT_HEADERS as readonly string[]).includes(name),
    )
    .sort()
    .slice(0, MAX_OTHER_HEADER_NAMES);
  return {
    format: CLAIMMD_CAPTURE_FORMAT,
    ...(input.receivedAt ? { receivedAt: input.receivedAt.toISOString() } : {}),
    method: input.method.toUpperCase(),
    path: input.url.split("?", 1)[0] ?? "",
    headers: kept,
    otherHeaderNames,
    bodyBase64: Buffer.from(input.rawBody).toString("base64"),
  };
}

export type ParsedClaimMdCapture =
  | { readonly ok: true; readonly capture: ClaimMdCapture; readonly rawBody: Buffer }
  | { readonly ok: false; readonly reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Read a capture file's JSON. A refusal names what is wrong, never a value. */
export function parseClaimMdCapture(json: unknown): ParsedClaimMdCapture {
  if (!isRecord(json)) return { ok: false, reason: "capture is not a JSON object" };
  if (json.format !== CLAIMMD_CAPTURE_FORMAT)
    return { ok: false, reason: `capture format is not ${CLAIMMD_CAPTURE_FORMAT}` };
  if (typeof json.method !== "string" || typeof json.path !== "string")
    return { ok: false, reason: "capture has no method or path" };
  const { headers, bodyBase64 } = json;
  if (!isRecord(headers) || Object.values(headers).some((v) => typeof v !== "string"))
    return { ok: false, reason: "capture headers must be an object of strings" };
  if (typeof bodyBase64 !== "string" || bodyBase64.length % 4 !== 0 || !BASE64_RE.test(bodyBase64))
    return { ok: false, reason: "capture bodyBase64 is not canonical base64" };
  const rawBody = Buffer.from(bodyBase64, "base64");
  if (rawBody.length > CLAIMMD_CAPTURE_MAX_BODY_BYTES)
    return { ok: false, reason: "capture body is larger than the receiver's 1 MiB limit" };
  const names = json.otherHeaderNames;
  const otherHeaderNames =
    Array.isArray(names) && names.every((n) => typeof n === "string" && HEADER_NAME_RE.test(n))
      ? (names as string[])
      : [];
  return {
    ok: true,
    rawBody,
    capture: {
      format: CLAIMMD_CAPTURE_FORMAT,
      ...(typeof json.receivedAt === "string" ? { receivedAt: json.receivedAt } : {}),
      method: json.method,
      path: json.path,
      // header names are case-insensitive on the wire; the receiver reads them lower-cased, so a hand-built capture is read the same
      headers: Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value as string]),
      ),
      otherHeaderNames,
      bodyBase64,
    },
  };
}
