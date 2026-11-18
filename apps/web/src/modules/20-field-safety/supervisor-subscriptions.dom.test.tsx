// @vitest-environment jsdom
// "Add a subscription" is a multi-field form on a ledger screen, so it opens as a drawer in the detail rail beside the
// ledger (the redesign's pattern), not as a dialog over it. Cancel closes it and sends nothing; the add button stays
// disabled until the form names who is paged and for what.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { SupervisorSubscriptionsScreen } from "./supervisor-subscriptions";

const SUPERVISOR = "33333333-aaaa-4aaa-8aaa-333333333333";
const CLINICIAN = "44444444-bbbb-4bbb-8bbb-444444444444";
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

let writes: { method: string; path: string; body: unknown }[] = [];
let rejectWrites = false;

async function stub(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : null;
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    "http://localhost",
  );
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    if (rejectWrites) throw new TypeError("Failed to fetch");
    const text = init?.body ? String(init.body) : request ? await request.clone().text() : "";
    writes.push({ method, path: url.pathname, body: text ? JSON.parse(text) : null });
    return json({});
  }
  if (url.pathname === "/api/v1/orgs/org-1/members") {
    return json({
      members: [
        {
          membershipId: SUPERVISOR,
          userId: "u1",
          displayName: "Sam Supervisor",
          email: "s@example.test",
          status: "active",
        },
        {
          membershipId: CLINICIAN,
          userId: "u2",
          displayName: "Jordan Clinician",
          email: "j@example.test",
          status: "active",
        },
      ],
    });
  }
  return json({ data: [], next_cursor: null, has_more: false });
}

afterEach(() => {
  cleanup();
  writes = [];
  rejectWrites = false;
});

function mount(): void {
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
          <SupervisorSubscriptionsScreen />
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

const openDrawer = async (): Promise<HTMLElement> => {
  fireEvent.click(
    (await screen.findAllByRole("button", { name: "Add subscription" }))[0] as HTMLElement,
  );
  return screen.findByRole("complementary", { name: "Add a subscription" });
};

const pick = async (drawer: HTMLElement, label: RegExp, name: RegExp): Promise<void> => {
  fireEvent.focus(within(drawer).getByLabelText(label));
  fireEvent.click(await screen.findByRole("option", { name }));
};

describe("supervisor subscriptions — add a subscription", () => {
  it("opens the form as a drawer beside the ledger, not a dialog over it", async () => {
    mount();
    const drawer = await openDrawer();
    expect(within(drawer).getByLabelText("Scope")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The ledger stays on the page while the form is open.
    expect(screen.getByRole("heading", { name: "Supervisor Subscriptions" })).toBeTruthy();
  });

  it("closes from Cancel without sending anything", async () => {
    mount();
    const drawer = await openDrawer();
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Add a subscription" })).toBeNull(),
    );
    expect(writes).toEqual([]);
  });

  it("keeps Add subscription disabled until a supervisor and the scope's clinician are chosen", async () => {
    mount();
    const drawer = await openDrawer();
    const add = within(drawer).getByRole("button", {
      name: "Add subscription",
    }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    await pick(drawer, /^Supervisor/, /Sam Supervisor/);
    expect(add.disabled).toBe(true);
    await pick(drawer, /^Clinician/, /Jordan Clinician/);
    expect(add.disabled).toBe(false);
  });

  it("files the subscription and closes the drawer", async () => {
    mount();
    const drawer = await openDrawer();
    await pick(drawer, /^Supervisor/, /Sam Supervisor/);
    await pick(drawer, /^Clinician/, /Jordan Clinician/);
    fireEvent.click(within(drawer).getByRole("button", { name: "Add subscription" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.method).toBe("POST");
    expect(writes[0]?.path).toBe("/api/v1/safety/supervisor-subscriptions");
    expect(writes[0]?.body).toMatchObject({
      supervisorMembershipId: SUPERVISOR,
      clinicianMembershipId: CLINICIAN,
    });
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Add a subscription" })).toBeNull(),
    );
  });
});

describe("supervisor subscriptions — a write that fails", () => {
  it("recovers when the add request is rejected by the network", async () => {
    rejectWrites = true;
    mount();
    const drawer = await openDrawer();
    await pick(drawer, /^Supervisor/, /Sam Supervisor/);
    await pick(drawer, /^Clinician/, /Jordan Clinician/);
    fireEvent.click(within(drawer).getByRole("button", { name: "Add subscription" }));
    expect((await within(drawer).findByRole("alert")).textContent).toContain("No answer came back");
    expect(
      (within(drawer).getByRole("button", { name: "Add subscription" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    // The page is live again, not left inert behind a write that will never answer.
    expect(screen.getByRole("link", { name: "Safety board" }).closest("[inert]")).toBeNull();
  });
});

describe("supervisor subscriptions — nothing outlives a dismissed form", () => {
  it("reopens empty and without the last failure", async () => {
    rejectWrites = true;
    mount();
    const drawer = await openDrawer();
    await pick(drawer, /^Supervisor/, /Sam Supervisor/);
    await pick(drawer, /^Clinician/, /Jordan Clinician/);
    fireEvent.click(within(drawer).getByRole("button", { name: "Add subscription" }));
    await within(drawer).findByText(/No answer came back/);
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Add a subscription" })).toBeNull(),
    );
    const again = await openDrawer();
    expect((within(again).getByLabelText(/^Supervisor/) as HTMLInputElement).value).toBe("");
    expect((within(again).getByLabelText(/^Clinician/) as HTMLInputElement).value).toBe("");
    expect(within(again).queryByText(/No answer came back/)).toBeNull();
  });
});
