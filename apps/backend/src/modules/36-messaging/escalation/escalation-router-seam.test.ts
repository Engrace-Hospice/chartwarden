import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createInMemoryEscalationRouter } from "@wardenx/messaging";
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

const SRC_ROOT = join(__dirname, "..", "..", "..");

function productionSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return productionSourceFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

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

  it("is wired only through the seam registry: no production file imports the fake or registers a router from M36", () => {
    const offenders = productionSourceFiles(SRC_ROOT)
      .map((file) => ({ file: relative(SRC_ROOT, file), text: readFileSync(file, "utf8") }))
      .filter(
        ({ text }) =>
          text.includes("in-memory-escalation-router") ||
          text.includes("createInMemoryEscalationRouter"),
      )
      .map(({ file }) => file);
    expect(offenders).toEqual([]);

    const registrars = productionSourceFiles(SRC_ROOT)
      .map((file) => ({ file: relative(SRC_ROOT, file), text: readFileSync(file, "utf8") }))
      .filter(({ text }) => /registerSeam\(\s*"EscalationRouter"/.test(text))
      .map(({ file }) => file);
    expect(registrars).toEqual([]);
  });

  it("resolves the router only through getEscalationRouter, never an ad hoc getSeam in another file", () => {
    const callers = productionSourceFiles(SRC_ROOT)
      .map((file) => ({ file: relative(SRC_ROOT, file), text: readFileSync(file, "utf8") }))
      .filter(({ text }) => /getSeam\(\s*"EscalationRouter"/.test(text))
      .map(({ file }) => file);
    expect(callers).toEqual(["modules/36-messaging/seams.ts"]);
  });
});
