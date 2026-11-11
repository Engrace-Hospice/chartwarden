import { describe, expect, it, vi } from "vitest";
import { type BuildSpawn, runProjectBuild } from "../build-project-graph";

describe("build project graph", () => {
  it("builds packages first in batches of six, then applications separately", () => {
    const spawn = vi.fn<BuildSpawn>(() => ({ status: 0 }));
    const log = vi.fn();
    const projects = [
      "./apps/admin",
      ...Array.from({ length: 7 }, (_, index) => `./packages/p${index + 1}`),
      "./scripts",
    ];

    expect(runProjectBuild(projects, { NODE_OPTIONS: "--trace-warnings" }, spawn, log)).toBe(0);
    expect(spawn.mock.calls.map((call) => call[1])).toEqual([
      [
        "-b",
        "./packages/p1",
        "./packages/p2",
        "./packages/p3",
        "./packages/p4",
        "./packages/p5",
        "./packages/p6",
      ],
      ["-b", "./packages/p7"],
      ["-b", "./apps/admin"],
      ["-b", "./scripts"],
    ]);
    for (const call of spawn.mock.calls) {
      expect(call[2].env.NODE_OPTIONS).toBe("--trace-warnings --max-old-space-size=6144");
    }
    expect(log).toHaveBeenCalledTimes(4);
  });

  it("stops after the first failed batch", () => {
    const spawn = vi
      .fn<BuildSpawn>()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 2 });

    expect(runProjectBuild(["./apps/admin", "./apps/backend", "./apps/web"], {}, spawn)).toBe(2);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("throws a child-process spawn error", () => {
    const failure = new Error("tsc could not start");
    const spawn = vi.fn<BuildSpawn>(() => ({ error: failure, status: null }));

    expect(() => runProjectBuild(["./apps/admin"], {}, spawn)).toThrow(failure);
  });

  it("returns failure when TypeScript is terminated by a signal", () => {
    const spawn = vi.fn<BuildSpawn>(() => ({ signal: "SIGKILL", status: null }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(runProjectBuild(["./apps/admin"], {}, spawn)).toBe(1);
    expect(error).toHaveBeenCalledWith("TypeScript batch 1 received SIGKILL");
    error.mockRestore();
  });
});
