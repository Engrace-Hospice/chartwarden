// Shared helpers for the auditor enrolment tests: a tiny RFC 6238 TOTP generator (so a test authenticator can
// answer the code the server expects without importing the server's own verifier) and a driver for the
// enrolment routes. Used by the redemption live suite (to reach an ACTIVE session) and the enrolment live suite.
import { createHmac } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PERIOD_SEC = 30;
const CSRF = "test-csrf-token-value";

function base32Decode(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/=+$/, "").toUpperCase()) {
    const idx = BASE32.indexOf(char);
    if (idx < 0) throw new Error(`bad base32 character ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The 6-digit TOTP code for `base32Secret` at `atMs` (HMAC-SHA1, 30 s step, RFC 6238). */
export function totpCode(base32Secret: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / PERIOD_SEC);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Decode(base32Secret)).update(buf).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const bin =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  return String(bin % 1_000_000).padStart(6, "0");
}

export interface EnrolmentHttp {
  readonly state: () => Promise<LightMyRequestResponse>;
  readonly acceptTerms: (
    terms: { version: string; sha256: string },
    name?: string,
  ) => Promise<LightMyRequestResponse>;
  readonly beginTotp: () => Promise<LightMyRequestResponse>;
  readonly confirmTotp: (code: string) => Promise<LightMyRequestResponse>;
  readonly verify: (
    body: { totpCode: string } | { recoveryCode: string },
  ) => Promise<LightMyRequestResponse>;
}

/** Drive the enrolment routes with one session cookie. */
export function enrolmentHttp(server: FastifyInstance, cookie: string): EnrolmentHttp {
  const call = (method: "GET" | "POST", path: string, payload?: unknown) =>
    server.inject({
      method,
      url: `/api/v1/auditors/enrolment${path}`,
      // The session cookie rides with the double-submit CSRF pair the browser client sends.
      headers: { cookie: `${cookie}; wardenx_csrf=${CSRF}`, "x-csrf-token": CSRF },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  return {
    state: () => call("GET", "/state"),
    acceptTerms: (terms, name = "Ada Auditor") =>
      call("POST", "/baa", {
        termsVersion: terms.version,
        termsSha256: terms.sha256,
        acceptedName: name,
      }),
    beginTotp: () => call("POST", "/totp/begin", {}),
    confirmTotp: (code) => call("POST", "/totp/confirm", { code }),
    verify: (body) => call("POST", "/verify", body),
  };
}

/**
 * Take a freshly redeemed enrolment session to ACTIVE by the first-engagement path: accept the terms, begin
 * and confirm TOTP. Returns the authenticator secret and the one-time recovery codes.
 */
export async function enrolFirstTime(
  server: FastifyInstance,
  cookie: string,
): Promise<{ manualEntryKey: string; recoveryCodes: string[] }> {
  const http = enrolmentHttp(server, cookie);
  const state = (await http.state()).json();
  const baa = await http.acceptTerms({ version: state.terms.version, sha256: state.terms.sha256 });
  if (baa.statusCode !== 200) throw new Error(`baa failed: ${baa.body}`);
  const begun = await http.beginTotp();
  if (begun.statusCode !== 200) throw new Error(`begin failed: ${begun.body}`);
  const manualEntryKey = begun.json().manualEntryKey as string;
  const confirmed = await http.confirmTotp(totpCode(manualEntryKey));
  if (confirmed.statusCode !== 200) throw new Error(`confirm failed: ${confirmed.body}`);
  return { manualEntryKey, recoveryCodes: confirmed.json().recoveryCodes as string[] };
}
