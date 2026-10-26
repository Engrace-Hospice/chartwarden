import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_NUMBER_PATTERN,
  COMMERCIAL_PATHS,
  asClaimState,
  asPayerKind,
  authorizationPosture,
  authorizationStatusLabel,
  authorizationStatusTone,
  authorizationWindowNote,
  claimStateTone,
  enrollmentStatusFor,
  filingIndicatorLabel,
  localToday,
  payerKindLabel,
  payerStatusLabel,
  payerStatusTone,
  resultLabel,
  resultTone,
} from "./commercial-model";

const PAYER = "55555555-5555-4555-8555-555555555555";

describe("payer-kind filter", () => {
  it("accepts only the kinds the API knows and treats the empty choice as no filter", () => {
    expect(asPayerKind("medicare_secondary")).toBe("medicare_secondary");
    expect(asPayerKind("")).toBeUndefined();
    expect(asPayerKind("cash")).toBeUndefined();
    expect(asClaimState("draft")).toBe("draft");
    expect(asClaimState("paid")).toBeUndefined();
  });

  it("names the secondary program, or says commercial only", () => {
    expect(payerKindLabel(null)).toBe("Commercial only");
    expect(payerKindLabel("medicare")).toBe("Commercial + Medicare secondary");
    expect(payerKindLabel("medicaid")).toBe("Commercial + Medicaid secondary");
  });
});

describe("claim state tone", () => {
  it("is neutral for a void claim and success for a ready one", () => {
    expect(claimStateTone("void")).toBe("neutral");
    expect(claimStateTone("ready")).toBe("success");
    expect(claimStateTone("draft")).toBe("neutral");
  });
});

describe("authorizationPosture", () => {
  const approved = {
    status: "approved",
    levelOfCare: null,
    effectiveFrom: "2026-03-01",
    effectiveTo: null,
  };
  it("counts an approved authorization as evidence whatever the requirement", () => {
    expect(authorizationPosture("required_at_admission", [approved])).toEqual({
      label: "1 approved on file",
      tone: "success",
    });
  });
  const window = { from: "2026-03-01", to: "2026-03-31", levelsOfCare: ["routine_home_care"] };
  it("is green only when approved authorizations cover every billed day", () => {
    expect(authorizationPosture("required_at_admission", [approved], window).label).toBe(
      "Covers every billed day",
    );
    const early = { ...approved, effectiveTo: "2026-03-15" };
    expect(authorizationPosture("required_at_admission", [early], window)).toEqual({
      label: "Approved, but not every billed day is covered",
      tone: "warning",
    });
    const lateRest = { ...approved, effectiveFrom: "2026-03-16", effectiveTo: "2026-03-31" };
    expect(authorizationPosture("required_at_admission", [early, lateRest], window).tone).toBe(
      "success",
    );
  });
  it("needs every billed level of care covered under a per-level plan", () => {
    const rhc = { ...approved, levelOfCare: "routine_home_care" };
    const both = { ...window, levelsOfCare: ["routine_home_care", "general_inpatient"] };
    expect(authorizationPosture("required_per_level_of_care", [rhc], both).tone).toBe("warning");
    expect(authorizationPosture("required_per_level_of_care", [rhc], window).tone).toBe("success");
  });
  it("flags a requirement with nothing approved, and a denied one does not count", () => {
    const denied = { ...approved, status: "denied" };
    expect(authorizationPosture("required_at_admission", [denied]).tone).toBe("error");
    expect(authorizationPosture("required_per_level_of_care", []).tone).toBe("error");
  });
  it("treats confirm_with_payer as unknown (a warning), and not_required as neutral", () => {
    expect(authorizationPosture("confirm_with_payer", []).tone).toBe("warning");
    expect(authorizationPosture("not_required", []).tone).toBe("neutral");
  });
});

describe("enrollmentStatusFor", () => {
  const row = (status: string, from: string, to: string | null) => ({
    payerId: PAYER,
    status,
    effectiveFrom: from,
    effectiveTo: to,
  });
  it("is not_enrolled when no row is in effect today", () => {
    expect(enrollmentStatusFor(PAYER, [], "2026-10-25")).toMatchObject({
      status: "not_enrolled",
      tone: "error",
    });
    expect(
      enrollmentStatusFor(PAYER, [row("enrolled", "2026-01-01", "2026-06-30")], "2026-10-25")
        .status,
    ).toBe("not_enrolled");
    expect(
      enrollmentStatusFor(PAYER, [row("enrolled", "2027-01-01", null)], "2026-10-25").status,
    ).toBe("not_enrolled");
  });
  it("uses the latest row in effect and ignores other payers", () => {
    const rows = [
      row("pending", "2026-01-01", null),
      row("enrolled", "2026-09-01", null),
      { ...row("suspended", "2026-10-01", null), payerId: "other" },
    ];
    expect(enrollmentStatusFor(PAYER, rows, "2026-10-25")).toMatchObject({
      status: "enrolled",
      tone: "success",
    });
  });
});

