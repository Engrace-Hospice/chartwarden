/**
 * ChartWarden — Backend route scanner (F0-T01, ADR-0032)
 * --------------------------------------------------
 * Discovers every HTTP route the Fastify backend registers by scanning source
 * for `app.<method>("<path>", ...)` calls. This is the COVERAGE source of truth
 * for the OpenAPI generator: every route found here MUST appear in the emitted
 * contract, so a new route with no descriptor surfaces as drift (openapi:check).
 *
 * Why scan instead of read Fastify route metadata: routes validate via a manual
 * TypeBox `parse()` and do NOT attach schemas to Fastify's `schema:` option
 * (see ADR-0032), so `@fastify/swagger` sees nothing. Until routes are wired
 * (deferred backend follow-up), the scan + an enrichment registry are the contract.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { group } from "../lib/strict";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export interface ScannedRoute {
  method: HttpMethod;
  /** Fastify-style path as written in source, e.g. /api/v1/patients/:id */
  path: string;
  /** module slug (e.g. "05-patient") or "bootstrap" for the M1 host routes */
  module: string;
  /** repo-relative source file */
  file: string;
}

const BACKEND_SRC = "apps/backend/src";
const ROUTE_CALL_RE = /\bapp\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "dist" || entry === "__tests__" || entry === "node_modules") continue;
      walk(full, out);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.includes("typebox") || entry.includes(".test.")) continue;
    out.push(full);
  }
}

function moduleOf(file: string): string {
  const m = file.match(/modules\/([^/]+)\//);
  if (m) return group(m, 1, "route file module segment");
  return "bootstrap";
}

/** Scan the backend source tree for every registered route. Stable-sorted. */
export function scanRoutes(repoRoot: string = process.cwd()): ScannedRoute[] {
  const files: string[] = [];
  walk(join(repoRoot, BACKEND_SRC), files);
  const routes: ScannedRoute[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const rel = file.slice(repoRoot.length + 1);
    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(ROUTE_CALL_RE)) {
      const method = group(match, 1, "route registration method") as HttpMethod;
      const path = group(match, 2, "route registration path");
      const key = `${method} ${path}`;
      if (seen.has(key)) continue; // a path registered once is enough for the contract
      seen.add(key);
      routes.push({ method, path, module: moduleOf(rel), file: rel });
    }
  }
  routes.sort((a, b) =>
    a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path),
  );
  return routes;
}

/** `METHOD /path` key used to join routes to the enrichment registry. */
export function routeKey(r: { method: HttpMethod; path: string }): string {
  return `${r.method.toUpperCase()} ${r.path}`;
}
