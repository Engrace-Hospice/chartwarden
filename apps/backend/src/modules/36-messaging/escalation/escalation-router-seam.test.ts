import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createInMemoryEscalationRouter } from "@chartwarden/messaging/testing/in-memory-escalation-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, registerSeam, validateSeams } from "../../../bootstrap/index";
import { getEscalationRouter } from "../seams";

const ORG = "00000000-0000-4000-8000-00000000000a";
const REQUEST = {
  patientId: "00000000-0000-4000-8000-0000000000f1",
  requiredRole: "rn",
  tier: 1,
  asOf: "2026-06-01T16:00:00Z",
};

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");
const SCAN_DIRS = [join(REPO_ROOT, "apps"), join(REPO_ROOT, "packages")];
const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", ".vite", "coverage"]);
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /(?:\.test\.|\.spec\.|__tests__)/;
/** The fake's own files and this guard are the only places allowed to name the fake. */
const FAKE_FILES = ["in-memory-escalation-router", "escalation-router-seam.test"];

function productionSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIPPED_DIRS.has(name)) return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return productionSourceFiles(full);
    const isProduction = SOURCE_FILE.test(name) && !TEST_FILE.test(full);
    return isProduction && !FAKE_FILES.some((f) => full.includes(f)) ? [full] : [];
  });
}

const allProduction = () =>
  SCAN_DIRS.flatMap(productionSourceFiles).map((file) => ({
    file: relative(REPO_ROOT, file),
    text: readFileSync(file, "utf8"),
  }));

describe("EscalationRouter seam (M36 -> M19)", () => {
  beforeEach(() => __resetSeamsForTest());
  afterEach(() => __resetSeamsForTest());

  it("answers unavailable from the deny-stub when no M19 router is bound", async () => {
    validateSeams();
    const answer = await getEscalationRouter().resolveTier(ORG, REQUEST);
    expect(answer).toEqual({
      kind: "unavailable",
      reason: "router_not_bound",
      tier: 1,
      asOf: REQUEST.asOf,
      source: "deny_stub",
    });
  });

  it("never names a recipient, a coverage gap or an empty list for any tier or role", async () => {
    validateSeams();
    for (const tier of [1, 2, 5]) {
      for (const requiredRole of ["rn", "md", "anything"]) {
        const answer = await getEscalationRouter().resolveTier(ORG, {
          ...REQUEST,
          tier,
          requiredRole,
        });
        expect(answer.kind).toBe("unavailable");
        expect(answer).not.toHaveProperty("userIds");
        expect(answer.source).toBe("deny_stub");
      }
    }
  });

  it("returns whatever router is registered, through the registry (the real M19 binding path)", async () => {
    registerSeam(
      "EscalationRouter",
      createInMemoryEscalationRouter({
        orgId: ORG,
        ladders: [
          {
            role: "rn",
            tiers: [
              {
                tier: 1,
                rotations: [
                  {
                    timeZone: "America/New_York",
                    windows: [{ startTime: "07:00", endTime: "19:00" }],
                    userIds: ["u1"],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    validateSeams();
    const answer = await getEscalationRouter().resolveTier(ORG, REQUEST);
    expect(answer).toMatchObject({ kind: "resolved", userIds: ["u1"], source: "in_memory_fake" });
  });

  it("is wired only through the seam registry: no production file in apps/ or packages/ names the fake", () => {
    const offenders = allProduction()
      .filter(
        ({ text }) =>
          text.includes("in-memory-escalation-router") ||
          text.includes("createInMemoryEscalationRouter"),
      )
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("M36 never registers the router: inside modules/36-messaging every registerSeam names another seam by literal", () => {
    const REGISTER = /registerSeam\s*(?:<[^>]*>)?\s*\(\s*([^,)]*)/g;
    const offenders: string[] = [];
    for (const { file, text } of allProduction()) {
      if (!file.includes("modules/36-messaging/")) continue;
      for (const match of text.matchAll(REGISTER)) {
        const arg = (match[1] ?? "").trim();
        const literal = /^["']([A-Za-z]+)["']$/.exec(arg)?.[1];
        if (literal === undefined || literal === "EscalationRouter")
          offenders.push(`${file}: registerSeam(${arg})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("resolves the router only through getEscalationRouter, never an ad hoc getSeam in another file", () => {
    const callers = allProduction()
      .filter(({ text }) => /getSeam\s*(?:<[^>]*>)?\s*\(\s*["']EscalationRouter["']/.test(text))
      .map(({ file }) => file);
    expect(callers).toEqual(["apps/backend/src/modules/36-messaging/seams.ts"]);
  });

  it("keeps the raw seam unwrapped for now: getEscalationRouter is the registry entry itself (WP 4.4 adds the org-checking wrapper)", () => {
    const fake = createInMemoryEscalationRouter({ orgId: ORG, ladders: [] });
    registerSeam("EscalationRouter", fake);
    validateSeams();
    expect(getEscalationRouter()).toBe(fake);
  });
});
