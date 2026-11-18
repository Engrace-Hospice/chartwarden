// The composition root binds the visit-note closure gate where it has to be (ADR-0113 D6). Bound is not computing, and a lost binding is
// silent: `mountEncounterRoutes` takes the policy cache as an OPTIONAL fifth argument (it builds its own when absent), so a call that
// forgets to hand over THE gate's cache still compiles and passes every unit test while a closure-policy PUT stops invalidating what the
// gate reads. This pins, in apps/backend/src/index.ts: ONE policy cache, the gate built over it, the gate handed to the authenticate hook
// (a boot error when absent, never a hook that skips it), and the same cache handed to the encounter routes. The assertions run on a
// line-comment-, whitespace- and trailing-comma-free normal form of index.ts, so reformatting the file cannot break them; the BEHAVIOUR of the
// gate (refusing through the real authenticate hook) is proven in note-closure-gate-inject.test.ts, which this file does not duplicate.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A `//` comment to end of line: one on its own line, or one after whitespace. The `//` of a URL (`https://`) has no whitespace before
 * it, so it stays. (Block comments are deliberately NOT stripped: a string such as `"/api/*"` elsewhere in index.ts would open one
 * that swallows real code.)
 */
const LINE_COMMENT = /(^|\s)\/\/[^\n]*/g;

/**
 * The source with line comments, whitespace and trailing commas removed, so a formatter (line breaks, indentation, a trailing comma)
 * or a comment dropped between two arguments cannot make a pattern miss. The patterns below are written against this normal form.
 */
function normalized(source: string): string {
  return source
    .replace(LINE_COMMENT, "$1")
    .replace(/\s+/g, "")
    .replace(/,([)\]}])/g, "$1");
}

const index = normalized(readFileSync(join(__dirname, "../src/index.ts"), "utf8"));

describe("normalized() reads past formatting, so the wiring patterns below are not brittle", () => {
  it("drops line comments, line breaks, indentation and trailing commas, and keeps a URL's //", () => {
    const source = "f(\n  // own line\n  a, // why\n  { b: 1, },\n  'https://example.test',\n);";
    expect(normalized(source)).toBe("f(a,{b:1},'https://example.test');");
  });
});

describe("the composition root wires the note-closure gate", () => {
  it("builds exactly ONE closure policy cache, over the database handle", () => {
    expect(index.match(/createDbClosurePolicyCache\(/g)).toHaveLength(1);
    expect(index).toContain(
      "constclosurePolicyCache=dbHandle?createDbClosurePolicyCache(dbHandle.db):undefined;",
    );
  });

  it("builds the gate over that cache and the shared evaluator, inside the caller's org context", () => {
    expect(index).toMatch(
      /createNoteClosureGate\(\{policyCache:closurePolicyCache,evaluate:\(\{[^}]*\}\)=>withOrgContext\(dbHandle\.db,\{organizationId,userId\},\(tx\)=>evaluateMemberClosure\(/,
    );
  });

  it("hands the gate to the authenticate hook and refuses to boot without it", () => {
    expect(index).toMatch(
      /noteClosureGate:\(\(\)=>\{if\(!noteClosureGate\)\{thrownewError\([^)]*\);\}returnnoteClosureGate;\}\)\(\),/,
    );
  });

  it("hands the closure alert sweep the real alert-table reader, so it skips alerts that already exist instead of re-emitting them every tick", () => {
    expect(index).toMatch(
      /buildM8WorkerDeps\(\{[^}]*existingAlertCorrelations:createDbAlertCorrelationReader\(dbHandle\.db\)/,
    );
  });

  it("hands the SAME cache to the encounter routes, so a policy PUT invalidates what the gate sees", () => {
    expect(index).toContain(
      "mountEncounterRoutes(app,dbHandle.db,m8OutboxPublisher,createHearthnoteCiphers(getTenantKeyProvider()),{...(closurePolicyCache?{policyCache:closurePolicyCache}:{})}",
    );
  });
});
