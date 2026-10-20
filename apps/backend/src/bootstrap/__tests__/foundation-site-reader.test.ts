import { describe, expect, it } from "vitest";
import { soleDefaultLocation } from "../foundation-site-reader";

describe("soleDefaultLocation", () => {
  it("defaults to the only active location", () => {
    expect(soleDefaultLocation([{ id: "a", status: "active" }])).toBe("a");
  });

  it("does not pick between several active locations", () => {
    const rows = [
      { id: "ipu", status: "active" },
      { id: "main", status: "active" },
    ];
    expect(soleDefaultLocation(rows)).toBeNull();
  });

  it("falls back to a single created location when none is active", () => {
    expect(soleDefaultLocation([{ id: "c", status: "created" }])).toBe("c");
  });

  it("prefers the one active location over created ones", () => {
    const rows = [
      { id: "c", status: "created" },
      { id: "a", status: "active" },
    ];
    expect(soleDefaultLocation(rows)).toBe("a");
  });

  it("is null with no candidates", () => {
    expect(soleDefaultLocation([])).toBeNull();
  });
});
