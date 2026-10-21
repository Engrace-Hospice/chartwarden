// packages/auth/__tests__/auditor-second-factor.test.ts - the primitives behind an external auditor's second factor
// (M2 §7.7): the TOTP secret an auditor enrols is the SAME double-encrypted `two_factor` value the staff step-up
// verifier reads, a TOTP code is matched to a STEP (so the caller can refuse a replay), and recovery codes are
// high-entropy, shown once and compared only through a keyed one-way hash.
import { randomBytes } from "node:crypto";
import { createOTP } from "@better-auth/utils/otp";
import { symmetricDecrypt } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  RECOVERY_CODE_COUNT,
  TOTP_PERIOD_SEC,
  createTotpEnrolment,
  generateRecoveryCodes,
  hashRecoveryCode,
  matchTotpStep,
  normalizeRecoveryCode,
  recoveryCodeMatches,
  totpStepStart,
} from "../src/identity/auditor-second-factor";
import { AUDITOR_STAGE_ACTIVE, sessionAuditorStage } from "../src/identity/session-classes";
import { createTotpStepUpVerifier } from "../src/identity/totp-verifier";
import { open } from "../src/identity/two-factor-crypto";

const OPTIONS = { betterAuthSecret: "better-auth-instance-secret", encryptionKey: randomBytes(32) };
const NOW = Date.UTC(2026, 9, 7, 12, 0, 10);
const STEP = Math.floor(NOW / 1000 / TOTP_PERIOD_SEC);

let stored: string;
let rawSecret: string;
let manualKey: string;
let uri: string;

beforeAll(async () => {
  const enrolment = await createTotpEnrolment("ada@survey.test", OPTIONS);
  stored = enrolment.storedSecret;
  manualKey = enrolment.manualEntryKey;
  uri = enrolment.otpauthUri;
  rawSecret = await symmetricDecrypt({
    key: OPTIONS.betterAuthSecret,
    data: open(stored, OPTIONS.encryptionKey),
  });
});

const codeAt = (step: number) =>
  createOTP(rawSecret, { digits: 6, period: TOTP_PERIOD_SEC }).hotp(step);

describe("createTotpEnrolment", () => {
  it("stores the secret sealed + vendor-encrypted and never as the raw authenticator key", () => {
    expect(stored).not.toContain(rawSecret);
    expect(stored).not.toContain(manualKey);
    expect(manualKey).toMatch(/^[A-Z2-7]+$/);
  });

  it("emits an otpauth URI an authenticator app understands", () => {
    const parsed = new URL(uri);
    expect(parsed.protocol).toBe("otpauth:");
    expect(decodeURIComponent(parsed.pathname)).toContain("ada@survey.test");
    expect(parsed.searchParams.get("secret")).toBe(manualKey);
    expect(parsed.searchParams.get("issuer")).toBe("ChartWarden");
  });

  it("is a different secret every time", async () => {
    const other = await createTotpEnrolment("ada@survey.test", OPTIONS);
    expect(other.manualEntryKey).not.toBe(manualKey);
  });

  it("is readable by the staff step-up verifier (one factor stack, not a parallel scheme)", async () => {
    const verifier = createTotpStepUpVerifier(
      { findEnrolment: () => ({ secretEncrypted: stored }) },
      OPTIONS,
    );
    const code = await createOTP(rawSecret, { digits: 6, period: TOTP_PERIOD_SEC }).totp();
    await expect(verifier.verify({ userId: "u", totpCode: code })).resolves.toEqual({ ok: true });
  });
});

