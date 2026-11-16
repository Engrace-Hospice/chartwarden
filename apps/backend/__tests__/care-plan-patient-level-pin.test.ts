// apps/backend/__tests__/care-plan-patient-level-pin.test.ts — ratchet on the `"patient_level"` audience of
// `CarePlanReader.relevantElementsForEncounter`. It skips the per-actor Part 2 verdict, so the files that name it
// are pinned: a human-facing route must pass the per-actor viewer instead (R-80, 06-care-plan-current-state-audit).
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(__dirname, "../../..");
const M7 = "apps/backend/src/modules/07-care-plan/seams";
const CALLERS: Record<string, string> = {
  "apps/backend/src/modules/08-encounters/encounters-route-service-db.ts":
    "ids only: ref validation, R-75/R-80",
  "apps/backend/src/modules/15-discipline-care-plans/consumers/care-plan-elements.ts":
    "ids only: parent check, R-80",
  "apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts":
    "system actor, source_payload unprojected, R-80",
};
const IMPLEMENTERS: Record<string, string> = {
  "packages/types/src/care-plan.ts": "defines CarePlanElementsAudience",
  [`${M7}/store.ts`]: "in-memory store branches on it",
  [`${M7}/drizzle-store.ts`]: "Drizzle store branches on it",
};
const ALLOWED = { ...CALLERS, ...IMPLEMENTERS };

function sourceFiles(dir: string): string[] {
  return (readdirSync(join(REPO, dir), { recursive: true }) as string[])
    .filter(
      (f) =>
        f.endsWith(".ts") &&
        !f.split(sep).some((p) => ["node_modules", "dist", "__tests__"].includes(p)),
    )
    .map((f) => `${dir}/${f.split(sep).join("/")}`);
}

describe("the care plan `patient_level` audience is pinned to its reviewed callers", () => {
  it("only the allowlisted files name the literal", () => {
    const dirs = [
      "apps/backend/src",
      ...readdirSync(join(REPO, "packages")).map((p) => `packages/${p}/src`),
    ];
    const found = dirs
      .flatMap((d) => {
        try {
          return sourceFiles(d);
        } catch {
          return [];
        }
      })
      .filter((f) => readFileSync(join(REPO, f), "utf8").includes('"patient_level"'));
    expect(
      found.sort(),
      'A human-facing route must pass the per-actor viewer, not "patient_level". To add a caller, add it here with a ' +
        "reason and have the compliance owner review it.",
    ).toEqual(Object.keys(ALLOWED).sort());
  });

  it.each(Object.keys(CALLERS))("%s passes the literal to relevantElementsForEncounter", (file) => {
    expect(readFileSync(join(REPO, file), "utf8")).toMatch(
      /relevantElementsForEncounter\([^)]*"patient_level"\s*,?\s*\)/,
    );
  });
});
