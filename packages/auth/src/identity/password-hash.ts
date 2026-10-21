// @chartwarden/auth · identity — Argon2id password hashing (M2 §3.1, AUTH-T04, ADR-0033).
//
// Pure crypto via hash-wasm (WASM — cross-platform, no native binary, frozen-lockfile-safe across CI
// OSes). Wired into Better Auth's `emailAndPassword.password.{hash,verify}` by createIdentityAuth, so
// the system never mints or verifies a password hash anywhere else. NIST 800-63B leaves work-factor to
// the implementation; these are the OWASP Argon2id "second recommended" parameters for server-side use.
import { argon2Verify, argon2id } from "hash-wasm";

const PARAMS = {
  parallelism: 1,
  iterations: 3,
  memorySize: 19_456, // 19 MiB
  hashLength: 32,
} as const;

/** Hash a password to an `$argon2id$...` encoded string (random 16-byte salt per call). */
export async function argon2idHash(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return argon2id({ password, salt, ...PARAMS, outputType: "encoded" });
}

/** Verify a password against an `$argon2id$...` encoded hash. */
export async function argon2idVerify(hash: string, password: string): Promise<boolean> {
  return argon2Verify({ password, hash });
}
