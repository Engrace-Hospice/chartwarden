// apps/backend/__tests__/bereavement-assessment-task.test.ts — ADR-0109 D3: the assessment-task lifecycle rules
// (pure) and the merge of a human recompute's factors into the sticky vector the next score reads.
import { describe, expect, it } from "vitest";
import {
  BereavementStateError,
  assertTaskCompletable,
  isAssessmentTaskOverdue,
  stickyManualFactorsOf,
} from "../src/modules/16-bereavement/lifecycle/index";

const PLAN = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const task = (over: Record<string, unknown> = {}) => ({
  status: "scheduled" as const,
  planId: PLAN,
  bereavedContactId: CONTACT,
  taskKind: "initial_assessment" as const,
  lateGraceUntil: new Date("2026-12-05T00:00:00.000Z"),
  ...over,
});

describe("assertTaskCompletable", () => {
  it("lets a scheduled task be completed for its own contact", () => {
    expect(() => assertTaskCompletable(task(), { planId: PLAN, contactId: CONTACT })).not.toThrow();
  });

  it("lets a missed task still be completed late", () => {
    expect(() =>
      assertTaskCompletable(task({ status: "missed" }), { planId: PLAN, contactId: CONTACT }),
    ).not.toThrow();
  });

  it.each(["completed", "cancelled"] as const)("refuses a %s task (409)", (status) => {
    try {
      assertTaskCompletable(task({ status }), { planId: PLAN, contactId: CONTACT });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BereavementStateError);
      expect((error as BereavementStateError).code).toBe("ASSESSMENT_TASK_NOT_OPEN");
      expect((error as BereavementStateError).statusCode).toBe(409);
    }
  });

  it("refuses a task on another plan (404, not a leak of its existence)", () => {
    try {
      assertTaskCompletable(task(), { planId: "99999999-9999-4999-8999-999999999999" });
      expect.unreachable();
    } catch (error) {
      expect((error as BereavementStateError).code).toBe("ASSESSMENT_TASK_NOT_FOUND");
      expect((error as BereavementStateError).statusCode).toBe(404);
    }
  });

  it("refuses a score for a different contact than the task belongs to (422)", () => {
    try {
      assertTaskCompletable(task(), {
        planId: PLAN,
        contactId: "33333333-3333-4333-8333-333333333333",
      });
      expect.unreachable();
    } catch (error) {
      expect((error as BereavementStateError).code).toBe("ASSESSMENT_TASK_CONTACT_MISMATCH");
      expect((error as BereavementStateError).statusCode).toBe(422);
    }
  });
});

describe("isAssessmentTaskOverdue", () => {
  const now = new Date("2026-12-06T00:00:00.000Z");
  it("is overdue only when scheduled and past the late grace", () => {
    expect(isAssessmentTaskOverdue(task(), now)).toBe(true);
    expect(isAssessmentTaskOverdue(task({ status: "completed" }), now)).toBe(false);
    expect(isAssessmentTaskOverdue(task(), new Date("2026-12-05T00:00:00.000Z"))).toBe(false);
  });
});

describe("stickyManualFactorsOf", () => {
  it("reads the manual factors a prior score stored, ignoring anything malformed", () => {
    expect(
      stickyManualFactorsOf({
        manualFactors: {
          financialStrain: true,
          socialIsolation: false,
          bogus: true,
          priorUnresolvedLoss: "yes",
        },
      }),
    ).toEqual({ financialStrain: true, socialIsolation: false });
  });

  it("is empty for a prior row that never stored any", () => {
    expect(stickyManualFactorsOf({})).toEqual({});
    expect(stickyManualFactorsOf(null)).toEqual({});
    expect(stickyManualFactorsOf({ manualFactors: "x" })).toEqual({});
  });
});
