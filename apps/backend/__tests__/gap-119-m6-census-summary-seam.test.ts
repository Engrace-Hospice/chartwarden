// GAP-119 — M6's org-explicit census summary: four counts, "today" in the ORG's timezone, run under the org's
// RLS context with the system actor, counts only.
import { describe, expect, it, vi } from "vitest";

const contexts: Array<{ organizationId: string; userId: string }> = [];
const queue: Array<Array<{ n: number | string }>> = [];

vi.mock("@wardenx/tenancy", () => ({
  withOrgContext: async (
    _db: unknown,
    ctx: { organizationId: string; userId: string },
    fn: (tx: unknown) => Promise<unknown>,
  ) => {
    contexts.push(ctx);
    const chain = (): unknown => {
      const node: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") return (resolve: (v: unknown) => void) => resolve(queue.shift());
            return () => node;
          },
        },
      );
      return node;
    };
    return fn({ select: () => chain() });
  },
}));

vi.mock("@wardenx/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wardenx/db")>();
  return { ...actual, organizationTimezone: async () => "America/Los_Angeles" };
});

import {
  RECERT_DUE_WITHIN_DAYS,
  admissionCensusSummaryForOrg,
} from "../src/modules/06-admission/seams/admission-census-summary-for-org";

describe("admissionCensusSummaryForOrg", () => {
  it("maps the four counts and stamps the org-local date", async () => {
    queue.push([{ n: 4 }], [{ n: "2" }], [{ n: 1 }], [{ n: 7 }]);
    // 03:00 UTC on the 7th is still the 6th in Los Angeles.
    const out = await admissionCensusSummaryForOrg(
      {} as never,
      "org-1",
      new Date("2026-10-07T03:00:00.000Z"),
    );
    expect(out).toEqual({
      admissionsToday: 4,
      dischargesToday: 2,
      gipActive: 1,
      recertsDue: 7,
      asOfDate: "2026-10-06",
    });
  });

  it("runs under the org context as the system actor (no acting human)", async () => {
    queue.push([{ n: 0 }], [{ n: 0 }], [{ n: 0 }], [{ n: 0 }]);
    contexts.length = 0;
    await admissionCensusSummaryForOrg({} as never, "org-9");
    expect(contexts).toEqual([{ organizationId: "org-9", userId: "" }]);
  });

  it("a recert is due within a fortnight", () => {
    expect(RECERT_DUE_WITHIN_DAYS).toBe(14);
  });
});
