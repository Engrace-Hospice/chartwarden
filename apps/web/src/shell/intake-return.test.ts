import { describe, expect, it } from "vitest";
import { intakeWorkspaceReturnTo, safeIntakeReturnTo, withIntakeReturnTo } from "./intake-return";

const REFERRAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("intake document return paths", () => {
  it("round-trips a PHI-free referral workspace target", () => {
    const target = intakeWorkspaceReturnTo(REFERRAL, "receive");
    expect(target).toBe(`/referrals/${REFERRAL}/intake?step=receive`);
    expect(safeIntakeReturnTo(target)).toBe(target);
    expect(withIntakeReturnTo("/intake/batch/review", target)).toBe(
      `/intake/batch/review?returnTo=${encodeURIComponent(target)}`,
    );
  });

  it.each([
    "https://attacker.example/referrals/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/intake?step=receive",
    "//attacker.example/path",
    "/referrals/not-a-uuid/intake?step=receive",
    `/referrals/${REFERRAL}/intake?step=match`,
    `/referrals/${REFERRAL}/intake?step=receive&next=//attacker.example`,
    `\\referrals\\${REFERRAL}\\intake?step=receive`,
  ])("rejects an untrusted return target: %s", (target) => {
    expect(safeIntakeReturnTo(target)).toBeNull();
  });
});