describe("labels", () => {
  it("expands a filing indicator and keeps an unknown code readable", () => {
    expect(filingIndicatorLabel("CI")).toBe("CI · Commercial insurance");
    expect(filingIndicatorLabel("QQ")).toBe("QQ");
  });
  it("treats a missing payer as a warning, not as active", () => {
    expect(payerStatusTone("active")).toBe("success");
    expect(payerStatusTone(null)).toBe("warning");
    expect(payerStatusTone("merged")).toBe("error");
    expect(payerStatusLabel(null)).toBe("Payer not found");
  });
});

describe("validation result presentation", () => {
  const base = {
    id: "r1",
    ruleKey: "authorization_on_file",
    severity: "warn",
    outcome: "fail",
    overridable: true,
    overridden: false,
    blocking: true,
    message: "m",
  };
  it("separates a soft block, a hard block, an override and a pass", () => {
    expect(resultLabel(base)).toBe("Soft block");
    expect(resultLabel({ ...base, severity: "error", overridable: false })).toBe("Hard block");
    expect(resultLabel({ ...base, overridden: true, blocking: false })).toBe("Overridden");
    expect(resultLabel({ ...base, outcome: "pass", blocking: false })).toBe("Pass");
    expect(resultTone(base)).toBe("error");
    expect(resultTone({ ...base, outcome: "pass", blocking: false })).toBe("success");
  });
});

describe("authorization screen helpers", () => {
  const auth = (over: Record<string, string | null> = {}) => ({
    status: "approved",
    effectiveFrom: "2026-03-01",
    effectiveTo: "2026-03-31" as string | null,
    ...over,
  });

  it("has a route path", () => {
    expect(COMMERCIAL_PATHS.authorizations).toBe("/commercial/billing/authorizations");
  });

  it("notes an ended period on an approved authorization without changing its status", () => {
    expect(authorizationWindowNote(auth(), "2026-04-01")).toBe("Period ended");
    expect(authorizationWindowNote(auth(), "2026-03-31")).toBeNull();
    expect(authorizationWindowNote(auth({ status: "denied" }), "2026-04-01")).toBeNull();
  });

  it("notes a future start and an open end", () => {
    expect(authorizationWindowNote(auth(), "2026-02-01")).toBe("Starts 2026-03-01");
    expect(authorizationWindowNote(auth({ effectiveTo: null }), "2026-05-01")).toBe("Open-ended");
    expect(authorizationWindowNote(auth({ effectiveTo: null }), "2026-02-01")).toBe(
      "Starts 2026-03-01",
    );
  });

  it("reads today from the local calendar, not UTC", () => {
    // 23:30 on 24 Oct local time is already 25 Oct in UTC for a zone behind UTC; the local date must win.
    expect(localToday(new Date(2026, 9, 24, 23, 30))).toBe("2026-10-24");
    expect(localToday(new Date(2026, 0, 5, 0, 5))).toBe("2026-01-05");
  });

  it("maps the stored status to a label and tone", () => {
    expect(authorizationStatusLabel("approved")).toBe("Approved");
    expect(authorizationStatusTone("approved")).toBe("success");
    expect(authorizationStatusTone("denied")).toBe("error");
    expect(authorizationStatusTone("voided")).toBe("neutral");
  });

  it("validates the number with exactly the server's pattern", () => {
    const backend = readFileSync(
      new URL(
        "../../../../backend/src/modules/41-billing-commercial/routes/commercial-typebox.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const server = /authorizationNumber: Type\.String\(\{ pattern: "([^"]+)" \}\)/.exec(backend);
    expect(server?.[1]).toBe(AUTHORIZATION_NUMBER_PATTERN.source);
    expect(AUTHORIZATION_NUMBER_PATTERN.test("AB-12.3_x")).toBe(true);
    expect(AUTHORIZATION_NUMBER_PATTERN.test("has space")).toBe(false);
    expect(AUTHORIZATION_NUMBER_PATTERN.test("x".repeat(51))).toBe(false);
    expect(AUTHORIZATION_NUMBER_PATTERN.test("")).toBe(false);
  });
});
