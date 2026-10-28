// @vitest-environment jsdom
// #849 - the idle ScreenLock is lazy. A failed chunk load must FAIL CLOSED (block the frame), never
// leave a PHI screen with no inactivity lock.
import { ErrorBoundary } from "@chartwarden/ui";
import { render, screen } from "@testing-library/react";
import { Suspense, lazy } from "react";
import { describe, expect, it, vi } from "vitest";
import { ScreenLockUnavailable } from "../screen-lock-unavailable";

describe("lazy ScreenLock failure", () => {
  it("shows a blocking alertdialog when the chunk fails to load", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Broken = lazy(() =>
      Promise.reject(new Error("Failed to fetch dynamically imported module")),
    );

    render(
      <ErrorBoundary fallback={<ScreenLockUnavailable />}>
        <Suspense fallback={null}>
          <Broken />
        </Suspense>
      </ErrorBoundary>,
    );

    const dialog = await screen.findByRole("alertdialog", {
      name: /session protection unavailable/i,
    });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("button", { name: /reload/i })).toBeTruthy();
    consoleError.mockRestore();
  });
});
