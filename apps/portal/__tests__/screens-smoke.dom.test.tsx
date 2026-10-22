import { render, waitFor } from "@testing-library/react";
// @chartwarden/portal — TASK-050C (TEST-004) registry-driven screen smoke render. Mounts the real
// PortalApp once per §5.1 manifest entry (portalScreens, the same registry portal-screens.test.ts
// already asserts uniqueness/permission-shape for) with a stubbed API client, and proves each route
// mounts without tripping the top-level ErrorBoundary. See apps/web/src/shell/screens-smoke.dom.test.tsx
// for the sibling web-app version and docs/audits/.../11-test-and-quality-report.md TEST-004.
import { createApiClient } from "@chartwarden/ui";
import { describe, expect, it } from "vitest";
import { PortalApp } from "../src/app";
import { portalScreens } from "../src/screens/registry";

function stubClient() {
  return createApiClient({
    // See apps/web/src/shell/screens-smoke.dom.test.tsx — jsdom's Request has no document.baseURI
    // to resolve a relative "/api/v1/..." URL against, so the client needs an explicit origin here.
    baseUrl: "http://localhost",
    // A 404 (not a 200-with-empty-body) on every call: every real backend 200 satisfies its
    // TypeBox response contract, so an empty `{}` body is a shape no real endpoint ever actually
    // returns — it only tripped `(data as T) ?? null`-style unchecked casts into rendering with
    // every field undefined, a synthetic crash no real deployment can hit. An error status instead
    // exercises the same "can't load right now" path every screen already defends against
    // (loading/error/empty are the three states every read hook in this codebase branches on).
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
  expect(container.querySelector("[data-chartwarden-error-boundary]")).toBeNull();
  expect(container.textContent ?? "").not.toContain("Unexpected Application Error");
}

describe("TASK-050C — portal registry-driven screen smoke render", () => {
  it("covers the full §5.1 manifest (not an empty/stale registry)", () => {
    expect(portalScreens.screens.length).toBeGreaterThan(10);
  });

  for (const s of portalScreens.screens) {
    it(`renders "${s.id}" (${s.path}) without crashing`, async () => {
      window.history.pushState({}, "", `/portal${concretePath(s.path)}`);
      const { container } = render(<PortalApp client={stubClient()} />);
      await waitFor(() => settledWithoutCrash(container), { timeout: 5_000 });
      expect(container.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    });
  }
});
