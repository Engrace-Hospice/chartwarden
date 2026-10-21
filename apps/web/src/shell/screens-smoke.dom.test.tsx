import { render, waitFor } from "@testing-library/react";
// apps/web/src/shell — TASK-050C (TEST-004) registry-driven screen smoke render. Auto-discovers
// every module's screens.ts the same way apps/web/src/main.tsx composes them (import.meta.glob,
// not a hand-copied import list — so a module lands covered automatically and this file can't drift
// from main.tsx's own registration set), registers them into a real M1 registry, and mounts the
// real AppShell once per registered route with a fully-authenticated session + a stubbed API
// client. This is a SMOKE test only: it proves each screen mounts (clears its Suspense fallback)
// without tripping the top-level ErrorBoundary — not that its data renders correctly. Component
// rendering was previously untestable at all (vitest.config.ts had no jsdom project) — see
// docs/audits/wardenx-production-readiness/11-test-and-quality-report.md TEST-004.
import type { ScreenRegistryModule } from "@chartwarden/types";
import { createApiClient } from "@chartwarden/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./app";
import { createScreenRegistry } from "./screen-registry";
import type { WebScreen } from "./screen-registry";
import type { Session } from "./session";
import { systemScreens } from "./system-pages";

const moduleFiles = import.meta.glob<Record<string, unknown>>("../modules/*/screens.ts", {
  eager: true,
});

function isScreenModule(value: unknown): value is ScreenRegistryModule<WebScreen> {
  const m = value as ScreenRegistryModule<WebScreen> | null;
  return !!m && typeof m === "object" && typeof m.slug === "string" && Array.isArray(m.screens);
}

const discoveredModules: ScreenRegistryModule<WebScreen>[] = [systemScreens];
for (const fileExports of Object.values(moduleFiles)) {
  for (const value of Object.values(fileExports)) {
    if (isScreenModule(value)) discoveredModules.push(value);
  }
}

function buildRegistry() {
  const registry = createScreenRegistry();
  for (const m of discoveredModules) registry.register(m);
  return registry;
}

const FULL_SESSION: Session = {
  userId: "smoke-user",
  organizationId: "11111111-1111-4111-8111-111111111111",
  membershipId: "22222222-2222-4222-8222-222222222222",
  displayName: "Smoke Test",
  organizationName: "Smoke Org",
  roles: ["administrator"],
  isAdmin: true,
  permissions: [],
};

// A 404 (not a 200-with-empty-body): every real backend 200 satisfies its TypeBox response
// contract, so an empty `{}` body is a shape no real endpoint ever actually returns — it only
// tripped `(data as T) ?? null`-style unchecked casts into rendering with every field undefined, a
// synthetic crash no real deployment can hit. An error status instead exercises the same "can't
// load right now" path every screen already defends against.
async function stubFetch(): Promise<Response> {
  return new Response(
    JSON.stringify({ error: { code: "SMOKE_STUB", message: "no backend in test" } }),
    {
      status: 404,
      headers: { "content-type": "application/json" },
    },
  );
}

beforeEach(() => {
  // Better Auth's client (authClient.getSession()/passkey.* — several identity/messaging/search
  // screens use it directly, not through @chartwarden/ui's typed client) calls the global fetch itself.
  // jsdom ships its own AbortController/AbortSignal (for DOM event aborting) that is a DIFFERENT
  // class than the one Node's real undici-backed fetch expects on RequestInit.signal, so letting
  // Better Auth's client reach the real fetch throws "RequestInit: Expected signal to be an
  // instance of AbortSignal" the moment it aborts a stale request. Stubbing the global sidesteps
  // both that and the network I/O.
  vi.stubGlobal("fetch", vi.fn(stubFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Every request resolves instantly to a 404 — no real network I/O, deterministic. */
function stubClient() {
  return createApiClient({
    // openapi-fetch's client baseUrl defaults to "" (real browsers resolve a relative Request URL
    // against document.baseURI) — jsdom's Request (Node's undici) has no such base and throws
    // "Invalid URL" on a bare "/api/v1/...", so tests need an explicit absolute origin.
    baseUrl: "http://localhost",
    fetch: stubFetch,
  });
}

/** Concrete, UUID-shaped values for every `:param` — good enough to satisfy react-router matching
 * and any client-side format assumptions; the stubbed backend never actually validates them. */
function concretePath(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, "11111111-1111-4111-8111-111111111111");
}

/** True once nothing is still loading and no error boundary (ours or react-router's default) fired. */
function settledWithoutCrash(container: HTMLElement): void {
  expect(container.querySelector("[data-chartwarden-loading-spinner]")).toBeNull(); // no leftover LoadingSpinner
  // Our ErrorBoundary fallback carries a dedicated marker (NOT a bare role="alert" query or a text
  // match — M1's own /error system page legitimately headlines "Something went wrong" too) and
  // react-router's own default error element has a fixed, distinctive string.
  expect(container.querySelector("[data-chartwarden-error-boundary]")).toBeNull();
  expect(container.textContent ?? "").not.toContain("Unexpected Application Error");
}

describe("TASK-050C — web app registry-driven screen smoke render", () => {
  const registry = buildRegistry();
  const screens = registry.screens();

  it("discovered every module's screens.ts (not an empty/stale glob)", () => {
    // One entry per registered module dir + systemScreens — guards against the glob silently
    // matching nothing (e.g. a moved directory) and this whole file going quietly untested.
    expect(discoveredModules.length).toBeGreaterThan(30);
    expect(screens.length).toBeGreaterThan(100);
  });

  it("every screen id is unique across the discovered modules", () => {
    // createScreenRegistry() already throws on a duplicate during buildRegistry() above — this
    // just documents the invariant explicitly for a reader of the test output.
    expect(new Set(screens.map((s) => s.id)).size).toBe(screens.length);
  });

  for (const s of screens) {
    it(`renders "${s.id}" (${s.path}) without crashing`, async () => {
      window.history.pushState({}, "", concretePath(s.path));
      const { container } = render(
        <AppShell registry={registry} client={stubClient()} session={FULL_SESSION} />,
      );
      await waitFor(() => settledWithoutCrash(container), { timeout: 5_000 });
      expect(container.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    });
  }
});
