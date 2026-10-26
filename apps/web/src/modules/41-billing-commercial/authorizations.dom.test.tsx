// The authorizations view (M41): per-patient list, write gating, error states (404 is an error, never "none"), the status filter
// and the scope-change params. Synthetic data only.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { CommercialAuthorizations } from "./authorizations";
import {
  AUTH_ID,
  type Call,
  ENTITY_ID,
  PATIENT_ID,
  type Responder,
  authorizationRow,
  entitiesRoute,
  mountScreen,
  patientRoute,
  planRow,
} from "./commercial-test-harness";

const PATH = "/commercial/billing/authorizations";
const LIST = "GET /api/v1/billing/commercial/authorizations";

function Search(): null {
  document.body.dataset.search = useLocation().search;
  return null;
}

function mount(
  list: Responder,
  opts: { write?: boolean; entry?: string; calls?: Call[] } = {},
): ReturnType<typeof mountScreen> {
  return mountScreen({
    routes: {
      "GET /api/v1/provider-entities": entitiesRoute,
      "GET /api/v1/billing/commercial/payer-plans": () => ({ body: { items: [planRow()] } }),
      [LIST]: list,
      [`GET /api/v1/patients/${PATIENT_ID}`]: patientRoute,
    },
    calls: opts.calls ?? [],
    element: (
      <>
        <Search />
        <CommercialAuthorizations />
      </>
    ),
    routePath: PATH,
    entry: opts.entry ?? `${PATH}?entity=${ENTITY_ID}&patient=${PATIENT_ID}`,
    permissions: opts.write
      ? ["commercial_billing.read", "commercial_billing.write"]
      : ["commercial_billing.read"],
  });
}

afterEach(cleanup);

describe("CommercialAuthorizations", () => {
  it("asks for a patient before loading anything", async () => {
    const calls: Call[] = [];
    mount(() => ({ body: { items: [] } }), { entry: PATH, calls });
    await screen.findByText("Choose a patient");
    expect(calls.some((c) => c.path.endsWith("/authorizations"))).toBe(false);
  });

  it("lists the patient's authorizations by plan name with both ids sent", async () => {
    const calls: Call[] = [];
    mount(() => ({ body: { items: [authorizationRow()] } }), { calls });
    await screen.findByText("Synthetic PPO");
    const read = calls.find((c) => c.path.endsWith("/authorizations"));
    expect(read?.query.get("providerEntityId")).toBe(ENTITY_ID);
    expect(read?.query.get("patientId")).toBe(PATIENT_ID);
    const row = screen.getByText("Synthetic PPO").closest("tr") as HTMLElement;
    expect(within(row).getByText("Approved")).toBeTruthy();
  });

  it("hides write controls without commercial_billing.write and shows them with it", async () => {
    mount(() => ({ body: { items: [] } }));
    await screen.findByText("No authorizations recorded");
    expect(screen.queryByRole("button", { name: "Record authorization" })).toBeNull();
    cleanup();
    mount(() => ({ body: { items: [] } }), { write: true });
    await screen.findByRole("button", { name: "Record authorization" });
  });

  it("shows a 404 as an error with retry, never as none", async () => {
    mount(() => ({ status: 404, body: { error: { code: "NOT_FOUND" } } }));
    await screen.findByText("Authorizations unavailable");
    expect(screen.queryByText("No authorizations recorded")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("filters by status and says so when nothing matches", async () => {
    mount(() => ({ body: { items: [authorizationRow()] } }));
    await screen.findByText("Synthetic PPO");
    fireEvent.change(screen.getByLabelText("Authorization status"), {
      target: { value: "denied" },
    });
    await screen.findByText("No matching authorizations");
  });

  it("opens the drawer for a row and drops the selection when the entity changes", async () => {
    mount(() => ({ body: { items: [authorizationRow()] } }), {
      entry: `${PATH}?entity=${ENTITY_ID}&patient=${PATIENT_ID}&auth=${AUTH_ID}&claim=c1`,
    });
    await screen.findByLabelText("Authorization for Synthetic PPO");
    fireEvent.change(screen.getByLabelText("Provider entity"), { target: { value: ENTITY_ID } });
    await waitFor(() => expect(document.body.dataset.search).not.toMatch(/auth=|claim=|patient=/));
  });
});
