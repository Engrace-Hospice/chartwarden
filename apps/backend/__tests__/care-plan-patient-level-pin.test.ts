// apps/backend/__tests__/care-plan-patient-level-pin.test.ts — ratchet on the `"patient_level"` audience of
// `CarePlanReader.relevantElementsForEncounter`. It skips the per-actor Part 2 verdict, so it is for a caller with NO
// human actor only (R-80, 06-care-plan-current-state-audit): the scheduling worker and M15's system actor. Every
// human-facing caller asks under the actor's own rule: M7's picker passes the verdict its route resolved, M8's link
// check and M15's parent check pass `{ actor: { roles, membershipId } }` and the store resolves the verdict itself.
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(__dirname, "../../..");
const M7 = "apps/backend/src/modules/07-care-plan/seams";
const M8_LINK = "apps/backend/src/modules/08-encounters/encounters-route-service-db.ts";
const M15_ELEMENTS =
  "apps/backend/src/modules/15-discipline-care-plans/consumers/care-plan-elements.ts";
const M15_WRITE =
  "apps/backend/src/modules/15-discipline-care-plans/routes/write-service-drizzle.ts";
const M17_WORKER = "apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts";
// M8 is deliberately absent: its link check is per-actor and must never name the literal again.
const CALLERS: Record<string, string> = {
  [M15_ELEMENTS]: "elementsAudienceFor: the system actor serves no human, R-80",
  [M17_WORKER]: "scheduling worker, no human actor, source_payload unprojected, R-80",
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

/** Every non-test source file of the backend and of each package (a package without `src` contributes none). */
function allSourceFiles(): string[] {
  const dirs = [
    "apps/backend/src",
    ...readdirSync(join(REPO, "packages")).map((p) => `packages/${p}/src`),
  ];
  return dirs.flatMap((d) => {
    try {
      return sourceFiles(d);
    } catch {
      return [];
    }
  });
}

describe("the care plan `patient_level` audience is pinned to its reviewed callers", () => {
  it("only the allowlisted files name the literal", () => {
    const found = allSourceFiles().filter((f) =>
      readFileSync(join(REPO, f), "utf8").includes('"patient_level"'),
    );
    expect(
      found.sort(),
      'A caller with a human actor must pass the per-actor audience, not "patient_level". To add a caller with NO ' +
        "human actor, add it here with a reason and have the compliance owner review it.",
    ).toEqual(Object.keys(ALLOWED).sort());
  });

  const read = (file: string) => readFileSync(join(REPO, file), "utf8");

  it("M17's worker passes the literal to relevantElementsForEncounter", () => {
    expect(read(M17_WORKER)).toMatch(
      /relevantElementsForEncounter\([^)]*"patient_level"\s*,?\s*\)/,
    );
  });

  it("M15 returns the literal only for the system actor, and the two write paths pass elementsAudienceFor(actor)", () => {
    expect(read(M15_ELEMENTS)).toMatch(
      /actor\.kind === "system"\s*\?\s*"patient_level"\s*:\s*\{\s*actor:\s*\{\s*roles: actor\.roles,\s*membershipId: actor\.membershipId\s*\}\s*\}/,
    );
    const write = read(M15_WRITE);
    const calls = write.match(/assertParentElements\(/g) ?? [];
    const audienceCalls =
      write.match(/assertParentElements\([^;]*?elementsAudienceFor\(actor\),?\s*\)/gs) ?? [];
    expect(calls).toHaveLength(2); // createGoal and createIntervention
    expect(audienceCalls).toHaveLength(calls.length);
  });

  it("M8's link check asks under the ACTOR audience and never names the literal", () => {
    const m8 = read(M8_LINK);
    expect(m8).not.toContain('"patient_level"');
    expect(m8).toMatch(
      /relevantElementsForEncounter\([^;]*\{\s*actor:\s*\{\s*roles:\s*actorRoles,\s*membershipId:\s*actorMembershipId\s*\}\s*\}/,
    );
  });
});

// A tripwire for the OBVIOUS shapes only, not a guarantee: a computed value, a quoted key (`"sudDisclosureAllowed": true`),
// a variable, or a spread would pass it. The real control is review of any new `{ sudDisclosureAllowed }` audience: it
// replaces the M39 lookup, so whoever hand-builds one is the trust boundary.
describe("the care plan `{ sudDisclosureAllowed }` audience is not hand-built from a boolean literal (tripwire)", () => {
  const ROUTES = "apps/backend/src/modules/07-care-plan/routes/care-plan-routes.ts";
  const read = (file: string) => readFileSync(join(REPO, file), "utf8");

  it("no source file hand-builds a `{ sudDisclosureAllowed }` audience from a boolean literal", () => {
    // The M7 routes' viewers are `{ sudDisclosureAllowed: await sudDisclosureAllowed({...}) }` (the M7 closure, never a
    // literal). A literal `true` would bypass M39; the one `false` allowed is the write viewer's fail-closed fallback
    // when the consent lookup throws (it can only narrow). Comments are stripped: they may quote the shape.
    const code = (file: string) =>
      read(file)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const literals = allSourceFiles().flatMap((f) =>
      [...code(f).matchAll(/sudDisclosureAllowed:\s*(true|false)\b/g)].map((m) => `${f} ${m[1]}`),
    );
    expect(literals).toEqual([`${ROUTES} false`]);
  });

  it("both M7 viewers (`viewerOf` and the picker route's own) take the closure's verdict", () => {
    // Two uses today: `viewerOf` (plan-keyed reads) and the picker route's inline viewer. A count of one would mean the
    // picker's viewer became a variable, which the pattern alone (satisfied by `viewerOf`) would not notice.
    const closureViewers =
      read(ROUTES).match(/sudDisclosureAllowed:\s*await sudDisclosureAllowed\(/g) ?? [];
    expect(closureViewers.length).toBeGreaterThanOrEqual(2);
  });
});
