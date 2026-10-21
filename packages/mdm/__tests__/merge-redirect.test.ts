// @chartwarden/mdm — M40-T04 unit tests (spec §2.1, §7.1–7.2).
//
// Locks the transparent merge-redirect chase + the canonical+overlay join: a live canonical id
// resolves to itself with no breadcrumb (§7.1 fast path), a merged id resolves through to its
// survivor carrying `resolvedFrom` (§7.2), multi-hop chains follow transitively, and corrupt
// graphs (cycle / over-long chain / §2.5 status↔pointer violation / dangling survivor) fail
// loudly rather than redirect blindly. The sync (`resolveRedirect`) and async (`followMerge`)
// entry points must agree — both are the same chase over different loaders.
import { describe, expect, it } from "vitest";
import {
  type CanonicalRedirectRow,
  MAX_REDIRECT_DEPTH,
  type MergeRedirect,
  MergeRedirectError,
  followMerge,
  joinOverlay,
  resolveRedirect,
} from "../src/index";

// An in-memory canonical row set keyed by id — the test analog of T05's Drizzle loader. Each
// row carries just the §2.5 redirect projection (id, status, mergedIntoId).
function rowSet(rows: CanonicalRedirectRow[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const sync = (id: string): CanonicalRedirectRow | null => byId.get(id) ?? null;
  // eslint-disable-next-line @typescript-eslint/require-await
  const asyncLoad = async (_kind: unknown, id: string): Promise<CanonicalRedirectRow | null> =>
    byId.get(id) ?? null;
  return { sync, asyncLoad };
}

const live = (id: string): CanonicalRedirectRow => ({ id, status: "active", mergedIntoId: null });
const mergedInto = (id: string, into: string): CanonicalRedirectRow => ({
  id,
  status: "merged",
  mergedIntoId: into,
});

describe("merge-redirect chase (§7.1, §7.2)", () => {
  it("§7.1 a live canonical id resolves to itself with no breadcrumb", () => {
    const { sync } = rowSet([live("phys-1")]);
    const r = resolveRedirect(sync, "physician", "phys-1");
    expect(r).toEqual<MergeRedirect>({ id: "phys-1", status: "active" });
    expect(r?.resolvedFrom).toBeUndefined();
  });

  it("§7.2 a merged id resolves through to its survivor, carrying resolvedFrom", () => {
    const { sync } = rowSet([mergedInto("dup-1", "surv-1"), live("surv-1")]);
    const r = resolveRedirect(sync, "physician", "dup-1");
    expect(r).toEqual<MergeRedirect>({ id: "surv-1", resolvedFrom: "dup-1", status: "active" });
  });

  it("§7.2 follows a multi-hop chain (A→B→C) transitively to the final survivor", () => {
    const { sync } = rowSet([mergedInto("a", "b"), mergedInto("b", "c"), live("c")]);
    expect(resolveRedirect(sync, "physician", "a")).toEqual<MergeRedirect>({
      id: "c",
      resolvedFrom: "a",
      status: "active",
    });
  });

  it("propagates the survivor's terminal status (deactivated, never merged)", () => {
    const { sync } = rowSet([
      mergedInto("dup", "surv"),
      { id: "surv", status: "deactivated", mergedIntoId: null },
    ]);
    expect(resolveRedirect(sync, "physician", "dup")).toEqual<MergeRedirect>({
      id: "surv",
      resolvedFrom: "dup",
      status: "deactivated",
    });
  });

  it("returns null for an unknown / dangling id (no canonical row)", () => {
    const { sync } = rowSet([live("known")]);
    expect(resolveRedirect(sync, "physician", "nope")).toBeNull();
  });

  it("rejects a redirect cycle (A→B→A) rather than looping forever", () => {
    const { sync } = rowSet([mergedInto("a", "b"), mergedInto("b", "a")]);
    expect(() => resolveRedirect(sync, "physician", "a")).toThrow(MergeRedirectError);
    try {
      resolveRedirect(sync, "physician", "a");
    } catch (e) {
      expect((e as MergeRedirectError).reason).toBe("cycle");
    }
  });

  it("rejects a chain longer than MAX_REDIRECT_DEPTH as corruption", () => {
    // Build a straight chain of MAX_REDIRECT_DEPTH + 2 merged rows ending nowhere-live.
    const rows: CanonicalRedirectRow[] = [];
    const n = MAX_REDIRECT_DEPTH + 2;
    for (let i = 0; i < n; i++) rows.push(mergedInto(`n${i}`, `n${i + 1}`));
    rows.push(live(`n${n}`));
    const { sync } = rowSet(rows);
    try {
      resolveRedirect(sync, "physician", "n0");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MergeRedirectError);
      expect((e as MergeRedirectError).reason).toBe("max_depth");
    }
  });

  it("rejects a §2.5 invariant violation: status='merged' but mergedIntoId=null", () => {
    const { sync } = rowSet([{ id: "bad", status: "merged", mergedIntoId: null }]);
    try {
      resolveRedirect(sync, "physician", "bad");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as MergeRedirectError).reason).toBe("invariant");
    }
  });

  it("rejects a §2.5 invariant violation: mergedIntoId set but status≠merged", () => {
    const { sync } = rowSet([{ id: "bad", status: "active", mergedIntoId: "surv" }, live("surv")]);
    expect(() => resolveRedirect(sync, "physician", "bad")).toThrow(/invariant/);
  });

  it("rejects a dangling survivor pointer (merged row points at a missing canonical)", () => {
    const { sync } = rowSet([mergedInto("dup", "gone")]);
    try {
      resolveRedirect(sync, "physician", "dup");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as MergeRedirectError).reason).toBe("invariant");
    }
  });
});

