import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STATUS_TONE, cap, toneFor } from "../care-plan-status";

// The web workspace cannot import @chartwarden/db (tsc -b references only types/ui/auth), so the enum
// arrays are read from source — the same approach commercial-model.test.ts takes for packages/types.
const enumsSource = readFileSync(
  new URL("../../../../../../packages/db/src/enums.ts", import.meta.url),
  "utf8",
);

function enumValues(name: string): string[] {
  const body =
    new RegExp(`pgEnum\\(\\s*"${name}",\\s*\\[([^\\]]+)\\]`).exec(enumsSource)?.[1] ?? "";
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

const STATUS_ENUMS = [
  "care_plan_status",
  "care_plan_version_status",
  "care_plan_idg_proposal_status",
  "care_plan_idg_proposed_change_status",
  "problem_status",
  "problem_proposal_status",
  "goal_status",
  "intervention_status",
];

describe("care-plan status tones", () => {
  it.each(STATUS_ENUMS)("%s: the enum source was found and is non-empty", (name) => {
    expect(enumValues(name).length).toBeGreaterThan(0);
  });

  it.each(STATUS_ENUMS)("%s: every enum value has an explicit tone", (name) => {
    const missing = enumValues(name).filter((value) => !(value in STATUS_TONE));
    expect(missing).toEqual([]);
  });

  it("has no entry that no status enum contains (stale literals hide drift)", () => {
    const real = new Set(STATUS_ENUMS.flatMap(enumValues));
    const stale = Object.keys(STATUS_TONE).filter((value) => !real.has(value));
    expect(stale).toEqual([]);
  });

  it("shows a version awaiting signatures as in progress, not as an idle draft", () => {
    expect(toneFor("in_review")).toBe("progress");
    expect(toneFor("draft")).toBe("neutral");
  });

  it("falls back to neutral for an unknown status and humanizes labels", () => {
    expect(toneFor("something_new")).toBe("neutral");
    expect(cap("in_review")).toBe("In Review");
  });
});
