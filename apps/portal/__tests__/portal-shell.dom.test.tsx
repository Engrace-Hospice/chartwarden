import { render, screen, waitFor } from "@testing-library/react";
// @wardenx/portal — authenticated shell contract. The sign-in flow remains chromeless, while every
// patient route keeps the short navigation, explicit patient context, and urgent-help guidance.
import { createApiClient } from "@wardenx/ui";
import { describe, expect, it } from "vitest";
import { PortalApp } from "../src/app";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";

function stubClient() {
  return createApiClient({
    baseUrl: "http://localhost",
    fetch: async () =>
      new Response(JSON.stringify({ error: { code: "TEST_STUB", message: "no backend" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
  });
}

describe("portal authenticated shell", () => {
  it("keeps the sign-in route chromeless", () => {
    window.history.pushState({}, "", "/");
    render(<PortalApp client={stubClient()} />);

    expect(screen.queryByRole("navigation", { name: "Portal navigation" })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Urgent care information" })).toBeNull();
  });

  it("provides patient navigation, context, and persistent urgent help", async () => {
    window.history.pushState({}, "", `/p/${PATIENT_ID}/messages`);
    render(<PortalApp client={stubClient()} />);

    const nav = screen.getByRole("navigation", { name: "Portal navigation" });
    expect(nav).toBeTruthy();
    expect(screen.getByRole("link", { name: "Home" }).getAttribute("href")).toBe(
      `/p/${PATIENT_ID}`,
    );
    expect(screen.getByRole("link", { name: "Messages" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("link", { name: "Switch person" }).getAttribute("href")).toBe(
      "/patient-picker",
    );
    expect(screen.getByRole("main").id).toBe("portal-main");
    expect(screen.getByRole("complementary", { name: "Urgent care information" })).toBeTruthy();

    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
  });
});