describe("async followMerge parity (§7.2)", () => {
  it("agrees with resolveRedirect on a merged chain", async () => {
    const { sync, asyncLoad } = rowSet([mergedInto("a", "b"), mergedInto("b", "c"), live("c")]);
    expect(await followMerge(asyncLoad, "physician", "a")).toEqual(
      resolveRedirect(sync, "physician", "a"),
    );
  });

  it("returns null for an unknown id over the async loader", async () => {
    const { asyncLoad } = rowSet([live("x")]);
    expect(await followMerge(asyncLoad, "physician", "missing")).toBeNull();
  });

  it("surfaces cycles over the async loader too", async () => {
    const { asyncLoad } = rowSet([mergedInto("a", "b"), mergedInto("b", "a")]);
    await expect(followMerge(asyncLoad, "physician", "a")).rejects.toBeInstanceOf(
      MergeRedirectError,
    );
  });
});

describe("overlay join (§2.1, §2.3)", () => {
  const directHit: MergeRedirect = { id: "surv", status: "active" };
  const redirected: MergeRedirect = { id: "surv", resolvedFrom: "dup", status: "active" };

  it("attaches canonical + overlay payloads, defaulting overlay to null (§2.3)", () => {
    const resolved = joinOverlay(directHit, { npi: "1234567893" }, null);
    expect(resolved).toEqual({
      id: "surv",
      canonical: { npi: "1234567893" },
      overlay: null,
      status: "active",
    });
    expect(resolved.resolvedFrom).toBeUndefined();
  });

  it("carries this tenant's overlay opinion when present", () => {
    const resolved = joinOverlay(directHit, { npi: "1" }, { doNotRefer: true });
    expect(resolved.overlay).toEqual({ doNotRefer: true });
  });

  it("propagates the §7.2 resolvedFrom breadcrumb verbatim", () => {
    const resolved = joinOverlay(redirected, { npi: "1" }, null);
    expect(resolved.resolvedFrom).toBe("dup");
    expect(resolved.id).toBe("surv");
  });
});
