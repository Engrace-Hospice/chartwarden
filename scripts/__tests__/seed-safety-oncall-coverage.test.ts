import { describe, expect, it } from "vitest";
import { firstRnCoverageGap } from "../../apps/backend/src/modules/19-oncall/roster/coverage-gap";
import { detectCoverageGaps } from "../../apps/backend/src/modules/20-field-safety/lifecycle/coverage-gap";
import {
  buildRnCoverageShift,
  buildSupervisionSubscription,
} from "../db/lib/safety-oncall-coverage";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const SUPERVISOR = "00000000-0000-4000-8000-0000000000b1";
const CLINICIAN = "00000000-0000-4000-8000-0000000000b2";
const PE = "44444444-0000-4000-8000-000000000001";
const LOCATION = "55555555-0000-4000-8000-000000000001";

describe("demo safety/on-call coverage seed", () => {
  it("leaves no M20 coverage gap for any field clinician", () => {
    const sub = buildSupervisionSubscription(SUPERVISOR, ORG);
    const subject = (membershipId: string) => ({
      membershipId,
      locationIds: [LOCATION],
      providerEntityId: PE,
      isFieldEligible: true,
      hasInactiveSubscriptions: false,
    });
    const gaps = detectCoverageGaps({
      subjects: [subject(CLINICIAN), subject(SUPERVISOR)] as never,
      activeSubscriptions: [
        {
          ...sub,
          clinicianMembershipId: null,
          locationId: null,
          providerEntityId: null,
          isVacationForwarding: false,
          vacationForwardToMembershipId: null,
        },
      ] as never,
      activeSupervisorMembershipIds: new Set([SUPERVISOR]) as never,
    });
    expect(gaps).toEqual([]);
  });

  it("covers the M19 24h lookahead now and years from now", () => {
    const now = new Date("2026-10-19T12:00:00Z");
    const shift = buildRnCoverageShift({
      organizationId: ORG,
      providerEntityId: PE,
      rnMembershipId: CLINICIAN,
      now,
    });
    const windows = [
      {
        shiftStartsAt: shift.shiftStartsAt.toISOString(),
        shiftEndsAt: shift.shiftEndsAt.toISOString(),
      },
    ] as never;
    const yearsLater = now.getTime() + 3 * 365 * 86_400_000;
    for (const at of [now.getTime(), yearsLater]) {
      const from = new Date(at).toISOString();
      const to = new Date(at + 24 * 3_600_000).toISOString();
      expect(firstRnCoverageGap(windows, from as never, to as never)).toBeNull();
    }
  });
});
