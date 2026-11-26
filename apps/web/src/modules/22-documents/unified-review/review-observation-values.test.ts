import { describe, expect, it } from "vitest";
import type { Candidate } from "../doclens-api";
import {
  NO_VALUE_LABEL,
  WITHHELD_LABEL,
  consolidateObservations,
  effectiveObservationValue,
  extractedValues,
  observationDisplayValue,
  observationKind,
  visibleValue,
} from "./review-observation-values";
import type { ReviewObservation } from "./review-projection";

type Decision = NonNullable<Candidate["decision"]>;

const CITY = "patient.address.city";
const PHONE = "patient.phoneMobile";

function decision(kind: Decision["decision"], editedValue: string | null = null): Decision {
  return {
    id: `decision-${kind}`,
    decision: kind,
    editedValue,
    reason: null,
    partOfBulkApprove: false,
    decidedAt: "2026-11-22T11:00:00.000Z",
  };
}

function candidate(
  id: string,
  fieldPath: string,
  value: string | null,
  overrides: Partial<Candidate> = {},
): Candidate {
  return {
    id,
    jobId: "job-1",
    documentType: "discharge_summary",
    fieldPath,
    description: fieldPath,
    riskLevel: "low",
    confidence: 0.9,
    value,
    page: 1,
    bbox: [10, 10, 20, 20],
    vision: { status: "not_required", observedValue: null },
    sudDetected: false,
    codingFlags: [],
    writebackTarget: true,
    redacted: false,
    decision: null,
    ...overrides,
  };
}

function observed(...candidates: readonly Candidate[]): ReviewObservation[] {
  return candidates.map((item) => ({ candidate: item, document: null }));
}

function ids(observations: readonly ReviewObservation[]): string[] {
  return observations.map(({ candidate: item }) => item.id);
}

describe("visibleValue", () => {
  it("returns text as it is and treats null, empty and whitespace-only as no value", () => {
    expect(visibleValue(" Salem ")).toBe(" Salem ");
    expect(visibleValue(null)).toBeNull();
    expect(visibleValue("")).toBeNull();
    expect(visibleValue("   ")).toBeNull();
  });
});

describe("effectiveObservationValue, observationKind and observationDisplayValue", () => {
  it("shows the approved correction in place of the extraction", () => {
    const corrected = candidate("a", CITY, "Salem", {
      decision: decision("approve_with_edit", "Keizer"),
    });

    expect(effectiveObservationValue(corrected)).toBe("Keizer");
    expect(observationKind(corrected)).toBe("correction");
    expect(observationDisplayValue(corrected)).toBe("Keizer");
  });

  it("keeps the extraction when the edit carries no value, and for approvals", () => {
    const noEdit = candidate("a", CITY, "Salem", { decision: decision("approve_with_edit") });
    const approved = candidate("b", CITY, "Salem", { decision: decision("approve") });

    expect(effectiveObservationValue(noEdit)).toBe("Salem");
    expect(observationKind(noEdit)).not.toBe("correction");
    expect(observationKind(approved)).toBe("extracted");
    expect(observationDisplayValue(approved)).toBe("Salem");
  });

  it("marks a rejection and keeps the rejected value visible", () => {
    const rejected = candidate("a", CITY, "Salem", { decision: decision("reject") });

    expect(observationKind(rejected)).toBe("rejected");
    expect(observationDisplayValue(rejected)).toBe("Salem");
  });

  it("names a blank extraction as no value", () => {
    expect(observationDisplayValue(candidate("a", CITY, null))).toBe(NO_VALUE_LABEL);
    expect(observationDisplayValue(candidate("b", CITY, "  "))).toBe(NO_VALUE_LABEL);
  });

  it("never shows the value of a withheld candidate, even one that carries a value", () => {
    const withheld = candidate("a", CITY, "Synthetic withheld text", { redacted: true });
    const withheldCorrection = candidate("b", CITY, "x", {
      redacted: true,
      decision: decision("approve_with_edit", "Synthetic edit"),
    });

    expect(observationKind(withheld)).toBe("withheld");
    expect(observationDisplayValue(withheld)).toBe(WITHHELD_LABEL);
    expect(observationKind(withheldCorrection)).toBe("withheld");
    expect(observationDisplayValue(withheldCorrection)).toBe(WITHHELD_LABEL);
  });
});

