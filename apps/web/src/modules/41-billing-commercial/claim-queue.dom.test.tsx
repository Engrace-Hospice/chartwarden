// The commercial claim work queue (issue #726): scoping, the payer-kind and state filters, the drawer, and the loading, empty and
// error states. Synthetic data only.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CommercialClaimQueue } from "./claim-queue";
import {
  CLAIM_ID,
  type Call,
  ENTITY_ID,
  PATIENT_ID,
  type Responder,
  claimRow,
  entitiesRoute,
  mountScreen,
  patientRoute,
} from "./commercial-test-harness";

const QUEUE = "GET /api/v1/billing/commercial/claims";

function mount(
  queue: Responder,
  calls: Call[],
  entry = "/commercial/billing/claims",
): ReturnType<typeof mountScreen> {
  return mountScreen({
    routes: {
      "GET /api/v1/provider-entities": entitiesRoute,
      "GET /api/v1/billing/commercial/payer-plans": () => ({ body: { items: [] } }),
      [`GET /api/v1/patients/${PATIENT_ID}`]: patientRoute,
      [QUEUE]: queue,
    },
    calls,
    element: <CommercialClaimQueue />,
    routePath: "/commercial/billing/claims",
    entry,
  });
}

afterEach(cleanup);

describe("CommercialClaimQueue", () => {
  it("reads the queue for the first provider entity and renders the claim with its payer kind", async () => {
    const calls: Call[] = [];
    mount(
      () => ({
        body: {
          items: [claimRow({ secondaryPayerKind: "medicare" })],
          hasMore: false,
          nextCursor: null,
        },
      }),
      calls,
    );

    const row = await screen.findByRole("link", { name: "CCN-0001" });
    expect(row).toBeTruthy();
    expect(screen.getAllByText("Commercial + Medicare secondary").length).toBeGreaterThan(0);
    await screen.findByText("Vance, Ada");
    const queueCall = calls.find((c) => c.path.endsWith("/commercial/claims"));
    expect(queueCall?.query.get("providerEntityId")).toBe(ENTITY_ID);
    expect(queueCall?.query.has("payerKind")).toBe(false);
  });

  it("sends the payer-kind and state filters to the API", async () => {
    const calls: Call[] = [];
    mount(() => ({ body: { items: [], hasMore: false, nextCursor: null } }), calls);
    await screen.findByText("No commercial claims yet");

    fireEvent.change(screen.getByLabelText("Payer kind"), {
      target: { value: "medicaid_secondary" },
    });
    await screen.findByText("No matching claims");
    fireEvent.change(screen.getByLabelText("Claim state"), { target: { value: "ready" } });

    await waitFor(() => {
      const last = calls.filter((c) => c.path.endsWith("/commercial/claims")).at(-1);
      expect(last?.query.get("payerKind")).toBe("medicaid_secondary");
      expect(last?.query.get("state")).toBe("ready");
    });
  });

  it("opens a drawer with the claim on row activation (keyboard) and closes it with the close button", async () => {
    mount(() => ({ body: { items: [claimRow()], hasMore: false, nextCursor: null } }), []);
    const link = await screen.findByRole("link", { name: "CCN-0001" });
    const tr = link.closest("tr") as HTMLElement;

    fireEvent.keyDown(tr, { key: "Enter" });
    const drawer = await screen.findByRole("complementary", { name: "Claim CCN-0001" });
    expect(within(drawer).getByText("Synthetic PPO")).toBeTruthy();
    expect(
      within(drawer).getByRole("link", { name: "Open claim detail" }).getAttribute("href"),
    ).toBe(`/commercial/billing/claims/${CLAIM_ID}`);

    fireEvent.click(within(drawer).getByRole("button", { name: "Close claim preview" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Claim CCN-0001" })).toBeNull(),
    );
  });

  it("loads the next keyset page with the server's cursor and appends it", async () => {
    const calls: Call[] = [];
    const second = claimRow({
      id: "66666666-6666-4666-8666-777777777777",
      claimControlNumber: "CCN-0002",
    });
    mount(
      (call) =>
        call.query.get("cursor") === "CUR-1"
          ? { body: { items: [second], hasMore: false, nextCursor: null } }
          : { body: { items: [claimRow()], hasMore: true, nextCursor: "CUR-1" } },
      calls,
    );
    await screen.findByRole("link", { name: "CCN-0001" });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByRole("link", { name: "CCN-0002" });
    expect(screen.getByRole("link", { name: "CCN-0001" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    const more = calls.filter((c) => c.path.endsWith("/commercial/claims")).at(-1);
    expect(more?.query.get("cursor")).toBe("CUR-1");
    expect(more?.query.get("providerEntityId")).toBe(ENTITY_ID);
  });

  it("offers Load more instead of calling the queue empty when the first page held nothing reachable", async () => {
    mount(
      (call) =>
        call.query.get("cursor")
          ? { body: { items: [claimRow()], hasMore: false, nextCursor: null } }
          : { body: { items: [], hasMore: true, nextCursor: "CUR-9" } },
      [],
    );
    await screen.findByText("Nothing in your caseload in the newest claims");
    expect(screen.queryByText("No commercial claims yet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByRole("link", { name: "CCN-0001" });
  });

  it("keeps the loaded claims and says so when a further page cannot be loaded", async () => {
    mount(
      (call) =>
        call.query.get("cursor")
          ? { status: 500, body: {} }
          : { body: { items: [claimRow()], hasMore: true, nextCursor: "CUR-2" } },
      [],
    );
    await screen.findByRole("link", { name: "CCN-0001" });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("More claims could not be loaded.");
    expect(screen.getByRole("link", { name: "CCN-0001" })).toBeTruthy();
  });

  it("defaults to the first provider entity the user can bill for, skipping one outside their scope", async () => {
    const calls: Call[] = [];
    const OUT = "99999999-9999-4999-8999-999999999999";
    mountScreen({
      routes: {
        "GET /api/v1/provider-entities": () => ({
          body: {
            items: [
              { id: OUT, legalName: "Outside Hospice", ccn: "111111", npi: null, status: "active" },
              {
                id: ENTITY_ID,
                legalName: "Synthetic Hospice",
                ccn: "123456",
                npi: null,
                status: "active",
              },
            ],
            nextCursor: null,
          },
        }),
        "GET /api/v1/billing/commercial/payer-plans": (call) =>
          call.query.get("providerEntityId") === OUT
            ? { status: 404, body: { error: { code: "NOT_FOUND" } } }
            : { body: { items: [] } },
        [QUEUE]: () => ({ body: { items: [claimRow()], hasMore: false, nextCursor: null } }),
        [`GET /api/v1/patients/${PATIENT_ID}`]: patientRoute,
      },
      calls,
      element: <CommercialClaimQueue />,
      routePath: "/commercial/billing/claims",
      entry: "/commercial/billing/claims",
    });
    await screen.findByRole("link", { name: "CCN-0001" });
    const queue = calls.filter((c) => c.path.endsWith("/commercial/claims"));
    expect(queue.every((c) => c.query.get("providerEntityId") === ENTITY_ID)).toBe(true);
    expect((screen.getByLabelText("Provider entity") as HTMLSelectElement).value).toBe(ENTITY_ID);
  });

  it("says there is no usable provider entity when none is billable for the user", async () => {
    mountScreen({
      routes: {
        "GET /api/v1/provider-entities": entitiesRoute,
        "GET /api/v1/billing/commercial/payer-plans": () => ({ status: 404, body: {} }),
      },
      calls: [],
      element: <CommercialClaimQueue />,
      routePath: "/commercial/billing/claims",
      entry: "/commercial/billing/claims",
    });
    await screen.findByText("No provider entity in your scope");
  });

  it("shows a loading status first, then a retryable error that announces itself", async () => {
    let attempt = 0;
    mount(
      () =>
        ++attempt === 1
          ? { status: 500, body: {} }
          : { body: { items: [claimRow()], hasMore: false, nextCursor: null } },
      [],
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Claims unavailable");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("link", { name: "CCN-0001" });
  });

  it("says so when the actor sees no provider entity, and does not read the queue", async () => {
    const calls: Call[] = [];
    mountScreen({
      routes: {
        "GET /api/v1/provider-entities": () => ({ body: { items: [], nextCursor: null } }),
        [QUEUE]: () => ({ body: { items: [], hasMore: false, nextCursor: null } }),
      },
      calls,
      element: <CommercialClaimQueue />,
      routePath: "/commercial/billing/claims",
      entry: "/commercial/billing/claims",
    });
    await screen.findByText("No provider entity in your scope");
    expect(calls.some((c) => c.path.endsWith("/commercial/claims"))).toBe(false);
  });
});
