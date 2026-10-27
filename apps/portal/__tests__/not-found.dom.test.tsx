// @chartwarden/portal — #594: an unknown URL or a throwing screen must show a themed, family-safe page, never
// React Router's developer-facing "Unexpected Application Error" default.
import { createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortalApp } from "../src/app";

// A screen that throws on demand, so the route-error test goes through PortalApp's real router and fails if
// `errorElement` is ever removed from app.tsx.
const screenBehaviour = vi.hoisted(() => ({ throws: false }));
vi.mock("../src/screens/patient-picker", () => ({
  PortalPatientPicker: () => {
    if (screenBehaviour.throws)
      throw new Error("developer-only detail: undefined is not a function");
    return null;
  },
}));

afterEach(() => {
  screenBehaviour.throws = false;
  vi.restoreAllMocks();
});

function recordingClient(requests: string[]) {
  return createApiClient({
    baseUrl: "http://localhost",
    fetch: async (request) => {
      requests.push(request instanceof Request ? request.url : String(request));
      return new Response(JSON.stringify({ error: { code: "TEST_STUB", message: "no backend" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });
}

describe("portal not-found and route-error pages (#594)", () => {
  it("shows the themed not-found page for an unknown URL, with no API call", async () => {
    const requests: string[] = [];
    window.history.pushState({}, "", "/portal/no-such-page");
    render(<PortalApp client={recordingClient(requests)} />);

    expect(await screen.findByText("We couldn’t find that page")).toBeTruthy();
    expect(screen.queryByText(/Hey developer/i)).toBeNull();
    expect(screen.queryByText(/Unexpected Application Error/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Go to your patients" })).toBeTruthy();
    expect(requests).toEqual([]);
  });

  it("the home button navigates to the patient picker", async () => {
    window.history.pushState({}, "", "/portal/no-such-page");
    render(<PortalApp client={recordingClient([])} />);

    fireEvent.click(await screen.findByRole("button", { name: "Go to your patients" }));
    await waitFor(() => expect(window.location.pathname).toBe("/portal/patient-picker"));
  });

  it("still renders the sign-in route chromeless at the root", async () => {
    window.history.pushState({}, "", "/portal/");
    render(<PortalApp client={recordingClient([])} />);

    expect((await screen.findAllByText(/sign in/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText("We couldn’t find that page")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Portal navigation" })).toBeNull();
  });

  it("shows the route-error page, not the thrown message, when a screen throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    screenBehaviour.throws = true;
    window.history.pushState({}, "", "/portal/patient-picker");
    render(<PortalApp client={recordingClient([])} />);

    expect(await screen.findByText("Something went wrong")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload this page" })).toBeTruthy();
    expect(screen.queryByText(/developer-only detail/)).toBeNull();
    expect(screen.queryByText(/Hey developer/i)).toBeNull();
  });
});
