// The denial read model's payer (badge + action) is the guard's decision, batched: one M23 and one M24 lookup per page.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePayerKinds } from "../denial-payer";
import { medicaidClaimIdSet } from "../medicaid-claim-facts";

const ORG = "org-1";
afterEach(() => vi.restoreAllMocks());

function deps(m23: string[], m24: string[]) {
  const calls = { m23: [] as string[][], m24: [] as string[][] };
  return {
    calls,
    deps: {
      m23ExistingIds: async (_tx: unknown, ids: readonly string[]) => {
        calls.m23.push([...ids]);
        return new Set(ids.filter((i) => m23.includes(i)));
      },
      m24ClaimIds: async (_org: string, ids: readonly string[]) => {
        calls.m24.push([...ids]);
        return new Set(ids.filter((i) => m24.includes(i)));
      },
    },
  };
}

describe("resolvePayerKinds", () => {
  const rows = [
    { key: "a", adviceKind: "medicare", claimId: "c-med" },
    { key: "b", adviceKind: null, claimId: "c-m24" },
    { key: "c", adviceKind: null, claimId: "c-m23" },
    { key: "d", adviceKind: null, claimId: "c-none" },
    { key: "e", adviceKind: null, claimId: null },
    { key: "f", adviceKind: "medicaid", claimId: null },
    { key: "g", adviceKind: null, claimId: "c-m24" },
  ];

  it("applies the shared decision, with one M23 and one M24 lookup for the whole page", async () => {
    const d = deps(["c-m23"], ["c-m24"]);
    const out = await resolvePayerKinds({}, ORG, rows, d.deps);
    expect(Object.fromEntries(out)).toEqual({
      a: "medicare",
      b: "medicaid",
      c: "unknown",
      d: "unknown",
      e: "unknown",
      f: "medicaid",
      g: "medicaid",
    });
    expect(d.calls.m23).toHaveLength(1);
    expect(d.calls.m24).toHaveLength(1);
    // only unknown-advice rows with a claim are looked up (deduped), and M24 sees only what M23 missed
    expect([...d.calls.m23[0]!].sort()).toEqual(["c-m23", "c-m24", "c-none"]);
    expect([...d.calls.m24[0]!].sort()).toEqual(["c-m24", "c-none"]);
  });

  it("makes no lookup when every advice kind is known", async () => {
    const d = deps([], []);
    await resolvePayerKinds(
      {},
      ORG,
      [{ key: "a", adviceKind: "commercial", claimId: "x" }],
      d.deps,
    );
    expect(d.calls.m23).toHaveLength(0);
    expect(d.calls.m24).toHaveLength(0);
  });

  it("an M24 failure leaves the payer unknown (and logs), never an error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out = await resolvePayerKinds({}, ORG, rows, {
      m23ExistingIds: async () => new Set(),
      m24ClaimIds: async () => {
        throw new Error("seam down");
      },
    });
    expect(out.get("b")).toBe("unknown");
    expect(out.get("a")).toBe("medicare");
    const line = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(line).toMatchObject({ organizationId: ORG });
    expect(JSON.stringify(line)).not.toContain("c-m24");
  });

  it("an M23 failure leaves every unknown-advice row unknown, even a Medicaid claim", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out = await resolvePayerKinds({}, ORG, rows, {
      m23ExistingIds: async () => {
        throw new Error("db down");
      },
      m24ClaimIds: async (_o, ids) => new Set(ids),
    });
    expect(out.get("b")).toBe("unknown");
    expect(out.get("f")).toBe("medicaid");
  });
});

describe("medicaidClaimIdSet", () => {
  it("logs ids-free and returns an empty set when the seam throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const got = await medicaidClaimIdSet(ORG, ["c1"], () => ({
      medicaidClaimIds: async () => {
        throw new Error("nope");
      },
    }));
    expect(got.size).toBe(0);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("c1");
  });
});

describe("the read model computes payer one way only", () => {
  it("read-service-drizzle uses resolvePayerKinds and never decides a payer itself", () => {
    const src = readFileSync(join(__dirname, "../read-service-drizzle.ts"), "utf8");
    expect(src).toContain("resolvePayerKinds");
    for (const forbidden of [
      "denialPayerKind",
      "resolvePayerKind(",
      "claimContext",
      "medicaidClaimIds",
      "m23ClaimFactsPort",
    ]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });
});
