// #678: requirePermission grants the service principal every `*_internal` key by suffix, so the suffix must stay
// service-only. No role template may grant one, and the catalog's set must match this reviewed list.
import { describe, expect, it } from "vitest";
import * as contributed from "../src/permissions/contributed";
import { ROLE_TEMPLATES } from "../src/roles/templates";

const INTERNAL_KEYS = [
  "aide_supervisory.read_internal",
  "denial.read_internal",
  "discipline_plan.read_internal",
  "encounter.read_internal",
  "pr.read_internal",
  "remittance.ingest_internal",
  "remittance.read_internal",
  "volunteer_compliance.read_internal",
];

describe("*_internal permission keys are service-only", () => {
  it("the catalog's internal keys equal the reviewed list", () => {
    const all = Object.entries(contributed)
      .filter(([name]) => name.endsWith("_CONTRIBUTED_PERMISSIONS"))
      .flatMap(([, defs]) => Object.keys(defs as object));
    const found = all.filter((k) => k.endsWith("_internal"));
    expect(found.sort()).toEqual(INTERNAL_KEYS);
  });
  it("no role template grants one", () => {
    expect(JSON.stringify(ROLE_TEMPLATES)).not.toMatch(/_internal/);
  });
});
