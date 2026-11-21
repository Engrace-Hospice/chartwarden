import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type TypecheckSpawn, runTestTypecheck, shardFiles } from "../typecheck-test-shards";

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "chartwarden-test-typecheck-fixture-"));
  mkdirSync(join(root, "tests"));
  for (const file of ["node-a.test.ts", "node-b.test.ts", "node-c.test.ts", "dom.test.tsx"]) {
    writeFileSync(join(root, "tests", file), "export {};\n");
  }
  const config = (include: string[]) =>
    `${JSON.stringify({ compilerOptions: { noEmit: true }, include }, null, 2)}\n`;
  writeFileSync(
    join(root, "tsconfig.tests.json"),
    config(["tests/node-a.test.ts", "tests/node-b.test.ts", "tests/node-c.test.ts"]),
  );
  writeFileSync(join(root, "tsconfig.tests.dom.json"), config(["tests/dom.test.tsx"]));
  return root;
}

function generatedDirectories(root: string): string[] {
  const cache = join(root, "node_modules", ".cache");
  try {
    return readdirSync(cache).filter((name) => name.startsWith("chartwarden-test-typecheck-"));
  } catch {
    return [];
  }
}

describe("test typecheck shards", () => {
  it("sorts files into deterministic bounded shards", () => {
    expect(shardFiles(["c.test.ts", "a.test.ts", "b.test.ts"], 2)).toEqual([
      ["a.test.ts", "b.test.ts"],
      ["c.test.ts"],
    ]);
  });

  it("rejects an invalid shard size", () => {
    expect(() => shardFiles(["a.test.ts"], 0)).toThrow("must be positive");
  });

  it("runs every resolved root exactly once, in program and shard order, with the bounded heap", () => {
    const root = fixtureRoot();
    const shardRoots: string[][] = [];
    const spawn = vi.fn<TypecheckSpawn>((_command, args) => {
      const generated = JSON.parse(readFileSync(args[1] ?? "", "utf8")) as { files: string[] };
      shardRoots.push(generated.files);
      return { status: 0 };
    });

    try {
      expect(
        runTestTypecheck(
          root,
          {
            TEST_TYPECHECK_SHARD_SIZE: "2",
            TEST_TYPECHECK_NODE_OPTIONS: "--max-old-space-size=2048",
          },
          spawn,
          vi.fn(),
        ),
      ).toBe(0);
      expect(shardRoots.map((files) => files.map((file) => file.split("/").at(-1)))).toEqual([
        ["node-a.test.ts", "node-b.test.ts"],
        ["node-c.test.ts"],
        ["dom.test.tsx"],
      ]);
      expect(spawn).toHaveBeenCalledTimes(3);
      for (const call of spawn.mock.calls) {
        expect(call[0]).toBe("tsc");
        expect(call[2].env.NODE_OPTIONS).toBe("--max-old-space-size=2048");
      }
      expect(generatedDirectories(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops on a failed shard and removes its generated configs", () => {
    const root = fixtureRoot();
    const spawn = vi.fn<TypecheckSpawn>(() => ({ status: 2 }));
    try {
      expect(runTestTypecheck(root, { TEST_TYPECHECK_SHARD_SIZE: "1" }, spawn, vi.fn())).toBe(2);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(generatedDirectories(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cleans up and propagates a spawn error", () => {
    const root = fixtureRoot();
    const failure = new Error("tsc could not start");
    const spawn = vi.fn<TypecheckSpawn>(() => ({ error: failure, status: null }));
    try {
      expect(() => runTestTypecheck(root, {}, spawn, vi.fn())).toThrow(failure);
      expect(generatedDirectories(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails a shard the OS kills twice, and removes its generated configs", () => {
    const root = fixtureRoot();
    const spawn = vi.fn<TypecheckSpawn>(() => ({ signal: "SIGKILL", status: null }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(runTestTypecheck(root, {}, spawn, vi.fn())).toBe(1);
      expect(error).toHaveBeenCalledWith("tsconfig.tests.json shard 1 received SIGKILL");
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(generatedDirectories(root)).toEqual([]);
    } finally {
      error.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries a SIGKILLed shard once on the same config, then carries on", () => {
    const root = fixtureRoot();
    const shardConfigs: string[] = [];
    let killed = false;
    const spawn = vi.fn<TypecheckSpawn>((_command, args) => {
      shardConfigs.push(args[1] ?? "");
      if (!killed && shardConfigs.length === 2) {
        killed = true;
        return { signal: "SIGKILL", status: null };
      }
      return { status: 0 };
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.fn();
    try {
      expect(runTestTypecheck(root, { TEST_TYPECHECK_SHARD_SIZE: "2" }, spawn, log)).toBe(0);
      // shard 1, shard 2 (killed), shard 2 again, then the dom program's shard.
      expect(spawn).toHaveBeenCalledTimes(4);
      expect(shardConfigs[2]).toBe(shardConfigs[1]);
      expect(shardConfigs[0]).not.toBe(shardConfigs[1]);
      expect(error).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("retrying once"));
      expect(generatedDirectories(root)).toEqual([]);
    } finally {
      error.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not retry a shard that aborts on its own (SIGABRT is a heap limit, not memory pressure)", () => {
    const root = fixtureRoot();
    const spawn = vi.fn<TypecheckSpawn>(() => ({ signal: "SIGABRT", status: null }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(runTestTypecheck(root, {}, spawn, vi.fn())).toBe(1);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not retry a shard that fails with a type error", () => {
    const root = fixtureRoot();
    const spawn = vi.fn<TypecheckSpawn>(() => ({ status: 2 }));
    try {
      expect(runTestTypecheck(root, {}, spawn, vi.fn())).toBe(2);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
