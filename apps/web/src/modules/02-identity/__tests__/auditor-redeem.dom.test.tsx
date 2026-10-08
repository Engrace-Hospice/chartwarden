// @vitest-environment jsdom
// The auditor link page: the one-time token is read from the URL FRAGMENT, scrubbed from the address bar, and
// redeemed only when the auditor presses the button (so a mail scanner following the link cannot burn it).
// A successful redemption hands over to the enrolment screen (BAA terms + second factor, M2 §7.7).
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuditorRedeem } from "../auditor-redeem";

const ORG = "11111111-1111-4111-8111-111111111111";
const TOKEN = "A".repeat(43);

function renderPage(post: ReturnType<typeof vi.fn>, search = `?org=${ORG}`): void {
  render(
    <MemoryRouter initialEntries={[`/auditor/redeem${search}`]}>
      <ApiClientProvider client={{ POST: post } as unknown as ApiClient}>
        <Routes>
          <Route path="/auditor/redeem" element={<AuditorRedeem />} />
          <Route path="/auditor/enrol" element={<p>enrolment page</p>} />
          <Route path="/" element={<p>home</p>} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("AuditorRedeem", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", `/auditor/redeem?org=${ORG}#token=${TOKEN}`);
  });

  it("scrubs the token from the address bar and does NOT redeem until the button is pressed", async () => {
    const post = vi.fn();
    renderPage(post);
    await screen.findByRole("button", { name: "Start auditor session" });
    expect(window.location.hash).toBe("");
    expect(post).not.toHaveBeenCalled();
  });

  it("redeems with the org and token, then hands over to the enrolment screen", async () => {
    const post = vi.fn(async () => ({
      data: {
        sessionClass: "auditor",
        stage: "enrolment",
        organizationId: ORG,
        engagementId: "e1",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
      error: undefined,
    }));
    renderPage(post);
    fireEvent.click(await screen.findByRole("button", { name: "Start auditor session" }));
    await waitFor(() => expect(screen.getByText("enrolment page")).toBeTruthy());
    expect(post).toHaveBeenCalledWith("/api/v1/auditors/redeem", {
      body: { organizationId: ORG, token: TOKEN },
    });
  });

  it("explains an already-used link and does not offer a retry", async () => {
    const post = vi.fn(async () => ({
      data: undefined,
      error: { error: { code: "LINK_ALREADY_USED" } },
    }));
    renderPage(post);
    fireEvent.click(await screen.findByRole("button", { name: "Start auditor session" }));
    expect((await screen.findByRole("alert")).textContent).toContain("already been used");
    expect(
      (screen.getByRole("button", { name: "Start auditor session" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shows an incomplete-link message when the fragment or org is missing", async () => {
    window.history.replaceState(null, "", `/auditor/redeem?org=${ORG}`);
    renderPage(vi.fn());
    expect((await screen.findByText(/incomplete/i)).textContent).toContain("incomplete");
  });
});
