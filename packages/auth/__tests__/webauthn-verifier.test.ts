// packages/auth/__tests__/webauthn-verifier.test.ts — M2 §4.4 WebAuthn step-up verifier.
// The success path is a signed device assertion (build-/e2e-verified, like passkey enrollment); the
// fail-closed paths — unknown credential, malformed/forged assertion, no counter bump on failure — are
// deterministic and locked here.
import { describe, expect, it } from "vitest";
import {
  type PasskeyCredentialStore,
  type StoredPasskey,
  createWebauthnAssertionVerifier,
} from "../src/identity/webauthn-verifier";

function storeWith(cred: StoredPasskey | null): {
  store: PasskeyCredentialStore;
  counterUpdates: Array<{ id: string; counter: number }>;
} {
  const counterUpdates: Array<{ id: string; counter: number }> = [];
  return {
    counterUpdates,
    store: {
      findCredential: (_userId, credentialId) => (cred && cred.credentialId === credentialId ? cred : null),
      updateCounter: (id, counter) => {
        counterUpdates.push({ id, counter });
      },
    },
  };
}

const ORIGIN = "https://app.wardenx.test";
const RPID = "wardenx.test";

describe("createWebauthnAssertionVerifier (M2 §4.4)", () => {
  it("rejects an assertion with no credential id (malformed)", async () => {
    const { store, counterUpdates } = storeWith(null);
    const verifier = createWebauthnAssertionVerifier(store);
    const out = await verifier.verify({
      userId: "u1",
      expectedChallenge: "chal",
      assertion: { type: "public-key" }, // no `id`
      expectedOrigin: ORIGIN,
      expectedRPID: RPID,
    });
    expect(out).toEqual({ ok: false, reason: "malformed_assertion" });
    expect(counterUpdates).toHaveLength(0);
  });

  it("rejects when the user has no such enrolled credential", async () => {
    const { store } = storeWith({ credentialId: "other", publicKey: "AAAA", counter: 0 });
    const verifier = createWebauthnAssertionVerifier(store);
    const out = await verifier.verify({
      userId: "u1",
      expectedChallenge: "chal",
      assertion: { id: "cred-1", type: "public-key" },
      expectedOrigin: ORIGIN,
      expectedRPID: RPID,
    });
    expect(out).toEqual({ ok: false, reason: "credential_not_found" });
  });

  it("fails closed on a forged/garbage assertion and does NOT advance the counter", async () => {
    const { store, counterUpdates } = storeWith({ credentialId: "cred-1", publicKey: "AAAA", counter: 7 });
    const verifier = createWebauthnAssertionVerifier(store);
    const out = await verifier.verify({
      userId: "u1",
      expectedChallenge: "chal",
      // well-formed envelope, but the inner fields are not a real signed assertion → verify throws
      assertion: {
        id: "cred-1",
        rawId: "cred-1",
        type: "public-key",
        response: { clientDataJSON: "Zm9v", authenticatorData: "Zm9v", signature: "Zm9v" },
        clientExtensionResults: {},
      },
      expectedOrigin: ORIGIN,
      expectedRPID: RPID,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("webauthn_verification_failed");
    expect(counterUpdates).toHaveLength(0); // replay counter only advances on a verified assertion
  });
});
