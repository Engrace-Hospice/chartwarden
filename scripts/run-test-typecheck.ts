import { spawnSync } from "node:child_process";
import { resolveBoundedNodeOptions } from "./node-heap-policy";

interface TypecheckResult {
  readonly error?: Error;
  readonly signal?: NodeJS.Signals | null;
  readonly status: number | null;
}

export type TypecheckSpawn = (
  command: string,
  args: string[],
  options: { readonly stdio: "inherit"; readonly env: NodeJS.ProcessEnv },
) => TypecheckResult;

const TEST_PROGRAMS = ["tsconfig.tests.json", "tsconfig.tests.dom.json"] as const;

export function runTestTypecheck(
  env: NodeJS.ProcessEnv = process.env,
  spawn: TypecheckSpawn = spawnSync,
): number {
  const childEnv = { ...env, NODE_OPTIONS: resolveBoundedNodeOptions(env) };
  for (const project of TEST_PROGRAMS) {
    const result = spawn("tsc", ["-p", project, "--pretty"], { stdio: "inherit", env: childEnv });
    if (result.error) throw result.error;
    if (result.signal)
      console.error(`TypeScript test program ${project} received ${result.signal}`);
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (import.meta.main) process.exit(runTestTypecheck());
