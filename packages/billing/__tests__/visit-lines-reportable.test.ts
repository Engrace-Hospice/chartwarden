// @wardenx/billing — rule `visit_lines_reportable` (visits, warn, regulatory): a billable visit that could not be
// built into a claim line (no documented duration, no covering level-of-care period) is skipped, never guessed —
// and surfaced here, naming encounter ids only, so a biller can document it. Never blocks the claim.
import {
  type ValidationContext,
  type VisitReportingSnapshot,
  visitLinesReportable,
} from "@wardenx/billing";
import { describe, expect, it } from "vitest";
import { passingContext } from "./_fixtures";

const run = (visitReporting: VisitReportingSnapshot | undefined) => {
  const ctx: ValidationContext = { ...passingContext(), visitReporting };
  return visitLinesReportable.check(ctx, visitLinesReportable.defaultParameters ?? {});
};

describe("visit_lines_reportable", () => {
  it("is a non-blocking, platform-floor warning", () => {
    expect(visitLinesReportable).toMatchObject({
      key: "visit_lines_reportable",
      version: 1,
      category: "visits",
      severity: "warn",
      regulatoryRequired: true,
      overrideRoleRequired: "billing_manager",
    });
  });

  it("skips (not applicable) when no visit reporting was materialized", () => {
    const r = run(undefined);
    expect(r.passed).toBe(true);
    expect(r.annotations?.skipReason).toBe("not_applicable");
  });

  it("passes when every billable visit became a line", () => {
    const r = run({ unresolved: [], deferredCount: 0 });
    expect(r.passed).toBe(true);
    expect(r.annotations?.skipReason).toBeUndefined();
  });

  it("warns, naming the encounter ids and reasons, when visits could not be reported", () => {
    const r = run({
      unresolved: [
        { encounterId: "enc-1", reason: "duration_missing" },
        { encounterId: "enc-2", reason: "no_level_of_care_period" },
      ],
      deferredCount: 0,
    });
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("warn");
    expect(r.annotations?.observed).toMatchObject({ unreportedVisitCount: 2 });
    expect(r.annotations?.defects).toEqual([
      {
        code: "VISIT_DURATION_MISSING",
        message: expect.stringContaining("no documented start/end time"),
        refs: { encounterId: "enc-1" },
      },
      {
        code: "VISIT_NO_LEVEL_OF_CARE_PERIOD",
        message: expect.stringContaining("level-of-care period"),
        refs: { encounterId: "enc-2" },
      },
    ]);
    expect(r.annotations?.remediation?.fixAction).toBe("document_visit_in_m8");
  });

  it("carries no PHI: ids and codes only in the message and defects", () => {
    const r = run({
      unresolved: [{ encounterId: "enc-1", reason: "duration_missing" }],
      deferredCount: 0,
    });
    expect(JSON.stringify(r)).not.toMatch(/patient|name|mbi/i);
  });
});
