// GAP-097 review follow-up — a registered ABAC predicate must catch its OWN throws: the registry does not,
// so a resolver that rejects (an invalid uuid in the route `:id` raising 22P02, a transient DB error) would
// surface as a 500 instead of the documented non-leaking deny. M33's two resolver-backed predicates deny.
import type { AbacContext } from "@chartwarden/auth";
import { describe, expect, it } from "vitest";
import {
  type ReportingAbacResolver,
  buildM33AbacPredicates,
  denyStubReportingAbacResolver,
} from "../src/modules/33-reporting/abac-predicates";

const context: AbacContext = {
  organizationId: "org-a",
  userId: "u-1",
  roles: ["supervisor"],
  providerEntityIds: [],
  locationIds: [],
  attributes: { membershipId: "m-1" },
};

const throwingResolver: ReportingAbacResolver = {
  ...denyStubReportingAbacResolver,
  async loadReportView() {
    throw new Error('invalid input syntax for type uuid: "not-a-uuid"');
  },
  async loadReportSchedule() {
    throw new Error('invalid input syntax for type uuid: "not-a-uuid"');
  },
};

describe("M33 resolver-backed predicates fail closed when their resolver throws", () => {
  const predicates = buildM33AbacPredicates({ resolver: throwingResolver });

  it.each(["read", "write"])(
    "report_schedule_access (%s) denies instead of throwing",
    async (mode) => {
      await expect(
        predicates.report_schedule_access(context, { scheduleId: "not-a-uuid", mode }),
      ).resolves.toBe(false);
    },
  );

  it("dashboard_visibility denies instead of throwing", async () => {
    await expect(predicates.dashboard_visibility(context, { viewId: "not-a-uuid" })).resolves.toBe(
      false,
    );
  });
});
