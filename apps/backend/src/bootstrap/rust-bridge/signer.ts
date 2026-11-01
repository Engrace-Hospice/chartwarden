// apps/backend/src/bootstrap/rust-bridge/signer.ts — CW-RUST-M02 P1: the signed actor assertion Bun sends to Rust.
//
// Compact JWS, EdDSA (Ed25519), header {alg, kid, typ}. The claim set is exactly what the Rust verifier
// (`chartwarden-rust/rust/crates/cw-actor`) accepts; it rejects unknown claims, so nothing may be added here
// without changing both sides. The assertion is minted only AFTER upstream's authenticate hook has run, from the
// verified request context, and lives ≤ 30 s. `jti` is 16 CSPRNG bytes; Rust refuses a second use.
import { type KeyObject, randomBytes, sign } from "node:crypto";

export const ASSERTION_HEADER = "x-cw-actor-assertion";
export const ASSERTION_LIFETIME_SECS = 30;
export const SWEEP_CLASS = "parity-sweep";

export interface AssertionSubject {
  readonly userId: string;
  readonly organizationId: string;
  readonly sessionId: string;
  readonly sessionClass: string;
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
}

export interface AssertionSigner {
  sign(subject: AssertionSubject): string;
}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

/** Canonical lowercase hyphenated UUID: the only identity form the Rust verifier accepts. */
export const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createAssertionSigner(
  signingKey: { readonly kid: string; readonly key: KeyObject },
  opts: { readonly nowSecs?: () => number; readonly random?: (n: number) => Buffer } = {},
): AssertionSigner {
  const nowSecs = opts.nowSecs ?? (() => Math.floor(Date.now() / 1000));
  const random = opts.random ?? randomBytes;
  const header = b64u(JSON.stringify({ alg: "EdDSA", kid: signingKey.kid, typ: "JWT" }));
  return {
    sign(s) {
      if (!CANONICAL_UUID_RE.test(s.userId) || !CANONICAL_UUID_RE.test(s.organizationId)) {
        // Callers check first (a machine principal such as "system" is served by Bun, never forwarded).
        throw new Error("assertion subject must carry canonical UUIDs");
      }
      if (!s.sessionId || !s.sessionClass || !s.requestId)
        throw new Error("assertion subject is incomplete");
      const iat = nowSecs();
      const payload = b64u(
        JSON.stringify({
          iss: "cw-bun",
          aud: "cw-rust",
          sub: s.userId,
          org: s.organizationId,
          sid: s.sessionId,
          cls: s.sessionClass,
          mth: s.method,
          pth: s.path,
          rid: s.requestId,
          jti: b64u(random(16)),
          iat,
          exp: iat + ASSERTION_LIFETIME_SECS,
        }),
      );
      const input = `${header}.${payload}`;
      return `${input}.${b64u(sign(null, Buffer.from(input), signingKey.key))}`;
    },
  };
}
