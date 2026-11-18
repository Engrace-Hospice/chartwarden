// #612 F-027: forms that asked for a raw membership / patient / admission id now offer a lookup.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { IncidentNewScreen } from "./incident-new";

const MEMBERSHIP = "33333333-aaaa-4aaa-8aaa-333333333333";
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

async function stub(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (new URL(url, "http://localhost").pathname === "/api/v1/orgs/org-1/members") {
    return json({
      members: [
        {
          membershipId: MEMBERSHIP,
          userId: "u",
          displayName: "Jordan Clinician",
          email: "j@example.test",
          status: "active",
        },
      ],
    });
  }
  return json({ items: [], nextCursor: null });
}

function mount(ui: JSX.Element): void {
  render(
    <MemoryRouter>
      <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stub })}>
        <SessionProvider
          session={{
            userId: "v",
            organizationId: "org-1",
            membershipId: "m",
            roles: [],
            permissions: [],
            isAdmin: false,
          }}
        >
          {ui}
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("lookups replace raw ids (#612)", () => {
  it("incident: the affected clinician is chosen by name, not typed as a membership id", async () => {
    mount(<IncidentNewScreen />);
    const field = screen.getByLabelText(/^Affected clinician/) as HTMLInputElement;
    expect(field.getAttribute("role")).toBe("combobox");
    fireEvent.focus(field);
    fireEvent.click(await screen.findByRole("option", { name: /Jordan Clinician/ }));
    expect(field.value).toBe("Jordan Clinician");
  });
});

describe("the incident wizard footer", () => {
  it("opens the review step with a new button instead of reusing the Continue node", async () => {
    // A real click on a reused <button> flips it to type="submit" before its default action runs, which
    // created the draft without the review step (see the WF08 visit wizard). jsdom cannot replay that
    // ordering, so assert the cause: the review step's button is a different element.
    mount(<IncidentNewScreen />);
    const field = screen.getByLabelText(/^Affected clinician/) as HTMLInputElement;
    fireEvent.focus(field);
    fireEvent.click(await screen.findByRole("option", { name: /Jordan Clinician/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(await screen.findByLabelText(/^Describe what happened/), {
      target: { value: "x".repeat(200) },
    });
    const advance = screen.getByRole("button", { name: "Continue" });
    fireEvent.click(advance);
    const create = await screen.findByRole("button", { name: /create draft/i });
    expect(create).not.toBe(advance);
    expect(advance.isConnected).toBe(false);
  });
});
