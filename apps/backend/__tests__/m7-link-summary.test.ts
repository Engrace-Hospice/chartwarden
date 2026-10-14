import { describe, expect, it } from "vitest";
import {
  createCarePlanReader,
  createInMemoryCarePlanReaderStore,
} from "../src/modules/07-care-plan/index";

const ORG = "org-a";
const row = {
  organizationId: ORG,
  id: "cp-1",
  patientId: "pat-1",
  status: "active",
  occurredAt: "2031-03-15T12:00:00.000Z",
};
const reader = () =>
  createCarePlanReader(createInMemoryCarePlanReaderStore({ links: [row] }).store);

describe("CarePlanReader.linkSummary (M36 WP 3.2)", () => {
  it("returns exactly id, patientId, status, occurredAt for a plan in the org", async () => {
    const got = await reader().linkSummary(ORG, "cp-1");
    expect(got).toEqual({
      id: "cp-1",
      patientId: "pat-1",
      status: "active",
      occurredAt: row.occurredAt,
    });
    expect(Object.keys(got ?? {}).sort()).toEqual(["id", "occurredAt", "patientId", "status"]);
  });
  it("returns null for an unknown id", async () => {
    expect(await reader().linkSummary(ORG, "nope")).toBeNull();
  });
  it("returns null for another org's plan", async () => {
    expect(await reader().linkSummary("org-b", "cp-1")).toBeNull();
  });
  it("throws on a blank organizationId or id", async () => {
    await expect(reader().linkSummary("", "cp-1")).rejects.toThrow(/organizationId/);
    await expect(reader().linkSummary("  ", "cp-1")).rejects.toThrow(/organizationId/);
    await expect(reader().linkSummary(ORG, "")).rejects.toThrow(/id required/);
  });
});