describe("matchTotpStep", () => {
  it("reports the step that matched, accepting one step of skew either way", async () => {
    expect(await matchTotpStep(stored, await codeAt(STEP), NOW, OPTIONS)).toEqual({
      ok: true,
      step: STEP,
    });
    expect(await matchTotpStep(stored, await codeAt(STEP - 1), NOW, OPTIONS)).toEqual({
      ok: true,
      step: STEP - 1,
    });
    expect(await matchTotpStep(stored, await codeAt(STEP + 1), NOW, OPTIONS)).toEqual({
      ok: true,
      step: STEP + 1,
    });
  });

  it("refuses a code two steps away, a wrong code and a malformed one", async () => {
    expect(await matchTotpStep(stored, await codeAt(STEP + 2), NOW, OPTIONS)).toMatchObject({
      ok: false,
      reason: "totp_code_invalid",
    });
    expect(await matchTotpStep(stored, await codeAt(STEP - 2), NOW, OPTIONS)).toMatchObject({
      ok: false,
    });
    expect(await matchTotpStep(stored, "12345", NOW, OPTIONS)).toEqual({
      ok: false,
      reason: "totp_code_malformed",
    });
    expect(await matchTotpStep(stored, "abcdef", NOW, OPTIONS)).toMatchObject({ ok: false });
  });

  it("fails CLOSED when the secret cannot be decrypted", async () => {
    expect(
      await matchTotpStep(stored, await codeAt(STEP), NOW, {
        ...OPTIONS,
        betterAuthSecret: "a-different-instance-secret",
      }),
    ).toEqual({ ok: false, reason: "totp_secret_unreadable" });
    expect(await matchTotpStep("garbage", await codeAt(STEP), NOW, OPTIONS)).toMatchObject({
      ok: false,
    });
  });

  it("maps a step to the wall-clock instant it starts (the replay guard's value)", () => {
    expect(totpStepStart(STEP).getTime()).toBe(STEP * TOTP_PERIOD_SEC * 1000);
    expect(totpStepStart(STEP).getTime()).toBeLessThanOrEqual(NOW);
  });
});

describe("recovery codes", () => {
  it("generates ten distinct, formatted, unambiguous codes", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of codes) expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){3}$/);
  });

  it("normalises what a person types (case, spaces, dashes)", () => {
    expect(normalizeRecoveryCode(" abcde-fghjk lmnpq-rstuv ")).toBe("ABCDEFGHJKLMNPQRSTUV");
  });

  it("hashes to a keyed digest that matches the typed code however it is typed", () => {
    const [code] = generateRecoveryCodes(1) as [string];
    const hash = hashRecoveryCode(code, OPTIONS);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(normalizeRecoveryCode(code));
    expect(recoveryCodeMatches(code, hash, OPTIONS)).toBe(true);
    expect(recoveryCodeMatches(code.replace(/-/g, "").toLowerCase(), hash, OPTIONS)).toBe(true);
    expect(recoveryCodeMatches(generateRecoveryCodes(1)[0] as string, hash, OPTIONS)).toBe(false);
  });

  it("is keyed: the same code hashes differently under another instance secret", () => {
    const [code] = generateRecoveryCodes(1) as [string];
    expect(hashRecoveryCode(code, OPTIONS)).not.toBe(
      hashRecoveryCode(code, { ...OPTIONS, betterAuthSecret: "other-instance-secret" }),
    );
  });

  it("rejects a malformed stored hash instead of throwing", () => {
    expect(recoveryCodeMatches("ABCDE-FGHJK-LMNPQ-RSTUV", "short", OPTIONS)).toBe(false);
  });
});

describe("sessionAuditorStage (class-gated, FAIL CLOSED)", () => {
  it("reads active only for an explicit `active` on an auditor session", () => {
    expect(
      sessionAuditorStage({
        sessionClass: "auditor",
        scope: { auditorStage: AUDITOR_STAGE_ACTIVE },
      }),
    ).toBe("active");
  });

  it("reads enrolment for an absent, empty or unknown stage", () => {
    for (const scope of [
      null,
      {},
      { auditorStage: "" },
      { auditorStage: "ACTIVE" },
      { auditorStage: "x" },
    ]) {
      expect(sessionAuditorStage({ sessionClass: "auditor", scope })).toBe("enrolment");
    }
  });

  it("is null on every other class, even with a stray key", () => {
    for (const sessionClass of [
      "staff",
      "external_collaborator",
      "funeral_home",
      "patient_portal",
    ] as const) {
      expect(sessionAuditorStage({ sessionClass, scope: { auditorStage: "active" } })).toBeNull();
    }
  });
});
