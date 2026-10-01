/**
 * M14 packet-build worker — §2.4 cover `nextRecertDueAt` / `f2fWindowState` resolution from the M6
 * `idgRecertWindowsForOrg` seam (fake port; the real seam is proven live in m14-packet-build.live.test.ts).
 * Fail-honest: unknown / absent / throwing / malformed ⇒ null, never a guess and never a thrown error.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type Idg6RecertWindowFact,
  type Idg6RecertWindowPort,
  resolveRecertCoverFacts,
} from "../src/modules/14-idg/jobs/packet-build";

const ASOF = new Date("2026-09-29T12:00:00.000Z");
const fact = (over: Partial<Idg6RecertWindowFact>): Idg6RecertWindowFact => ({
  nextRecertDueDate: "2026-10-15",
  f2fWindowState: "window_open",
  ...over,
});
const portOf = (m: Map<string, Idg6RecertWindowFact>): Idg6RecertWindowPort => ({
  recertWindowsForOrg: async () => m,
});

describe("resolveRecertCoverFacts", () => {
  it("maps a known window to the cover enum + an ISO instant", async () => {
    const warn = vi.fn();
    const out = await resolveRecertCoverFacts(
      portOf(new Map([["p1", fact({ f2fWindowState: "overdue" })]])),
      "org",
      ["p1"],
      ASOF,
      warn,
    );
    expect(out.get("p1")).toEqual({
      nextRecertDueAt: "2026-10-15T00:00:00.000Z",
      f2fWindowState: "overdue",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps unknown (null) fields null and omits patients absent from the seam", async () => {
    const out = await resolveRecertCoverFacts(
      portOf(new Map([["p1", fact({ nextRecertDueDate: null, f2fWindowState: null })]])),
      "org",
      ["p1", "p2"],
      ASOF,
      vi.fn(),
    );
    expect(out.get("p1")).toEqual({ nextRecertDueAt: null, f2fWindowState: null });
    expect(out.has("p2")).toBe(false);
  });

  it("drops malformed / unrecognised values instead of passing them through", async () => {
    const out = await resolveRecertCoverFacts(
      portOf(
        new Map([["p1", fact({ nextRecertDueDate: "soon", f2fWindowState: "missed" as never })]]),
      ),
      "org",
      ["p1"],
      ASOF,
      vi.fn(),
    );
    expect(out.get("p1")).toEqual({ nextRecertDueAt: null, f2fWindowState: null });
  });

  it("a throwing seam is logged and yields no facts (never rejects)", async () => {
    const warn = vi.fn();
    const out = await resolveRecertCoverFacts(
      {
        recertWindowsForOrg: async () => {
          throw new Error("db down");
        },
      },
      "org",
      ["p1"],
      ASOF,
      warn,
    );
    expect(out.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      "m14.packet_build.recert_windows_unavailable",
      expect.objectContaining({ organizationId: "org", error: "db down" }),
    );
  });

  it("no port bound / no patients ⇒ empty, no call", async () => {
    expect((await resolveRecertCoverFacts(undefined, "o", ["p"], ASOF, vi.fn())).size).toBe(0);
    const spy = vi.fn();
    await resolveRecertCoverFacts({ recertWindowsForOrg: spy }, "o", [], ASOF, vi.fn());
    expect(spy).not.toHaveBeenCalled();
  });

  it("passes org + asOf through and chunks past the seam's 500-patient cap", async () => {
    const calls: { n: number; asOf: string; org: string }[] = [];
    const ids = Array.from({ length: 1001 }, (_, i) => `p${i}`);
    await resolveRecertCoverFacts(
      {
        recertWindowsForOrg: async (org, p, asOf) => {
          calls.push({ n: p.length, asOf, org });
          return new Map();
        },
      },
      "orgX",
      ids,
      ASOF,
      vi.fn(),
    );
    expect(calls.map((c) => c.n)).toEqual([500, 500, 1]);
    expect(calls[0]).toMatchObject({ org: "orgX", asOf: ASOF.toISOString() });
  });
});
