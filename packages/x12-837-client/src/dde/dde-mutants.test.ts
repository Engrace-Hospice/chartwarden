// The DDE conformance suite must have teeth (as the clearinghouse suite does): a provider that breaks one rule has to
// fail the case that guards it. Each mutant wraps the in-memory reference and breaks exactly one behaviour.
import { describe, expect, it } from "vitest";
import { type DdeHarness, runDdeConformance } from "./conformance";
import { createInMemoryDdeHarness } from "./in-memory-provider";
import { DDE, type DdeAccessProvider } from "./types";

function mutant(patch: (base: DdeAccessProvider) => Partial<DdeAccessProvider>) {
  return (): DdeHarness => {
    const base = createInMemoryDdeHarness();
    const patched = Object.assign(Object.create(base.provider), patch(base.provider));
    return { provider: patched as DdeAccessProvider, script: base.script };
  };
}

const failedIds = async (make: () => DdeHarness): Promise<string[]> =>
  (await runDdeConformance(make)).filter((o) => !o.passed).map((o) => o.id);

describe("DDE conformance suite catches broken providers", () => {
  it("flags a feed that mislabels the operation an outcome answers (D14)", async () => {
    const ids = await failedIds(
      mutant((p) => ({
        fetchOutcomes: async (ctx, cursor) => {
          const r = await p.fetchOutcomes(ctx, cursor);
          return r.ok
            ? {
                ok: true,
                data: {
                  ...r.data,
                  items: r.data.items.map((o) => ({ ...o, providerReference: "someone-else" })),
                },
              }
            : r;
        },
      })),
    );
    expect(ids).toContain("D14");
  });

  it("flags a feed whose event ids change between reads (D14)", async () => {
    let n = 0;
    const ids = await failedIds(
      mutant((p) => ({
        fetchOutcomes: async (ctx, cursor) => {
          const r = await p.fetchOutcomes(ctx, cursor);
          return r.ok
            ? {
                ok: true,
                data: {
                  ...r.data,
                  items: r.data.items.map((o) => ({ ...o, eventId: `fresh-${++n}` })),
                },
              }
            : r;
        },
      })),
    );
    expect(ids).toContain("D14");
  });

  it("flags a feed that drops the FISS reason codes (D14)", async () => {
    const ids = await failedIds(
      mutant((p) => ({
        fetchOutcomes: async (ctx, cursor) => {
          const r = await p.fetchOutcomes(ctx, cursor);
          return r.ok
            ? {
                ok: true,
                data: { ...r.data, items: r.data.items.map((o) => ({ ...o, reasonCodes: [] })) },
              }
            : r;
        },
      })),
    );
    expect(ids).toContain("D14");
  });

  it("flags a feed that re-delivers events past the end (D9)", async () => {
    const ids = await failedIds(
      mutant((p) => ({
        fetchOutcomes: async (ctx) => p.fetchOutcomes(ctx, null),
      })),
    );
    expect(ids).toContain("D9");
  });

  it("flags a feed that serves one tenant's outcomes to another (D12)", async () => {
    const ids = await failedIds(
      mutant((p) => ({
        fetchOutcomes: async (ctx, cursor) =>
          p.fetchOutcomes(
            { ...ctx, organizationId: "org-conf", providerEntityId: "pe-conf", usage: "test" },
            cursor,
          ),
      })),
    );
    expect(ids).toContain("D12");
  });

  it("flags an unenrolled operator that can still read the feed (D10)", async () => {
    const ids = await failedIds(
      mutant((p) => ({
        fetchOutcomes: async (ctx, cursor) =>
          p.fetchOutcomes({ ...ctx, operatorMembershipId: "op-enrolled" }, cursor),
      })),
    );
    expect(ids).toContain("D10");
  });

  it("passes the unmodified reference", async () => {
    expect(await failedIds(() => createInMemoryDdeHarness())).toEqual([]);
    expect(DDE.OPERATOR_NOT_ENROLLED).toBe("DDE_OPERATOR_NOT_ENROLLED");
  });
});
