import { describe, expect, it, vi } from "vitest";
import { resolveBoundedNodeOptions } from "../node-heap-policy";
import { type TypecheckSpawn, runTestTypecheck } from "../run-test-typecheck";

describe("Node heap policy", () => {
  it("uses the bounded default when NODE_OPTIONS is unset or blank", () => {
    expect(resolveBoundedNodeOptions({})).toBe("--max-old-space-size=6144");
    expect(resolveBoundedNodeOptions({ NODE_OPTIONS: "   " })).toBe("--max-old-space-size=6144");
  });

  it("preserves non-heap options and appends the bounded default", () => {
    expect(resolveBoundedNodeOptions({ NODE_OPTIONS: "--trace-warnings" })).toBe(
      "--trace-warnings --max-old-space-size=6144",
    );
  });

  it("preserves an explicit inherited heap limit", () => {
    expect(resolveBoundedNodeOptions({ NODE_OPTIONS: "--max-old-space-size=5120" })).toBe(
      "--max-old-space-size=5120",
    );
    expect(resolveBoundedNodeOptions({ NODE_OPTIONS: "--max_old_space_size 4608" })).toBe(
      "--max_old_space_size 4608",
    );
  });

  it("lets a nonblank build override take precedence and remain bounded", () => {
    expect(
      resolveBoundedNodeOptions(
        {
          NODE_OPTIONS: "--max-old-space-size=5120",
          BUILD_NODE_OPTIONS: "--trace-gc",
        },
        "BUILD_NODE_OPTIONS",
      ),
    ).toBe("--trace-gc --max-old-space-size=6144");
  });

  it("passes the resolved policy to both test TypeScript programs", () => {
    const spawn = vi.fn<TypecheckSpawn>(() => ({ status: 0 }));

    expect(runTestTypecheck({ NODE_OPTIONS: "--trace-warnings" }, spawn)).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls.map((call) => call[1])).toEqual([
      ["-p", "tsconfig.tests.json", "--pretty"],
      ["-p", "tsconfig.tests.dom.json", "--pretty"],
    ]);
    for (const call of spawn.mock.calls) {
      expect(call[2].env.NODE_OPTIONS).toBe("--trace-warnings --max-old-space-size=6144");
    }
  });

  it("throws a child-process spawn error", () => {
    const failure = new Error("tsc could not start");
    const spawn = vi.fn<TypecheckSpawn>(() => ({ error: failure, status: null }));

    expect(() => runTestTypecheck({}, spawn)).toThrow(failure);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("returns a nonzero TypeScript exit status without starting the second program", () => {
    const spawn = vi.fn<TypecheckSpawn>(() => ({ status: 2 }));

    expect(runTestTypecheck({}, spawn)).toBe(2);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("returns failure when TypeScript is terminated by a signal", () => {
    const spawn = vi.fn<TypecheckSpawn>(() => ({ signal: "SIGKILL", status: null }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(runTestTypecheck({}, spawn)).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      "TypeScript test program tsconfig.tests.json received SIGKILL",
    );
    error.mockRestore();
  });
});
