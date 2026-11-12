// Typecheck the test tree in bounded programs. A single program for every Node test needs more
// memory than the production CI runner owns and is eventually OOM-killed; each shard still uses
// the authoritative root set from the checked-in test tsconfigs.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { resolveBoundedNodeOptions } from "./node-heap-policy";

const TEST_PROGRAMS = ["tsconfig.tests.json", "tsconfig.tests.dom.json"] as const;
const DEFAULT_SHARD_SIZE = 250;

interface SpawnResult {
  readonly error?: Error;
  readonly signal?: NodeJS.Signals | null;
  readonly status: number | null;
}

export type TypecheckSpawn = (
  command: string,
  args: string[],
  options: { readonly stdio: "inherit"; readonly env: NodeJS.ProcessEnv },
) => SpawnResult;

export function shardFiles(files: readonly string[], size = DEFAULT_SHARD_SIZE): string[][] {
  if (!Number.isSafeInteger(size) || size < 1)
    throw new Error("test typecheck shard size must be positive");
  const sorted = [...files].sort();
  const shards: string[][] = [];
  for (let index = 0; index < sorted.length; index += size)
    shards.push(sorted.slice(index, index + size));
  return shards;
}

function testRoots(configPath: string): string[] {
  const loaded = ts.readConfigFile(configPath, (path) => readFileSync(path, "utf8"));
  if (loaded.error) {
    throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
        .join("\n"),
    );
  }
  return parsed.fileNames;
}

export function runTestTypecheck(
  root = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  spawn: TypecheckSpawn = spawnSync,
  log: (message: string) => void = console.log,
): number {
  const requestedSize = env.TEST_TYPECHECK_SHARD_SIZE
    ? Number.parseInt(env.TEST_TYPECHECK_SHARD_SIZE, 10)
    : DEFAULT_SHARD_SIZE;
  const childEnv = {
    ...env,
    NODE_OPTIONS: resolveBoundedNodeOptions(env, "TEST_TYPECHECK_NODE_OPTIONS"),
  };
  // Keep generated configs under the ignored dependency tree so TypeScript resolves `types` from
  // this repository and an interrupted parent process cannot dirty the worktree.
  const temporaryRoot = join(root, "node_modules", ".cache");
  mkdirSync(temporaryRoot, { recursive: true });
  const temporaryDirectory = mkdtempSync(join(temporaryRoot, "chartwarden-test-typecheck-"));

  try {
    for (const program of TEST_PROGRAMS) {
      const configPath = resolve(root, program);
      const shards = shardFiles(testRoots(configPath), requestedSize);
      for (const [index, files] of shards.entries()) {
        const shardPath = join(temporaryDirectory, `${program}.${index + 1}.json`);
        writeFileSync(
          shardPath,
          `${JSON.stringify({ extends: configPath, files, include: [], exclude: [] }, null, 2)}\n`,
        );
        log(`${program} shard ${index + 1}/${shards.length}: ${files.length} test files`);
        const result = spawn("tsc", ["-p", shardPath, "--pretty"], {
          stdio: "inherit",
          env: childEnv,
        });
        if (result.error) throw result.error;
        if (result.signal) console.error(`${program} shard ${index + 1} received ${result.signal}`);
        if (result.status !== 0) return result.status ?? 1;
      }
    }
    return 0;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(runTestTypecheck());
