// Build every root project reference in bounded processes. TypeScript's build mode retains
// project state for the lifetime of one process; on the CI runner the full graph was OOM-killed.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolveBoundedNodeOptions } from "./node-heap-policy";

interface BuildResult {
  readonly error?: Error;
  readonly signal?: NodeJS.Signals | null;
  readonly status: number | null;
}

export type BuildSpawn = (
  command: string,
  args: string[],
  options: { readonly stdio: "inherit"; readonly env: NodeJS.ProcessEnv },
) => BuildResult;

function projectBatches(projects: readonly string[]): string[][] {
  const batches: string[][] = [];
  let packageBatch: string[] = [];
  for (const project of projects) {
    if (project.startsWith("./packages/")) {
      packageBatch.push(project);
      if (packageBatch.length === 6) {
        batches.push(packageBatch);
        packageBatch = [];
      }
    } else {
      if (packageBatch.length) batches.push(packageBatch);
      packageBatch = [];
      batches.push([project]);
    }
  }
  if (packageBatch.length) batches.push(packageBatch);
  return batches;
}

export function runProjectBuild(
  projects: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  spawn: BuildSpawn = spawnSync,
  log: (message: string) => void = console.log,
): number {
  const batches = projectBatches(projects);
  const childEnv = { ...env, NODE_OPTIONS: resolveBoundedNodeOptions(env, "BUILD_NODE_OPTIONS") };
  for (const [index, batch] of batches.entries()) {
    log(`TypeScript batch ${index + 1}/${batches.length}: ${batch.join(", ")}`);
    const result = spawn("tsc", ["-b", ...batch], { stdio: "inherit", env: childEnv });
    if (result.error) throw result.error;
    if (result.signal) console.error(`TypeScript batch ${index + 1} received ${result.signal}`);
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (import.meta.main) {
  const root = JSON.parse(readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8")) as {
    references: Array<{ path: string }>;
  };
  process.exit(runProjectBuild(root.references.map(({ path }) => path)));
}
