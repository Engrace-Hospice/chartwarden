#!/usr/bin/env bun
/**
 * Offset pagination must use the signed, list/filter-bound route-kit cursor. Direct stringification
 * of conventional `offset` / `nextOffset` variables recreates the unsigned cursor pattern from #999.
 *
 * Run: bun run arch:offset-cursors (also included in arch:fitness)
 */
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appSourceFiles } from "./lib/gate-scan";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const UNSIGNED_OFFSET_CURSOR =
  /\bString\s*\(\s*(?:offset|nextOffset)\b|\b(?:offset|nextOffset)\.toString\s*\(|\b(?:nextCursor|cursor)\s*[:=][^\n]*\$\{\s*(?:offset|nextOffset)\b/g;

export interface UnsignedOffsetCursorHit {
  readonly file: string;
  readonly line: number;
  readonly expression: string;
}

export function findUnsignedOffsetCursors(file: string, source: string): UnsignedOffsetCursorHit[] {
  return [...source.matchAll(UNSIGNED_OFFSET_CURSOR)].map((match) => ({
    file,
    line: source.slice(0, match.index).split("\n").length,
    expression: match[0],
  }));
}

export function scanRepo(root = REPO_ROOT): UnsignedOffsetCursorHit[] {
  return appSourceFiles(root).flatMap((absolutePath) => {
    const file = relative(root, absolutePath);
    return findUnsignedOffsetCursors(file, readFileSync(absolutePath, "utf8"));
  });
}

if (import.meta.main) {
  const hits = scanRepo();
  if (hits.length > 0) {
    console.error(
      "arch:offset-cursors FAILED — direct offset/nextOffset stringification must use the signed cursor helpers:",
    );
    for (const hit of hits) console.error(`  ${hit.file}:${hit.line}  ${hit.expression}`);
    process.exit(1);
  }
  console.log(
    "arch:offset-cursors OK — no direct offset/nextOffset cursor stringification (#999 pattern).",
  );
}
