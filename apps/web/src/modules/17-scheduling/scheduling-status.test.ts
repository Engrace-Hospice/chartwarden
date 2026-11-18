import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VISIT_PURPOSE_LABELS, visitPurposeLabel } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { PURPOSES, purposeLabel } from "./scheduling-status";

// apps/web does not depend on @chartwarden/scheduling, so the authority table is read as source: the
// `VISIT_PURPOSE_DISCIPLINES` literal in policy.ts, one `purpose: ["disc", ...],` line per purpose.
const POLICY_SOURCE = readFileSync(
  join(__dirname, "../../../../../packages/scheduling/src/policy.ts"),
  "utf8",
);

function policyDisciplines(): Map<string, string[]> {
  const block = POLICY_SOURCE.match(
    /export const VISIT_PURPOSE_DISCIPLINES[^=]*=\s*\{([\s\S]*?)\n\} as const;/,
  )?.[1];
  const entries = [...(block ?? "").matchAll(/^ {2}(\w+): \[([^\]]*)\],/gm)];
  return new Map(
    entries.map((m) => [m[1] as string, (m[2] as string).match(/[a-z]+/g) ?? ([] as string[])]),
  );
}

describe("visit purpose display table", () => {
  it("shows recert and loc_change as RN visits, matching the M17 purpose table", () => {
    expect(PURPOSES.recert?.discipline).toBe("rn");
    expect(PURPOSES.loc_change?.discipline).toBe("rn");
  });

  it("keeps the physician or NP encounter on face-to-face", () => {
    expect(PURPOSES.f2f?.discipline).toBe("md");
  });

  it("lists every purpose M17 schedules, with the first discipline M17 accepts for it", () => {
    const authority = policyDisciplines();
    expect(authority.size).toBeGreaterThan(0);
    expect([...authority.keys()].sort()).toEqual(Object.keys(PURPOSES).sort());
    for (const [purpose, disciplines] of authority) {
      expect(PURPOSES[purpose]?.discipline, purpose).toBe(disciplines[0]);
    }
  });

  it("labels the recertification kickoff so it is not mistaken for the face-to-face", () => {
    expect(purposeLabel("recert")).toBe("Recert Kickoff (RN)");
    expect(purposeLabel("f2f")).toBe("Face-to-Face");
  });

  it("uses the one shared label for every purpose, so the chart and the home dashboard agree", () => {
    for (const [purpose, label] of Object.entries(VISIT_PURPOSE_LABELS)) {
      expect(purposeLabel(purpose), purpose).toBe(label);
      expect(visitPurposeLabel(purpose), purpose).toBe(label);
      expect(PURPOSES[purpose]?.label, purpose).toBe(label);
    }
  });

  it("falls back to a title-cased label for a purpose the table does not know", () => {
    expect(purposeLabel("future_purpose")).toBe("Future Purpose");
    expect(visitPurposeLabel("future_purpose")).toBeUndefined();
  });

  it("does not mistake an inherited object property for a purpose", () => {
    expect(visitPurposeLabel("constructor")).toBeUndefined();
    expect(purposeLabel("toString")).toBe("ToString");
  });
});
