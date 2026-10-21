#!/usr/bin/env bun
/**
 * ChartWarden — error-envelope gate (GAP-175)
 * ---------------------------------------------------------------------------
 * M1 §4.3 defines ONE error envelope `{ error: { code, message, details?, correlationId } }`, rendered
 * by the M1 error handler for every thrown `ChartWardenError`. A route that answers a failure with
 * `reply.code(4xx).send({ error: "snake_case" })` or a bare `{ code, message }` skips the handler, so
 * the response has no `correlationId` and a different shape from every other error on the platform
 * (38 such sites in M02/M12/M29/M33/M37 when this gate was written).
 *
 * WHAT IT ENFORCES. No non-test backend source file passes `{ error: "<string>" ... }` or
 * `{ code: ... }` as the BODY of a `.send(...)`. Throw a `ChartWardenError` subclass instead. If a flat
 * body is ever legitimate, add the file to ALLOWED with a reason.
 *
 * Run:  bun run arch:error-envelope   (in `arch:fitness`)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** file -> reason. Empty: there is no sanctioned flat error body. */
export const ALLOWED: Readonly<Record<string, string>> = {};

const FLAT_ERROR_BODY = /\.send\(\s*\{\s*(?:error\s*:\s*["'`]|code\s*:)/g;

export interface FlatErrorHit {
  readonly file: string;
  readonly line: number;
}

/** Pure scan of one file's text. */
export function findFlatErrorBodies(file: string, text: string): FlatErrorHit[] {
  if (ALLOWED[file] !== undefined) return [];
  const hits: FlatErrorHit[] = [];
  for (const m of text.matchAll(FLAT_ERROR_BODY)) {
    const line = text.slice(0, m.index).split("\n").length;
    hits.push({ file, line });
  }
  return hits;
}

function isScanned(path: string): boolean {
  return (
    path.startsWith("apps/backend/src/") &&
    path.endsWith(".ts") &&
    !path.includes("/__tests__/") &&
    !/\.test\.ts$/.test(path)
  );
}

export function scanRepo(): FlatErrorHit[] {
  const files = execFileSync("git", ["ls-files", "apps/backend/src"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(isScanned);
  return files.flatMap((f) => findFlatErrorBodies(f, readFileSync(join(REPO_ROOT, f), "utf8")));
}

if (import.meta.main) {
  const hits = scanRepo();
  if (hits.length > 0) {
    console.error("arch:error-envelope FAILED — flat error bodies bypass the M1 envelope:");
    for (const h of hits) {
      console.error(`  ${h.file}:${h.line}  throw a ChartWardenError subclass instead`);
    }
    process.exit(1);
  }
  console.log("arch:error-envelope OK — no route answers a failure with a flat error body.");
}