describe("consolidateObservations", () => {
  it("returns nothing for no observations", () => {
    expect(consolidateObservations([])).toEqual([]);
  });

  it("merges values that differ only by surrounding whitespace, inner spacing and case", () => {
    const values = consolidateObservations(
      observed(
        candidate("a", CITY, "Salem Heights"),
        candidate("b", CITY, "  salem   HEIGHTS  "),
        candidate("c", CITY, "SALEM HEIGHTS"),
      ),
    );

    expect(values).toHaveLength(1);
    expect(ids(values[0]?.observations ?? [])).toEqual(["a", "b", "c"]);
  });

  it("shows the first source's effective value as written, not the normalised key", () => {
    const [only] = consolidateObservations(
      observed(candidate("a", CITY, "SALEM"), candidate("b", CITY, "salem")),
    );

    expect(only?.displayValue).toBe("SALEM");
    expect(only?.kind).toBe("extracted");
  });

  it("keeps distinct values apart and orders values by their first source", () => {
    const values = consolidateObservations(
      observed(
        candidate("a", CITY, "Keizer"),
        candidate("b", CITY, "Salem"),
        candidate("c", CITY, "keizer"),
        candidate("d", CITY, "Albany"),
        candidate("e", CITY, "SALEM"),
      ),
    );

    expect(values.map(({ displayValue }) => displayValue)).toEqual(["Keizer", "Salem", "Albany"]);
    expect(values.map(({ observations }) => ids(observations))).toEqual([
      ["a", "c"],
      ["b", "e"],
      ["d"],
    ]);
  });

  it("merges phone numbers that differ only in formatting", () => {
    const values = consolidateObservations(
      observed(
        candidate("a", PHONE, "(503) 555-0177"),
        candidate("b", PHONE, "503-555-0177"),
        candidate("c", PHONE, "1 503 555 0177"),
        candidate("d", PHONE, "(503) 555-0188"),
      ),
    );

    expect(values.map(({ observations }) => ids(observations))).toEqual([["a", "b", "c"], ["d"]]);
  });

  it("keeps a correction, a rejection and a plain extraction of the same text apart", () => {
    const values = consolidateObservations(
      observed(
        candidate("a", CITY, "Keizer"),
        candidate("b", CITY, "Salem", { decision: decision("approve_with_edit", "keizer") }),
        candidate("c", CITY, "Keizer", { decision: decision("reject") }),
        candidate("d", CITY, "Keizer", { decision: decision("approve") }),
      ),
    );

    expect(values.map(({ kind }) => kind)).toEqual(["extracted", "correction", "rejected"]);
    expect(values.map(({ observations }) => ids(observations))).toEqual([["a", "d"], ["b"], ["c"]]);
  });

  it("never merges withheld candidates, including ones that carry an identical non-null value", () => {
    const values = consolidateObservations(
      observed(
        candidate("a", CITY, "Synthetic withheld text", { redacted: true }),
        candidate("b", CITY, "Synthetic withheld text", { redacted: true }),
        candidate("c", CITY, "Synthetic withheld text"),
      ),
    );

    expect(values.map(({ kind }) => kind)).toEqual(["withheld", "withheld", "extracted"]);
    expect(values.map(({ observations }) => observations.length)).toEqual([1, 1, 1]);
    expect(values[0]?.displayValue).toBeNull();
    expect(values[1]?.displayValue).toBeNull();
    expect(values[2]?.displayValue).toBe("Synthetic withheld text");
  });

  it("treats blank values as one no-value entry with no display text", () => {
    const [blank] = consolidateObservations(
      observed(candidate("a", CITY, ""), candidate("b", CITY, "   "), candidate("c", CITY, null)),
    );

    expect(blank?.observations).toHaveLength(3);
    expect(blank?.displayValue).toBeNull();
  });

  it("gives the same key to the same value and kind across separate calls", () => {
    const first = consolidateObservations(
      observed(candidate("a", CITY, "Salem"), candidate("b", CITY, "salem ")),
    );
    const refreshed = consolidateObservations(
      observed(candidate("x", CITY, " SALEM"), candidate("y", CITY, "Salem")),
    );

    expect(first[0]?.key).toBe(refreshed[0]?.key);
  });

  it("changes the key when an approval becomes a correction or a rejection", () => {
    const [plain] = consolidateObservations(observed(candidate("a", CITY, "Salem")));
    const [corrected] = consolidateObservations(
      observed(
        candidate("a", CITY, "Salem", { decision: decision("approve_with_edit", "Keizer") }),
      ),
    );
    const [rejected] = consolidateObservations(
      observed(candidate("a", CITY, "Salem", { decision: decision("reject") })),
    );

    expect(new Set([plain?.key, corrected?.key, rejected?.key]).size).toBe(3);
  });

  it("does not mutate its input", () => {
    const input = observed(candidate("a", CITY, "Salem"), candidate("b", CITY, "salem"));
    const snapshot = ids(input);

    consolidateObservations(input);

    expect(ids(input)).toEqual(snapshot);
  });
});

describe("extractedValues", () => {
  function corrected(id: string, original: string | null, edit: string): ReviewObservation[] {
    return observed(
      candidate(id, CITY, original, { decision: decision("approve_with_edit", edit) }),
    );
  }

  it("lists the distinct originals behind a consolidated correction, in source order", () => {
    const [value] = consolidateObservations([
      ...corrected("a", "Salem", "Keizer"),
      ...corrected("b", "Salm", "keizer"),
      ...corrected("c", "SALEM", "Keizer"),
    ]);

    expect(value?.observations).toHaveLength(3);
    expect(value ? extractedValues(value) : null).toEqual(["Salem", "Salm"]);
  });

  it("names a blank original as no value", () => {
    const [value] = consolidateObservations([
      ...corrected("a", null, "Keizer"),
      ...corrected("b", "  ", "Keizer"),
    ]);

    expect(value ? extractedValues(value) : null).toEqual([NO_VALUE_LABEL]);
  });

  it("is empty for every other kind, where the extraction is the displayed value", () => {
    const values = consolidateObservations(
      observed(
        candidate("a", CITY, "Salem"),
        candidate("b", CITY, "Albany", { decision: decision("reject") }),
        candidate("c", CITY, "Synthetic withheld text", { redacted: true }),
      ),
    );

    expect(values.map(extractedValues)).toEqual([[], [], []]);
  });
});
