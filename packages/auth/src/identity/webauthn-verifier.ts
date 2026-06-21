// @wardenx/auth · identity — WebAuthn step-up assertion verifier (M2 §4.4, D9).
//
// Step-up qualifies on WebAuthn or TOTP only (SMS never). This is the REAL WebAuthn half: it verifies a
// browser assertion (navigator.credentials.get → @simplewebauthn/browser) against the user's enrolled
// passkey using @simplewebauthn/server, then bumps the stored signature counter (replay protection).
// Until this landed the step-up MfaVerifier was a slice stub that accepted any assertion; this makes the
// WebAuthn factor cryptographically real.
//
// The success path can only be exercised end-to-end with a real authenticator (the assertion is signed
// by the device), so it is build-/e2e-verified like passkey enrollment; the failure paths
// (no credential, malformed/forged assertion) ARE unit-tested here. Credential I/O goes through an
// injected PasskeyCredentialStore port so the crypto stays testable without a DB; the Drizzle store over
// the M1-owned `passkey` table is below.
import { schema } from "@wardenx/db";
import type { DbClient } from "@wardenx/db";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { and, eq } from "drizzle-orm";

/** A stored passkey credential, as the verifier needs it (base64url public key + signature counter). */
export interface StoredPasskey {
  readonly credentialId: string; // base64url
  readonly publicKey: string; // base64url COSE public key
  readonly counter: number;
  readonly transports?: readonly string[];
}

/** Reads the user's passkey by credential id, and bumps its counter after a verified assertion. */
export interface PasskeyCredentialStore {
  findCredential(
    userId: string,
    credentialId: string,
  ): Promise<StoredPasskey | null> | StoredPasskey | null;
  updateCounter(credentialId: string, newCounter: number): Promise<void> | void;
}

/** The inputs to one step-up WebAuthn verification (the challenge comes from the step-up store). */
export interface WebauthnVerifyInput {
  readonly userId: string;
  readonly expectedChallenge: string; // base64url, issued at /step-up/initiate
  readonly assertion: unknown; // AuthenticationResponseJSON from the browser
  readonly expectedOrigin: string;
  readonly expectedRPID: string;
}

/** Verifies a WebAuthn step-up assertion. `{ ok:false, reason }` on any failure (fail closed). */
export interface WebauthnVerifier {
  verify(input: WebauthnVerifyInput): Promise<{ ok: boolean; reason?: string }>;
}

function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const buf = Buffer.from(value, "base64url");
  // Copy into a Uint8Array backed by a plain ArrayBuffer (not the Node Buffer's pooled/SharedArrayBuffer
  // backing) so the type matches @simplewebauthn's `Uint8Array<ArrayBuffer>`.
  const bytes = new Uint8Array(buf.byteLength);
  bytes.set(buf);
  return bytes;
}

/**
 * Build the WebAuthn assertion verifier over an injected credential store. It resolves the asserted
 * credential for the user, runs the @simplewebauthn verification (signature, challenge, origin, RP id,
 * counter regression), and on success advances the stored counter. Any failure — unknown credential,
 * malformed payload, bad signature/challenge/origin — fails closed.
 */
export function createWebauthnAssertionVerifier(store: PasskeyCredentialStore): WebauthnVerifier {
  return {
    async verify({ userId, expectedChallenge, assertion, expectedOrigin, expectedRPID }) {
      const response = assertion as AuthenticationResponseJSON | null;
      const credentialId = response?.id;
      if (typeof credentialId !== "string" || credentialId.length === 0) {
        return { ok: false, reason: "malformed_assertion" };
      }

      const stored = await store.findCredential(userId, credentialId);
      if (!stored) return { ok: false, reason: "credential_not_found" };

      let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
      try {
        result = await verifyAuthenticationResponse({
          response: response as AuthenticationResponseJSON,
          expectedChallenge,
          expectedOrigin,
          expectedRPID,
          credential: {
            id: stored.credentialId,
            publicKey: base64urlToBytes(stored.publicKey),
            counter: stored.counter,
            transports: stored.transports as AuthenticatorTransportFuture[] | undefined,
          },
        });
      } catch {
        // A forged/malformed assertion makes @simplewebauthn throw — treat as a failed verification.
        return { ok: false, reason: "webauthn_verification_failed" };
      }

      if (!result.verified) return { ok: false, reason: "webauthn_verification_failed" };
      // Replay protection: persist the authenticator's advanced counter.
      await store.updateCounter(stored.credentialId, result.authenticationInfo.newCounter);
      return { ok: true };
    },
  };
}

/** Build the production PasskeyCredentialStore over the M1-owned `passkey` table. */
export function createDbPasskeyCredentialStore(db: DbClient): PasskeyCredentialStore {
  return {
    async findCredential(userId: string, credentialId: string): Promise<StoredPasskey | null> {
      const rows = await db
        .select({
          credentialId: schema.passkey.credentialId,
          publicKey: schema.passkey.publicKey,
          counter: schema.passkey.counter,
          transports: schema.passkey.transports,
        })
        .from(schema.passkey)
        .where(and(eq(schema.passkey.userId, userId), eq(schema.passkey.credentialId, credentialId)))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        credentialId: row.credentialId,
        publicKey: row.publicKey,
        counter: Number(row.counter),
        transports: Array.isArray(row.transports) ? (row.transports as string[]) : undefined,
      };
    },
    async updateCounter(credentialId: string, newCounter: number): Promise<void> {
      await db
        .update(schema.passkey)
        .set({ counter: newCounter })
        .where(eq(schema.passkey.credentialId, credentialId));
    },
  };
}
