// @vitest-environment jsdom
// The incident wizard's behaviour, pinned before its fields moved to the kit: each step validates on Continue and says
// what is missing, the narrative's minimum is enforced, the review step offers optional context and a workers'-comp
// reference, and Create draft files the report and opens it.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { IncidentNewScreen } from "./incident-new";

const CLINICIAN = "33333333-aaaa-4aaa-8aaa-333333333333";
const NARRATIVE = "The family's dog broke its tether near the porch. ".repeat(5);
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

let writes: { method: string; path: string; body: Record<string, unknown> | null }[] = [];

async function stub(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : null;
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    "http://localhost",
  );
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    const text = init?.body ? String(init.body) : request ? await request.clone().text() : "";
    writes.push({ method, path: url.pathname, body: text ? JSON.parse(text) : null });
    return json({ id: "new-incident-1" });
  }
  if (url.pathname === "/api/v1/orgs/org-1/members") {
    return json({
      members: [
        {
          membershipId: CLINICIAN,
          userId: "u1",
          displayName: "Jordan Clinician",
          email: "j@example.test",
          status: "active",
        },
      ],
    });
  }
  return json({ items: [], data: [], next_cursor: null });
}

afterEach(() => {
  cleanup();
  writes = [];
});

function mount(): void {
  render(
    <MemoryRouter initialEntries={["/safety/incidents/new"]}>
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
          <Routes>
            <Route path="/safety/incidents/new" element={<IncidentNewScreen />} />
            <Route path="/safety/incidents/:incidentId" element={<p>Opened an incident</p>} />
          </Routes>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

const pickClinician = async (): Promise<void> => {
  fireEvent.focus(screen.getByLabelText(/Affected clinician/));
  fireEvent.click(await screen.findByRole("option", { name: /Jordan Clinician/ }));
};
const next = (): void => {
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
};
const toDetails = async (): Promise<void> => {
  mount();
  await pickClinician();
  next();
  await screen.findByRole("heading", { name: "What happened?" });
};
const toReview = async (): Promise<void> => {
  await toDetails();
  fireEvent.change(screen.getByLabelText(/Describe what happened/), {
    target: { value: NARRATIVE },
  });
  next();
  await screen.findByRole("heading", { name: "Context & Review" });
};

describe("report a safety incident — the wizard", () => {
  it("stays on the first step and says who is missing", () => {
    mount();
    next();
    expect(screen.getByText("Affected clinician is required.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "What happened?" })).toBeNull();
  });

  it("asks for a date and time when it is cleared", () => {
    mount();
    fireEvent.change(screen.getByLabelText(/Occurred at/), { target: { value: "" } });
    next();
    expect(screen.getByText("Incident date/time is required.")).toBeTruthy();
  });

  it("offers every category and severity", () => {
    mount();
    expect(within(screen.getByLabelText("Category")).getAllByRole("option").length).toBeGreaterThan(
      3,
    );
    expect(within(screen.getByLabelText("Severity")).getAllByRole("option")).toHaveLength(4);
  });

  it("moves to the details step once a clinician is chosen", async () => {
    await toDetails();
    expect(screen.getByLabelText("Witnesses")).toBeTruthy();
  });

  it("holds the details step until the narrative reaches its minimum", async () => {
    await toDetails();
    fireEvent.change(screen.getByLabelText(/Describe what happened/), {
      target: { value: "too short" },
    });
    next();
    expect(screen.getByText("The narrative must be at least 200 characters.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "What happened?" })).toBeTruthy();
    expect(screen.getAllByText(/9 \/ 200 minimum/).length).toBeGreaterThan(0);
  });

  it("counts the narrative as it is written", async () => {
    await toDetails();
    fireEvent.change(screen.getByLabelText(/Describe what happened/), {
      target: { value: NARRATIVE },
    });
    expect(screen.getByText(`${NARRATIVE.trim().length} characters`)).toBeTruthy();
  });

  it("keeps what was written when going back a step", async () => {
    await toReview();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    const narrative = (await screen.findByLabelText(
      /Describe what happened/,
    )) as HTMLTextAreaElement;
    expect(narrative.value).toBe(NARRATIVE);
  });

  it("reveals optional context and a claim reference on the review step", async () => {
    await toReview();
    expect(screen.queryByLabelText(/^Location/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Add optional context/ }));
    expect(screen.getByLabelText(/^Location/)).toBeTruthy();
    expect(screen.getByLabelText("Visit")).toBeTruthy();
    expect(screen.getByLabelText("Linked SOS alert")).toBeTruthy();
    expect(screen.queryByLabelText(/^Claim reference/)).toBeNull();
    fireEvent.click(
      screen.getByLabelText(/workers' compensation claim has already been initiated/),
    );
    expect(screen.getByLabelText(/^Claim reference/)).toBeTruthy();
  });

  it("files the draft with what was entered and opens it", async () => {
    await toReview();
    fireEvent.click(screen.getByRole("button", { name: /Add optional context/ }));
    fireEvent.change(screen.getByLabelText(/^Location/), { target: { value: "Front porch" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.path).toBe("/api/v1/safety/incidents");
    expect(writes[0]?.body).toMatchObject({
      affectedClinicianMembershipId: CLINICIAN,
      narrative: NARRATIVE,
      locationDescription: "Front porch",
      workersCompClaimInitiated: false,
    });
    expect(await screen.findByText("Opened an incident")).toBeTruthy();
  });
});
