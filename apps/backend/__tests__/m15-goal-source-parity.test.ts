// Drift pin: the M15 goal route's `source` union must equal the `discipline_goal_source` DB enum. A value the
// route accepts but the enum lacks passes validation and then 500s at the insert; a value the enum has but the
// route lacks is rejected with a 400 (the `clinician_authored` / `idg_directed` vs `clinical` defect).
import { disciplineGoalSource } from "@chartwarden/db/schema";
import { describe, expect, it } from "vitest";

import { GoalSource } from "../src/modules/15-discipline-care-plans/routes/m15-typebox";

describe("M15 goal source parity", () => {
  it("route GoalSource literals equal the discipline_goal_source enum values", () => {
    const routeValues = GoalSource.anyOf.map((literal) => literal.const);

    expect([...routeValues].sort()).toEqual([...disciplineGoalSource.enumValues].sort());
  });
});
