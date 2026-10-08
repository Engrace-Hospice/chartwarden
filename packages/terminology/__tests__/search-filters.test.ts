// packages/terminology/__tests__/search-filters.test.ts — `searchByText` honours `inValueSet` and `billableOnly`
// (the in-memory store is the contract the Drizzle store is held to; the live suite proves the SQL).
import { describe, expect, it } from "vitest";
import {
  type ResolvedConcept,
  createInMemoryTerminologyStore,
  createTerminologyProvider,
} from "../src";

const base = { effectiveDate: "2020-01-01", endDate: null } as const;

const concepts: ResolvedConcept<"icd10cm" | "loinc">[] = [
  {
    ...base,
    systemId: "icd10cm",
    code: "I50.21",
    display: "Acute systolic heart failure",
    status: "active",
    properties: { isBillableLeaf: true, chapter: "IX", parentCode: "I50.2" },
  },
  {
    ...base,
    systemId: "icd10cm",
    code: "I50.2",
    display: "Systolic heart failure",
    status: "active",
    properties: { isBillableLeaf: false, chapter: "IX", parentCode: "I50" },
  },
  {
    ...base,
    systemId: "icd10cm",
    code: "I50.20",
    display: "Unspecified systolic heart failure",
    status: "deprecated",
    properties: { isBillableLeaf: true, chapter: "IX", parentCode: "I50.2" },
  },
  {
    ...base,
    systemId: "loinc",
    code: "1-1",
    display: "Heart rate",
    status: "active",
    properties: {
      component: null,
      property: null,
      time: null,
      system: null,
      scale: null,
      method: null,
      shortName: null,
    },
  },
  {
    ...base,
    systemId: "loinc",
    code: "2-1",
    display: "Heart rhythm old",
    status: "deprecated",
    properties: {
      component: null,
      property: null,
      time: null,
      system: null,
      scale: null,
      method: null,
      shortName: null,
    },
  },
];

function makeProvider() {
  const { store } = createInMemoryTerminologyStore({
    concepts,
    valueSetMembers: [
      { valueSetId: "hf", systemId: "icd10cm", code: "I50.21", display: "x", annotations: {} },
      { valueSetId: "hf", systemId: "loinc", code: "1-1", display: "x", annotations: {} },
    ],
  });
  return createTerminologyProvider(store);
}

describe("searchByText filters", () => {
  it("billableOnly keeps only active billable-leaf ICD-10-CM codes", async () => {
    const hits = await makeProvider().searchByText("icd10cm", "systolic", { billableOnly: true });
    expect(hits.map((h) => h.code)).toEqual(["I50.21"]);
  });

  it("billableOnly on a system without a billable flag means active status, never a no-op", async () => {
    const all = await makeProvider().searchByText("loinc", "heart");
    const billable = await makeProvider().searchByText("loinc", "heart", { billableOnly: true });
    expect(all.map((h) => h.code).sort()).toEqual(["1-1", "2-1"]);
    expect(billable.map((h) => h.code)).toEqual(["1-1"]);
  });

  it("inValueSet restricts to the set's members of the searched system", async () => {
    const hits = await makeProvider().searchByText("icd10cm", "heart", { inValueSet: "hf" });
    expect(hits.map((h) => h.code)).toEqual(["I50.21"]);
  });

  it("inValueSet unions the calling tenant's extensions only", async () => {
    const provider = makeProvider();
    await provider.addTenantExtension("org_a", "hf", "icd10cm", "I50.2", "needed", "u1");
    const mine = await provider.searchByText("icd10cm", "heart", {
      inValueSet: "hf",
      orgId: "org_a",
    });
    const other = await provider.searchByText("icd10cm", "heart", {
      inValueSet: "hf",
      orgId: "org_b",
    });
    expect(mine.map((h) => h.code).sort()).toEqual(["I50.2", "I50.21"]);
    expect(other.map((h) => h.code)).toEqual(["I50.21"]);
  });

  it("inValueSet combines with billableOnly", async () => {
    const hits = await makeProvider().searchByText("loinc", "h", {
      inValueSet: "hf",
      billableOnly: true,
    });
    expect(hits.map((h) => h.code)).toEqual(["1-1"]);
  });

  it("an unknown value set is NOT_FOUND, not an empty result", async () => {
    await expect(
      makeProvider().searchByText("icd10cm", "heart", { inValueSet: "nope" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
