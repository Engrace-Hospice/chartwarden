/**
 * The request-context attribute producer gate (F-030).
 *
 * `request.context.attributes` is `Record<string, unknown>`, so a read of a key nothing writes
 * compiles, evaluates, and yields `undefined`. Every reader treats that as deny, which makes the
 * failure silent, permanent, and indistinguishable from working code. Four instances were found and
 * fixed one at a time before anyone looked for the pattern — `membershipId`, the PE/location scopes,
 * `stepUpRecent`, and `systemPrincipal`.
 *
 * These tests pin the three regressions the gate exists to catch, using the real repo scan rather
 * than a synthetic fixture, so they fail if the SCANNER stops seeing a real code shape (which is how
 * a gate like this dies quietly).
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_ATTRIBUTES,
  findViolations,
  scanContextAttributes,
} from "../check-context-attributes";

const REPO_ROOT = join(__dirname, "../..");
const scan = scanContextAttributes(REPO_ROOT);
const keysWritten = new Set(scan.writes.map((w) => w.key));
const keysRead = new Set(scan.reads.map((r) => r.key));
const blockedKeys = Object.entries(CONTEXT_ATTRIBUTES)
  .filter(([, e]) => e.blocked)
  .map(([k]) => k);

describe("context-attribute producer gate", () => {
  it("the repo is clean", () => {
    expect(findViolations(scan)).toEqual([]);
  });

  it("catches a declared producer that stops writing — the F-029 regression", () => {
    const withoutStamp = {
      reads: scan.reads,
      writes: scan.writes.filter((w) => w.key !== "stepUpRecent"),
    };
    const v = findViolations(withoutStamp);
    expect(v).toContainEqual(
      expect.objectContaining({ kind: "producer-missing", key: "stepUpRecent" }),
    );
  });

  it("catches a key that is read but declared nowhere", () => {
    const withNewRead = {
      reads: [...scan.reads, { file: "apps/backend/src/x.ts", line: 1, key: "brandNewFact" }],
      writes: scan.writes,
    };
    expect(findViolations(withNewRead)).toContainEqual(
      expect.objectContaining({ kind: "undeclared", key: "brandNewFact" }),
    );
  });

  it("catches a blocked key that gains a writer, so an entry cannot outlive its reason", () => {
    // The example is taken FROM the registry rather than hard-coded. Naming one broke this test twice as
    // the F-030 work retired blocked keys out from under it (`licensure`, then `disciplines`) — and a test
    // that fails because the thing it named got FIXED reports a regression where there is none.
    for (const key of blockedKeys) {
      const withWrite = {
        reads: scan.reads,
        writes: [...scan.writes, { file: "apps/backend/src/x.ts", line: 1, key }],
      };
      expect(findViolations(withWrite)).toContainEqual(
        expect.objectContaining({ kind: "blocker-stale", key }),
      );
    }
  });

  it("still has blocked keys to check that rule against — an empty registry would vacuously pass", () => {
    // When the last blocked entry goes, the loop above stops asserting anything. That is the good outcome,
    // but it must be a deliberate edit here rather than a test that quietly stops testing.
    expect(blockedKeys.length).toBe(1);
  });

  it("every entry is exactly one of producer or blocked, and says something", () => {
    for (const [key, entry] of Object.entries(CONTEXT_ATTRIBUTES)) {
      expect(Boolean(entry.producer) !== Boolean(entry.blocked), key).toBe(true);
      expect((entry.producer ?? entry.blocked ?? "").length, key).toBeGreaterThan(40);
    }
  });

  // ── scanner shapes. Each of these is a real idiom in the tree; if the scanner stops resolving one,
  //    the keys behind it go silently unchecked, which is the failure mode of the gate itself.
  it("resolves a key read through an imported constant", () => {
    // `attributes[REVIEW_FLOOR_OVERRIDE_ATTRIBUTE]` is read in M14's routes and DECLARED in its
    // predicate file — so constants must resolve across files, not per file.
    expect(keysRead.has("idg.reviewFloorOverrideAuthorized")).toBe(true);
    expect(keysWritten.has("idg.reviewFloorOverrideAuthorized")).toBe(true);
  });

  it("resolves a key written through a SCREAMING_CASE identifier index", () => {
    // `ctx.attributes[BREAK_GLASS_ATTRIBUTE] = grant.eventId` — the form both in-request producers
    // use. Matching only `.key` and `["literal"]` reported these as producer-missing.
    expect(keysWritten.has("breakGlassEventId")).toBe(true);
  });

  it("resolves keys read through a whole-bag alias", () => {
    // `const attrs = ctx.attributes ?? {}` then `attrs.sessionPatientId` — M31's `actorOf`. Two of
    // the unproduced keys are read only this way, so without alias resolution the gate would have
    // called their registry entries unused and been wrong.
    expect(keysRead.has("sessionPatientId")).toBe(true);
    expect(keysRead.has("portalAccountId")).toBe(true);
  });

  it("does not count a test's own fake authenticate hook as a producer", () => {
    // This is the whole reason the four historical instances were invisible: each suite wrote the
    // attribute itself. Counting those would make the gate agree with the bug.
    expect(scan.writes.filter((w) => w.file.includes("__tests__"))).toEqual([]);
    expect(scan.writes.filter((w) => w.file.endsWith(".test.ts"))).toEqual([]);
  });

  it("`systemPrincipal` is gone — one fact, one name", () => {
    // It was a second name for `actorKind === "system"`: the name that was stamped and the name that
    // was checked were different, so M23's seam predicate and M25's internal routes refused every
    // caller. The readers now use `actorKind`, so nothing reads `systemPrincipal` at all.
    expect(keysRead.has("systemPrincipal")).toBe(false);
    expect("systemPrincipal" in CONTEXT_ATTRIBUTES).toBe(false);
    expect(keysRead.has("actorKind")).toBe(true);
    expect(keysWritten.has("actorKind")).toBe(true);
  });
});
