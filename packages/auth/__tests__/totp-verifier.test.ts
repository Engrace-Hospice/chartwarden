import { randomBytes } from "node:crypto";
// packages/auth/__tests__/totp-verifier.test.ts — M2 §4.4 TOTP step-up verifier.
//
// THE GAP THIS CLOSES. Step-up qualifies on WebAuthn or TOTP (SMS never, D9). The WebAuthn half has had
// a real verifier since `webauthn-verifier.ts` landed; the TOTP half had only `createCodeVerifier`, a
// slice adapter that accepts one hard-coded string. So there was no production TOTP verification
// anywhere in the platform — which did not show, because the step-up ROUTE was never mounted either and
// nothing ever asked.
//
// WHAT MAKES THESE TESTS REAL. The secret is written through TWO encryption layers — Better Auth's own
// `symmetricEncrypt` envelope, then the repo's ADR-0034 at-rest seal over that — and the fixtures below
// build the stored value the same way the write path does, with the same primitives, rather than
// hand-rolling a shape that happens to decrypt. A test that constructed the ciphertext with the
// verifier's own logic would prove only that the function is self-consistent.
//
// The generated code comes from `createOTP(...).totp()` — the vendor's own generator, which is what a
// real authenticator app implements. So the pass case exercises the actual algorithm, not a stub.
import { createOTP } from "@better-auth/utils/otp";
import { symmetricEncrypt } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createTotpStepUpVerifier } from "../src/identity/totp-verifier";
import type { TotpEnrolmentStore } from "../src/identity/totp-verifier";
import { seal } from "../src/identity/two-factor-crypto";

const USER = "user_1";
const SECRET = "JBSWY3DPEHPK3PXP"; // a base32 TOTP secret, the shape enrolment produces
const BETTER_AUTH_SECRET = "better-auth-instance-secret";
const KEK = randomBytes(32);

/** The value that actually lands in `two_factor.secret_encrypted`: seal(symmetricEncrypt(secret)). */
let storedValue: string;
/** The Better-Auth-encrypted value WITHOUT the repo's outer seal (a pre-ADR-0034 row). */
let unsealedValue: string;

beforeAll(async () => {
  unsealedValue = await symmetricEncrypt({ key: BETTER_AUTH_SECRET, data: SECRET });
  storedValue = seal(unsealedValue, KEK);
});

const storeOf = (secretEncrypted: string | null): TotpEnrolmentStore => ({
  findEnrolment: () => (secretEncrypted === null ? null : { secretEncrypted }),
});

const verifierOver = (secretEncrypted: string | null) =>
  createTotpStepUpVerifier(storeOf(secretEncrypted), {
    betterAuthSecret: BETTER_AUTH_SECRET,
    encryptionKey: KEK,
  });

/** The code a real authenticator app would show right now. */
const currentCode = () => createOTP(SECRET, { digits: 6, period: 30 }).totp();

describe("createTotpStepUpVerifier (M2 §4.4)", () => {
  it("accepts the current code, unwrapping BOTH encryption layers", async () => {
    const verifier = verifierOver(storedValue);
    expect(await verifier.verify({ userId: USER, totpCode: await currentCode() })).toEqual({
      ok: true,
    });
  });

  it("accepts a row written before the ADR-0034 seal existed", async () => {
    // `isSealed` decides per row rather than assuming, so a deployment that enabled the encrypting
    // adapter after some enrolments still verifies the older ones instead of reading them as corrupt.
    const verifier = verifierOver(unsealedValue);
    expect(await verifier.verify({ userId: USER, totpCode: await currentCode() })).toEqual({
      ok: true,
    });
  });

  it("refuses a wrong code", async () => {
    const verifier = verifierOver(storedValue);
    const wrong = String((Number(await currentCode()) + 1) % 1_000_000).padStart(6, "0");
    expect(await verifier.verify({ userId: USER, totpCode: wrong })).toEqual({
      ok: false,
      reason: "totp_code_invalid",
    });
  });

  it("refuses a malformed code without touching the store", async () => {
    let reads = 0;
    const verifier = createTotpStepUpVerifier(
      {
        findEnrolment: () => {
          reads++;
          return { secretEncrypted: storedValue };
        },
      },
      { betterAuthSecret: BETTER_AUTH_SECRET, encryptionKey: KEK },
    );
    for (const code of ["", "12345", "1234567", "abcdef", "12 34 56"]) {
      expect(await verifier.verify({ userId: USER, totpCode: code })).toEqual({
        ok: false,
        reason: "totp_code_malformed",
      });
    }
    expect(reads).toBe(0); // shape first, decrypt second — no point unwrapping for a non-code
  });

  it("refuses when the user has no TOTP enrolment", async () => {
    expect(
      await verifierOver(null).verify({ userId: USER, totpCode: await currentCode() }),
    ).toEqual({ ok: false, reason: "totp_not_enrolled" });
  });

  it("refuses — never throws — when the secret cannot be decrypted", async () => {
    // The branch that fires if the vendor changes its at-rest format, or a key is rotated without
    // re-wrapping. A throw here would surface as a 500; the route's contract needs a false so the
    // failure lands on the lockout counter instead of the error handler.
    const wrongKek = createTotpStepUpVerifier(storeOf(storedValue), {
      betterAuthSecret: BETTER_AUTH_SECRET,
      encryptionKey: randomBytes(32),
    });
    expect(await wrongKek.verify({ userId: USER, totpCode: await currentCode() })).toEqual({
      ok: false,
      reason: "totp_secret_unreadable",
    });

    const wrongAuthSecret = createTotpStepUpVerifier(storeOf(storedValue), {
      betterAuthSecret: "not-the-instance-secret",
      encryptionKey: KEK,
    });
    expect(await wrongAuthSecret.verify({ userId: USER, totpCode: await currentCode() })).toEqual({
      ok: false,
      reason: "totp_secret_unreadable",
    });

    const garbage = verifierOver("not-encrypted-anything");
    expect(await garbage.verify({ userId: USER, totpCode: await currentCode() })).toEqual({
      ok: false,
      reason: "totp_secret_unreadable",
    });
  });

  it("refuses when no Better Auth secret is configured, rather than skipping that layer", async () => {
    const unconfigured = createTotpStepUpVerifier(storeOf(storedValue), {
      betterAuthSecret: "",
      encryptionKey: KEK,
    });
    expect(await unconfigured.verify({ userId: USER, totpCode: await currentCode() })).toEqual({
      ok: false,
      reason: "totp_secret_unreadable",
    });
  });

  it("verifies one user's code against ONE user's secret — the store is the only lookup", async () => {
    // The verifier holds no user state: it asks the store for THIS user's enrolment and verifies
    // against that alone. A second user's code cannot pass because a different secret produces a
    // different code, and the store never returns anyone else's row.
    const otherSecret = "MFRGGZDFMZTWQ2LK";
    const otherStored = seal(
      await symmetricEncrypt({ key: BETTER_AUTH_SECRET, data: otherSecret }),
      KEK,
    );
    const verifier = verifierOver(otherStored);
    expect(await verifier.verify({ userId: USER, totpCode: await currentCode() })).toEqual({
      ok: false,
      reason: "totp_code_invalid",
    });
    const otherCode = await createOTP(otherSecret, { digits: 6, period: 30 }).totp();
    expect(await verifier.verify({ userId: USER, totpCode: otherCode })).toEqual({ ok: true });
  });
});
