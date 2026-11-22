// apps/backend/__tests__/discipline-plan-as-of-second-filter.test.ts — ADR-0114 S4 (VN-D49): the projection of `planElementsAsOf` is a SECOND,
// independent Part 2 filter. Here the redaction (`redactDisciplineSnapshot`) is replaced by the identity, as if it were bypassed or broken,
// and a viewer without disclosure must still never receive a Part 2 goal or an intervention anchored to one.
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/modules/15-discipline-care-plans/routes/snapshot-redaction", () => ({
  redactDisciplineSnapshot: (snapshot: unknown) => snapshot,
}));

import {
  createDisciplinePlanReader,
  createInMemoryDisciplinePlanSeamStore,
} from "../src/modules/15-discipline-care-plans/index";

const SNAPSHOT = {
  goals: [
    {
      goalId: "goal-open",
      status: "in_progress",
      source: "clinical",
      originalText: "An ordinary goal",
      revisedText: null,
      sudRelated: false,
    },
    {
      goalId: "goal-sud",
      status: "in_progress",
      source: "clinical",
      originalText: "A Part 2 goal",
      revisedText: null,
      sudRelated: true,
    },
  ],
  interventions: [
    {
      interventionId: "iv-open",
      status: "active",
      scopeText: "Ordinary",
      frequencyText: "weekly",
      goalRefs: [],
    },
    {
      interventionId: "iv-sud",
      status: "active",
      scopeText: "Part 2 work",
      frequencyText: "weekly",
      goalRefs: ["GOAL-SUD"],
    },
  ],
};

describe("planElementsAsOf with the redaction bypassed", () => {
  it("still withholds Part 2 goals and anchored interventions from a viewer without disclosure", async () => {
    const { store } = createInMemoryDisciplinePlanSeamStore({
      versions: [
        {
          versionId: "ver-1",
          planId: "plan-1",
          patientId: "pat-1",
          admissionId: "adm-1",
          kind: "msw_plan",
          status: "signed",
          signedAt: "2026-03-01T09:00:00.000Z",
          supersededAt: null,
          spiritualCareDeclinedAt: null,
          stateSnapshot: SNAPSHOT,
        },
      ],
    });
    const reader = createDisciplinePlanReader(store, {
      part2ReleaseActive: async () => ({ allowed: false, restrictedToNamedWorkforce: true }),
      familyViolenceRedacted: async () => true,
    });

    const out = await reader.planElementsAsOf(
      "org-1",
      "pat-1",
      "adm-1",
      "msw_plan",
      { roles: ["msw"], membershipId: "mem-1" },
      "2026-03-05T00:00:00.000Z",
    );

    expect(out?.goals.map((g) => g.goalId)).toEqual(["goal-open"]);
    expect(out?.interventions.map((i) => i.interventionId)).toEqual(["iv-open"]);
    expect(out?.redacted).toBe(true);
    expect(JSON.stringify(out)).not.toContain("Part 2");
  });
});
