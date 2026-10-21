// ADR-0049 Phase 4: the portal is served under /portal/ of the tenant host, sharing the origin (and the cookie) with
// `/api`. Two things must hold: the build is based there, and every API path the SPA calls is one the backend's
// tenant session-class guard (apps/backend/src/bootstrap/tenant-session-class.ts) lets a portal-class session reach.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PORTAL_BASE_PATH } from "../src/base-path";
import config from "../vite.config";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

/** Prefixes a portal-class session may reach (mirrors PORTAL_SESSION_ALLOWED_PREFIXES in the backend guard). */
const PORTAL_SESSION_PREFIXES = [
  "/api/v1/portal/",
  "/api/auth/",
  "/api/v1/auth/",
  "/api/v1/public/",
];
/**
 * The only non-portal API calls the SPA makes, and why the guard needs no entry for them: both belong to the funeral
 * home / collaborator flow, whose sessions are `funeral_home` / `external_collaborator` (neither a portal class nor
 * `staff`, so the guard lets them through), and `consume` is anonymous.
 */
const FUNERAL_FLOW_PATHS = ["/api/v1/collaborators/consume", "/api/v1/funeral/case"];

describe("portal under /portal/", () => {
  it("builds with base /portal/ and keeps the dev proxy on same-origin /api", () => {
    expect(PORTAL_BASE_PATH).toBe("/portal");
    expect(config.base).toBe("/portal/");
    expect(Object.keys(config.server?.proxy ?? {})).toEqual(["/api", "/webhooks"]);
  });

  it("calls only API paths a portal-class session may reach, or the known funeral-flow pair", () => {
    const literals = sourceFiles(join(__dirname, "../src")).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/["'`](\/api\/[A-Za-z][A-Za-z0-9_/{}.-]*)/g)].map(
        (m) => m[1] as string,
      ),
    );
    expect(literals.length).toBeGreaterThan(10);
    const unexpected = literals.filter(
      (path) =>
        !PORTAL_SESSION_PREFIXES.some((p) => path.startsWith(p)) &&
        !FUNERAL_FLOW_PATHS.includes(path),
    );
    expect(unexpected).toEqual([]);
  });
});
