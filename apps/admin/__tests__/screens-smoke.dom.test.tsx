import { render, waitFor } from "@testing-library/react";
// @wardenx/admin — TASK-050C (TEST-004) registry-driven screen smoke render. Auto-discovers every
// platform-module slice's screens.ts (import.meta.glob, mirroring apps/web's version — not a
// hand-copied list, so a new slice lands covered automatically), registers them into a real M34
// registry, and mounts the real AdminApp once per route with a stubbed API client. See
// apps/web/src/shell/screens-smoke.dom.test.tsx for the sibling web-app version.
import type { ScreenRegistryModule } from "@wardenx/types";
import { createApiClient } from "@wardenx/ui";
import { describe, expect, it } from "vitest";
import { AdminApp } from "../src/app";
import { adminAuthScreens } from "../src/shell/auth-screens";
import { createAdminRegistry } from "../src/shell/registry";
import type { AdminScreen } from "../src/shell/registry";
import type { Session } from "../src/shell/session";
import { adminSystemScreens } from "../src/shell/system-pages";

// A pre-resolved, platform_ops-holding session — without this, RequireChrome (gated on the real
// GET /api/v1/auth/context, which the stub client below can't answer) sends every chromed screen to
// /error, and the test would only ever be verifying that ONE page renders (mirrors
// apps/web/src/shell/screens-smoke.dom.test.tsx's FULL_SESSION).
const FULL_SESSION: Session = {
  userId: "smoke-user",
  organizationId: "11111111-1111-4111-8111-111111111111",
  membershipId: "22222222-2222-4222-8222-222222222222",
  displayName: "Smoke Test",
  organizationName: "Smoke Org",
  roles: ["platform_ops"],
  isAdmin: true,
  permissions: [],
};

const moduleFiles = import.meta.glob<Record<string, unknown>>("../src/modules/*/screens.ts", {
  eager: true,
});

function isScreenModule(value: unknown): value is ScreenRegistryModule<AdminScreen> {
  const m = value as ScreenRegistryModule<AdminScreen> | null;
  return !!m && typeof m === "object" && typeof m.slug === "string" && Array.isArray(m.screens);
}

// adminSystemScreens/adminAuthScreens live in ../src/shell (not ../src/modules), the same as
// apps/web's systemScreens — outside the glob's reach, so they're seeded explicitly (mirrors
// apps/web/src/shell/screens-smoke.dom.test.tsx).
const discoveredModules: ScreenRegistryModule<AdminScreen>[] = [adminSystemScreens, adminAuthScreens];
for (const fileExports of Object.values(moduleFiles)) {
  for (const value of Object.values(fileExports)) {
    if (isScreenModule(value)) discoveredModules.push(value);
  }
}

function buildRegistry() {
  const registry = createAdminRegistry();
  for (const m of discoveredModules) registry.register(m);
  return registry;
}

function stubClient() {
  return createApiClient({
    // See apps/web/src/shell/screens-smoke.dom.test.tsx — jsdom's Request has no document.baseURI
    // to resolve a relative "/api/v1/..." URL against, so the client needs an explicit origin here.
    baseUrl: "http://localhost",
    // A 404 (not a 200-with-empty-body) — see apps/web/src/shell/screens-smoke.dom.test.tsx for why:
    // an empty `{}` 200 body is a shape no real endpoint returns and only trips unchecked casts.
    fetch: async () =>
      new Response(
        JSON.stringify({ error: { code: "SMOKE_STUB", message: "no backend in test" } }),
        {
          status: 404,
          headers: { "content-type": "application/json" },
        },
      ),
  });
}

function concretePath(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, "11111111-1111-4111-8111-111111111111");
}

/** True once nothing is still loading and no error boundary (ours or react-router's default) fired. */
function settledWithoutCrash(container: HTMLElement): void {
  expect(container.querySelector("output")).toBeNull(); // no leftover LoadingSpinner
  // Our ErrorBoundary fallback carries a dedicated marker (NOT a bare role="alert" query or a text
  // match — M1's own /error system page legitimately headlines "Something went wrong" too) and
  // react-router's own default error element has a fixed, distinctive string.
  expect(container.querySelector("[data-wardenx-error-boundary]")).toBeNull();
  expect(container.textContent ?? "").not.toContain("Unexpected Application Error");
}

describe("TASK-050C — admin registry-driven screen smoke render", () => {
  const registry = buildRegistry();
  const screens = registry.screens();

  it("discovered every platform-module slice's screens.ts (not an empty/stale glob)", () => {
    expect(discoveredModules.length).toBeGreaterThan(0);
    expect(screens.length).toBeGreaterThan(10);
  });

  for (const s of screens) {
    it(`renders "${s.id}" (${s.path}) without crashing`, async () => {
      window.history.pushState({}, "", concretePath(s.path));
      const { container } = render(
        <AdminApp registry={registry} client={stubClient()} session={FULL_SESSION} />,
      );
      await waitFor(() => settledWithoutCrash(container), { timeout: 5_000 });
      expect(container.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    });
  }
});
