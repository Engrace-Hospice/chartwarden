// The composition root binds the visit-note closure gate where it has to be (ADR-0113 D6). Bound is not computing, and a lost binding is
// silent: `mountEncounterRoutes` takes the policy cache as an OPTIONAL fifth argument (it builds its own when absent), so a call that
// forgets to hand over THE gate's cache still compiles and passes every unit test while a closure-policy PUT stops invalidating what the
// gate reads. This pins, in apps/backend/src/index.ts: ONE policy cache, the gate built over it, the gate handed to the authenticate hook
// (a boot error when absent, never a hook that skips it), and the same cache handed to the encounter routes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const index = readFileSync(join(__dirname, "../src/index.ts"), "utf8");

describe("the composition root wires the note-closure gate", () => {
  it("builds exactly ONE closure policy cache, over the database handle", () => {
    expect(index.match(/createDbClosurePolicyCache\(/g)).toHaveLength(1);
    expect(index).toMatch(
      /const closurePolicyCache = dbHandle \? createDbClosurePolicyCache\(dbHandle\.db\) : undefined;/,
    );
  });

  it("builds the gate over that cache and the shared evaluator, inside the caller's org context", () => {
    expect(index).toMatch(
      /createNoteClosureGate\(\{\s*policyCache: closurePolicyCache,\s*evaluate: \(\{[^}]*\}\) =>\s*withOrgContext\(dbHandle\.db, \{ organizationId, userId \}, \(tx\) =>\s*evaluateMemberClosure\(/,
    );
  });

  it("hands the gate to the authenticate hook and refuses to boot without it", () => {
    expect(index).toMatch(
      /noteClosureGate: \(\(\) => \{\s*if \(!noteClosureGate\) \{\s*throw new Error\([^)]*\);\s*\}\s*return noteClosureGate;\s*\}\)\(\),/,
    );
  });

  it("hands the SAME cache to the encounter routes, so a policy PUT invalidates what the gate sees", () => {
    expect(index).toMatch(
      /mountEncounterRoutes\(\s*app,\s*dbHandle\.db,\s*m8OutboxPublisher,\s*createHearthnoteCiphers\(getTenantKeyProvider\(\)\),\s*(\/\/[^\n]*\n\s*)*\{ \.\.\.\(closurePolicyCache \? \{ policyCache: closurePolicyCache \} : \{\}\) \},/,
    );
  });
});
