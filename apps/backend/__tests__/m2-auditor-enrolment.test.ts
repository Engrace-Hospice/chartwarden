// M2 §7.7 auditor enrolment - the pure units (the database behaviour is proven in
// m2-auditor-enrolment.live.test.ts): the versioned terms, the ABAC predicate, the refusal -> envelope map and
// the lockout arithmetic.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { auditorEnrolmentSessionPredicate } from "../src/modules/02-identity/abac-predicates";
import { enrolmentRefusalError } from "../src/modules/02-identity/auditor-enrolment";
import {
  AUDITOR_2FA_LOCK_MS,
  AUDITOR_2FA_MAX_FAILURES,
  isReplayedStep,
  lockRemainingSec,
  unspentRecoveryCodes,
} from "../src/modules/02-identity/auditor-second-factor-store";
import { CURRENT_AUDITOR_TERMS, isCurrentTerms } from "../src/modules/02-identity/auditor-terms";

describe("the versioned BAA / engagement terms", () => {
  it("hashes the exact text shown, so a silent edit can never pass for what was accepted", () => {
    expect(CURRENT_AUDITOR_TERMS.sha256).toBe(
      createHash("sha256").update(CURRENT_AUDITOR_TERMS.text, "utf8").digest("hex"),
    );
    expect(CURRENT_AUDITOR_TERMS.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(CURRENT_AUDITOR_TERMS.version.length).toBeGreaterThan(0);
  });

  it("PINS the hash to the version: editing the text without bumping the version fails this test", () => {
    // If you intentionally change the terms text, bump TERMS_VERSION in auditor-terms.ts AND update both
    // values below; an acceptance row records (version, sha256) as the evidence of what was agreed.
    expect(CURRENT_AUDITOR_TERMS.version).toBe("2026-10-v1");
    expect(CURRENT_AUDITOR_TERMS.sha256).toBe(
      "d48c5267715f3a5c37f8598acca5168a767b7d2f7445a820a2470b00b733f01e",
    );
  });

  it("accepts only the current (version, hash) pair", () => {
    const { version, sha256 } = CURRENT_AUDITOR_TERMS;
    expect(isCurrentTerms({ termsVersion: version, termsSha256: sha256 })).toBe(true);
    expect(isCurrentTerms({ termsVersion: "old", termsSha256: sha256 })).toBe(false);
    expect(isCurrentTerms({ termsVersion: version, termsSha256: "0".repeat(64) })).toBe(false);
  });
});

describe("auditor_enrolment_session predicate", () => {
  const ctx = (attributes: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    organizationId: "org1",
    userId: "u1",
    roles: [],
    providerEntityIds: [],
    locationIds: [],
    attributes,
    ...over,
  });
  const good = { sessionClass: "auditor", auditorEnrolmentEngagementId: "e1" };

  it("allows an auditor session acting on its OWN engagement", async () => {
    await expect(
      auditorEnrolmentSessionPredicate(ctx(good) as never, { engagementId: "e1" }),
    ).resolves.toBe(true);
  });

  it("denies every other class, a foreign engagement, a missing engagement and an anonymous caller", async () => {
    const deny = (c: unknown, target: Record<string, unknown>) =>
      auditorEnrolmentSessionPredicate(c as never, target);
    await expect(
      deny(ctx({ ...good, sessionClass: "staff" }), { engagementId: "e1" }),
    ).resolves.toBe(false);
    await expect(deny(ctx(good), { engagementId: "e2" })).resolves.toBe(false);
    await expect(deny(ctx(good), {})).resolves.toBe(false);
    await expect(deny(ctx({ sessionClass: "auditor" }), { engagementId: undefined })).resolves.toBe(
      false,
    );
    await expect(deny(ctx(good, { userId: "" }), { engagementId: "e1" })).resolves.toBe(false);
    await expect(deny(ctx(good, { organizationId: "" }), { engagementId: "e1" })).resolves.toBe(
      false,
    );
  });
});

describe("enrolmentRefusalError (typed envelope, arch:error-envelope)", () => {
  it.each([
    ["session_invalid", "SESSION_INVALID", 401],
    ["already_active", "AUDITOR_ENROLMENT_COMPLETE", 409],
    ["terms_stale", "AUDITOR_TERMS_STALE", 409],
    ["terms_not_accepted", "AUDITOR_TERMS_REQUIRED", 409],
    ["factor_locked", "AUDITOR_2FA_LOCKED", 429],
    ["factor_invalid", "AUDITOR_2FA_INVALID", 401],
    ["factor_already_enrolled", "AUDITOR_2FA_ALREADY_ENROLLED", 409],
    ["factor_not_started", "AUDITOR_2FA_NOT_STARTED", 409],
    ["factor_not_enrolled", "AUDITOR_2FA_NOT_ENROLLED", 409],
    ["engagement_not_active", "ENGAGEMENT_NOT_ACTIVE", 403],
    ["role_over_privileged", "AUDITOR_ROLE_MISCONFIGURED", 403],
  ] as const)("%s -> %s %i", (reason, expectedCode, status) => {
    const error = enrolmentRefusalError({ reason });
    expect(error.code).toBe(expectedCode);
    expect(error.statusCode).toBe(status);
  });

  it("never echoes which of a code or a recovery code was wrong", () => {
    expect(enrolmentRefusalError({ reason: "factor_invalid" }).message).toBe(
      "that code is not valid",
    );
  });
});

describe("second-factor lockout arithmetic", () => {
  const now = new Date("2026-10-07T12:00:00Z");

  it("locks after five consecutive failures for fifteen minutes", () => {
    expect(AUDITOR_2FA_MAX_FAILURES).toBe(5);
    expect(AUDITOR_2FA_LOCK_MS).toBe(15 * 60 * 1000);
  });

  it("reports the seconds left on a live lock and zero once it has passed", () => {
    expect(lockRemainingSec({ lockedUntil: new Date(now.getTime() + 90_500) }, now)).toBe(91);
    expect(lockRemainingSec({ lockedUntil: new Date(now.getTime() - 1) }, now)).toBe(0);
    expect(lockRemainingSec({ lockedUntil: now }, now)).toBe(0);
    expect(lockRemainingSec({ lockedUntil: null }, now)).toBe(0);
  });

  it("calls a TOTP step a replay unless it is strictly newer than the last accepted one", () => {
    const step = 58_000_000;
    const lastUsedAt = new Date(step * 30_000);
    expect(isReplayedStep({ lastUsedAt }, step)).toBe(true);
    expect(isReplayedStep({ lastUsedAt }, step - 1)).toBe(true);
    expect(isReplayedStep({ lastUsedAt }, step + 1)).toBe(false);
    expect(isReplayedStep({ lastUsedAt: null }, step)).toBe(false);
  });

  it("counts unspent recovery codes", () => {
    expect(
      unspentRecoveryCodes({
        recoveryCodes: [
          { hash: "a", usedAt: null },
          { hash: "b", usedAt: "2026-10-07T12:00:00Z" },
          { hash: "c", usedAt: null },
        ],
      }),
    ).toBe(2);
  });
});
