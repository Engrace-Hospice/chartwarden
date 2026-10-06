// apps/backend/__tests__/m31-auditor-engagement-view.test.ts — GAP-093(d): the auditor view resolves what the
// ENGAGEMENT covers through M3's reader and returns only covered patients' data. The engagement id is never
// handed to the per-patient resolver as if it were a patient id.
import { describe, expect, it, vi } from "vitest";
import {
  type EngagementCoverageReader,
  resolveAuditorEngagementView,
} from "../src/modules/31-portal/routes/auditor-engagement";

const ORG = "11111111-1111-4111-8111-111111111111";
const ENGAGEMENT = "44444444-4444-4444-8444-444444444444";
const AUDITOR = "55555555-5555-4555-8555-555555555555";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const P3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AT = new Date("2026-10-05T12:00:00Z");

const zero = {
  hasActiveAccount: false,
  daysActive: 0,
  lastViewedAt: null,
  messagesSent: 0,
  documentsViewed: 0,
  amendmentsSubmitted: 0,
  administrationsAttested: 0,
};

function fixtures(
  over: {
    coverage?: Awaited<ReturnType<EngagementCoverageReader["engagementScope"]>> | "throws";
  } = {},
) {
  const reader: EngagementCoverageReader = {
    engagementScope: vi.fn(async () => {
      if (over.coverage === "throws") throw new Error("M3 unreadable");
      return over.coverage === undefined
        ? { tenantWide: false, patientIds: [P1, P2] }
        : over.coverage;
    }),
  };
  const seen: string[] = [];
  const store = {
    engagement: {
      engagementForPatient: vi.fn(async (_org: string, patientId: string) => {
        seen.push(patientId);
        return patientId === P1
          ? {
              ...zero,
              hasActiveAccount: true,
              daysActive: 4,
              lastViewedAt: "2026-10-04T00:00:00Z",
              messagesSent: 2,
            }
          : { ...zero, daysActive: 9, lastViewedAt: "2026-10-03T00:00:00Z", documentsViewed: 5 };
      }),
    },
    grants: {
      patientsWithActiveGrantsInOrg: vi.fn(async () => [
        { patientId: P1, grantCount: 1 },
        { patientId: P3, grantCount: 2 },
      ]),
    },
  };
  return { reader, store, seen };
}
const run = (f: ReturnType<typeof fixtures>) =>
  resolveAuditorEngagementView({
    organizationId: ORG,
    engagementId: ENGAGEMENT,
    auditorUserId: AUDITOR,
    at: AT,
    windowDays: 90,
    reader: f.reader,
    store: f.store as never,
  });

describe("resolveAuditorEngagementView", () => {
  it("aggregates ONLY the engagement's explicit patients and never passes the engagement id as a patient", async () => {
    const f = fixtures();
    const view = await run(f);
    expect(f.seen.sort()).toEqual([P1, P2]);
    expect(f.seen).not.toContain(ENGAGEMENT);
    expect(view).toEqual({
      hasActiveAccount: true,
      daysActive: 9,
      lastViewedAt: "2026-10-04T00:00:00Z",
      messagesSent: 2,
      documentsViewed: 5,
      amendmentsSubmitted: 0,
      administrationsAttested: 0,
    });
    expect(f.reader.engagementScope).toHaveBeenCalledWith({
      organizationId: ORG,
      engagementId: ENGAGEMENT,
      auditorUserId: AUDITOR,
      at: AT.toISOString(),
    });
  });

  it("a tenant-wide engagement covers the org's patients with an active grant (plus explicit ids)", async () => {
    const f = fixtures({ coverage: { tenantWide: true, patientIds: [P2] } });
    await run(f);
    expect(f.seen.sort()).toEqual([P1, P2, P3]);
  });

  it("an engagement that covers no patients returns zeros and reads no patient", async () => {
    const f = fixtures({ coverage: { tenantWide: false, patientIds: [] } });
    expect(await run(f)).toEqual(zero);
    expect(f.seen).toEqual([]);
  });

  it("returns null (deny) when the reader says the engagement is not live", async () => {
    const f = fixtures({ coverage: null });
    expect(await run(f)).toBeNull();
    expect(f.seen).toEqual([]);
  });

  it("propagates a reader failure so the route fails closed", async () => {
    const f = fixtures({ coverage: "throws" });
    await expect(run(f)).rejects.toThrow("M3 unreadable");
    expect(f.seen).toEqual([]);
  });
});
