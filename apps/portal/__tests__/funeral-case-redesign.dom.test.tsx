import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createApiClient } from "@chartwarden/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortalApp } from "../src/app";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function renderFuneral(status = 200) {
  window.history.pushState({}, "", "/portal/funeral/case");
  return render(<PortalApp client={createApiClient({ baseUrl: "http://localhost", fetch: async (input) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === "/api/v1/funeral/case") return status === 200
      ? json({ decedentName: "Example Person", dateOfDeath: "2026-10-12" }) : json({}, status);
    return json({}, 404);
  } })} />);
}
afterEach(() => vi.unstubAllGlobals());

describe("PR4.4 restricted funeral-home case", () => {
  it("shows only the two authorized case fields", async () => {
    renderFuneral();
    expect(await screen.findByText("Example Person")).toBeTruthy();
    expect(screen.getByText("October 12, 2026")).toBeTruthy();
    expect(screen.getByText(/No other medical record information is available/)).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Portal navigation" })).toBeNull();
  });

  it("presents ended access without revealing patient details", async () => {
    renderFuneral(403);
    expect(await screen.findByText("This access is no longer available.")).toBeTruthy();
    expect(screen.queryByText("Example Person")).toBeNull();
  });

  it("ends the local case view after finish and does not show the name again", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ ok: true })));
    renderFuneral();
    fireEvent.click(await screen.findByRole("button", { name: "Finish and close access" }));
    await waitFor(() => expect(screen.getByText("This access is no longer available.")).toBeTruthy());
    expect(screen.queryByText("Example Person")).toBeNull();
  });
});
