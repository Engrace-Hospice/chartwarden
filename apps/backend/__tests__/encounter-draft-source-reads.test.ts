// S3 (ADR-0114, VN-D42): the read keys of the SOURCE domains a draft is compiled from, asked by template. Until S3 the draft routes asked all three
// (the care plan, the medication orders, the scored scales) of every draft through static preHandlers, so an aide's draft, which reads the care plan
// alone, needed a medication-order read and a scale-trend read. Now the keys follow the sources the template's drafted sections read
// (`draftSourceNeeds`), and the service asks them, after the switch and the tenant are known and before any source is read.
import { draftSourceNeeds } from "@chartwarden/hearthnote";
import { ENCOUNTER_DISCIPLINE_RULES, type EncounterType } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  SOURCE_DOMAIN_KEYS,
  assertMayReadSourceDomains,
  sourceDomainReadsFor,
} from "../src/modules/08-encounters/drafting/source-reads";

const ALL = ["care_plan.read", "prescribing.read", "assessment.read_trend"];

describe("sourceDomainReadsFor (the keys follow the sources a template reads)", () => {
  it("an aide visit needs the care plan's key alone", () => {
    expect(sourceDomainReadsFor("chha_visit", "chha")).toEqual(["care_plan.read"]);
  });

  it.each([
    ["routine_visit", "lpn"],
    ["lpn_visit", "lpn"],
  ] as const)(
    "%s by an LPN needs the care plan and the medication orders, and no scale",
    (type, discipline) => {
      expect(sourceDomainReadsFor(type, discipline)).toEqual([
        "care_plan.read",
        "prescribing.read",
      ]);
    },
  );

  it.each([
    ["routine_visit", "rn"],
    ["recert_visit", "rn"],
    ["admission_visit", "rn"],
  ] as const)(
    "%s by an RN needs all three, as the draft routes always asked",
    (type, discipline) => {
      expect(sourceDomainReadsFor(type, discipline)).toEqual(ALL);
    },
  );

  it.each(["md", "np"] as const)(
    "the face-to-face visit by a %s needs the scales' key alone: its draft is the PPS and the weight",
    (discipline) => {
      expect(sourceDomainReadsFor("face_to_face", discipline)).toEqual(["assessment.read_trend"]);
    },
  );

  it("a template that drafts nothing needs none", () => {
    expect(sourceDomainReadsFor("msw_followup", "msw")).toEqual([]);
    expect(sourceDomainReadsFor("telephonic", "rn")).toEqual([]);
  });

  it("is derived from the sources for EVERY legal pair, so a template the corpus gains cannot be missed", () => {
    for (const type of Object.keys(ENCOUNTER_DISCIPLINE_RULES) as EncounterType[]) {
      for (const discipline of ENCOUNTER_DISCIPLINE_RULES[type]) {
        const needs = draftSourceNeeds(type, discipline);
        const expected = [
          ...(needs.carePlan ? [SOURCE_DOMAIN_KEYS.carePlan] : []),
          ...(needs.medicationChanges ? [SOURCE_DOMAIN_KEYS.medicationChanges] : []),
          ...(needs.scales ? [SOURCE_DOMAIN_KEYS.scales] : []),
        ];
        expect(sourceDomainReadsFor(type, discipline), `${type}:${discipline}`).toEqual(expected);
      }
    }
  });

  it("names the keys of the sibling routes: M7 care plan, M12 medication orders, M9 scale series", () => {
    expect(SOURCE_DOMAIN_KEYS).toEqual({
      carePlan: "care_plan.read",
      medicationChanges: "prescribing.read",
      scales: "assessment.read_trend",
    });
  });
});

describe("assertMayReadSourceDomains", () => {
  it("passes a caller who holds the template's keys, extra keys notwithstanding", () => {
    expect(() =>
      assertMayReadSourceDomains(
        "chha_visit",
        "chha",
        new Set(["care_plan.read", "encounter.read"]),
      ),
    ).not.toThrow();
  });

  it("refuses 403 naming the first key the caller lacks, in the order care plan, orders, scales", () => {
    const refusal = (held: string[]) => {
      try {
        assertMayReadSourceDomains("routine_visit", "rn", new Set(held));
        return undefined;
      } catch (e) {
        return e as Error & { statusCode: number };
      }
    };
    expect(refusal([])?.message).toContain("care_plan.read");
    expect(refusal(["care_plan.read"])?.message).toContain("prescribing.read");
    expect(refusal(["care_plan.read", "prescribing.read"])?.message).toContain(
      "assessment.read_trend",
    );
    expect(refusal([])).toMatchObject({ statusCode: 403 });
    expect(refusal(ALL)).toBeUndefined();
  });

  it("does not ask an aide for the keys of sources the aide's draft never reads", () => {
    expect(() =>
      assertMayReadSourceDomains("chha_visit", "chha", new Set(["care_plan.read"])),
    ).not.toThrow();
    expect(() =>
      assertMayReadSourceDomains("chha_visit", "chha", new Set(["prescribing.read"])),
    ).toThrow(/care_plan\.read/);
  });

  it("asks nothing for a template that drafts nothing", () => {
    expect(() => assertMayReadSourceDomains("msw_followup", "msw", new Set())).not.toThrow();
  });
});
