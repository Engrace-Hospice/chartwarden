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
      () => ({ body: { items: [claimRow({ secondaryPayerKind: "medicare" })], hasMore: false } }),
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
    mount(() => ({ body: { items: [], hasMore: false } }), calls);
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
    mount(() => ({ body: { items: [claimRow()], hasMore: false } }), []);
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

  it("warns when more claims match than one page shows", async () => {
    mount(() => ({ body: { items: [claimRow()], hasMore: true } }), []);
    await screen.findByText(/More claims match than this page shows/);
  });

  it("does not call an unscanned queue empty: nothing reachable but more exist says to narrow the filters", async () => {
    mount(() => ({ body: { items: [], hasMore: true } }), []);
    await screen.findByText("Too many claims to scan");
    expect(screen.queryByText("No commercial claims yet")).toBeNull();
  });

  it("shows a loading status first, then a retryable error that announces itself", async () => {
    let attempt = 0;
    mount(
      () =>
        ++attempt === 1
          ? { status: 500, body: {} }
          : { body: { items: [claimRow()], hasMore: false } },
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
        [QUEUE]: () => ({ body: { items: [], hasMore: false } }),
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
