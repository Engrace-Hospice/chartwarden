// The authorizations view (M41): per-patient list, write gating, error states (404 is an error, never "none"), the status filter
// and the scope-change params. Synthetic data only.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
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

const OTHER_PATIENT = "99999999-9999-4999-8999-999999999999";
const STATUS = `POST /api/v1/billing/commercial/authorizations/${AUTH_ID}/status`;
const DRAWER = "Authorization for Synthetic PPO";

function GoTo({ search }: { search: string }): JSX.Element {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(`${PATH}?${search}`)}>
      go
    </button>
  );
}

function mount(
  list: Responder,
  opts: {
    write?: boolean;
    entry?: string;
    calls?: Call[];
    status?: Responder;
    goTo?: string;
  } = {},
): ReturnType<typeof mountScreen> {
  return mountScreen({
    routes: {
      "GET /api/v1/provider-entities": entitiesRoute,
      "GET /api/v1/billing/commercial/payer-plans": () => ({ body: { items: [planRow()] } }),
      [LIST]: list,
      [STATUS]: opts.status ?? (() => ({ status: 200, body: {} })),
      [`GET /api/v1/patients/${PATIENT_ID}`]: patientRoute,
    },
    calls: opts.calls ?? [],
    element: (
      <>
        <Search />
        {opts.goTo ? <GoTo search={opts.goTo} /> : null}
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

  const WITH_DRAWER = `${PATH}?entity=${ENTITY_ID}&patient=${PATIENT_ID}&auth=${AUTH_ID}`;
  const denyViaDrawer = async (): Promise<void> => {
    await screen.findByLabelText(DRAWER);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm deny" }));
  };

  it("keeps the drawer open on a 409, shows why, and reloads the list", async () => {
    const calls: Call[] = [];
    let n = 0;
    mount(
      () => {
        n += 1;
        return { body: { items: [authorizationRow({ status: n === 1 ? "approved" : "voided" })] } };
      },
      {
        write: true,
        entry: WITH_DRAWER,
        calls,
        status: () => ({ status: 409, body: { error: { code: "CONFLICT" } } }),
      },
    );
    await denyViaDrawer();
    const alert = await screen.findByText(/no longer approved.*list has been reloaded/s);
    await waitFor(() =>
      expect(calls.filter((c) => c.path.endsWith("/authorizations"))).toHaveLength(2),
    );
    await screen.findByText("Final. Record a new authorization instead.");
    expect(screen.getByLabelText(DRAWER)).toBeTruthy();
    expect(alert.isConnected).toBe(true);
    expect(screen.queryByText("Authorizations unavailable")).toBeNull();
  });

  it("announces a successful deny, reloads, and does not drop focus to the page body", async () => {
    const calls: Call[] = [];
    let n = 0;
    mount(
      () => {
        n += 1;
        return { body: { items: [authorizationRow({ status: n === 1 ? "approved" : "denied" })] } };
      },
      { write: true, entry: WITH_DRAWER, calls },
    );
    await denyViaDrawer();
    const toast = await screen.findByText("Authorization denied.");
    expect(toast.closest("[aria-live='polite']")).toBeTruthy();
    await waitFor(() => expect(screen.queryByLabelText(DRAWER)).toBeNull());
    await waitFor(() => expect(within(screen.getByRole("table")).getByText("Denied")).toBeTruthy());
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
  });

  it("keeps the rows mounted while a reload is in flight", async () => {
    let release: (() => void) | undefined;
    let n = 0;
    mount(
      () => {
        n += 1;
        if (n === 1) return { body: { items: [authorizationRow()] } };
        return new Promise((resolve) => {
          release = () => resolve({ body: { items: [authorizationRow()] } });
        });
      },
      { write: true, entry: WITH_DRAWER, status: () => ({ status: 409, body: {} }) },
    );
    await denyViaDrawer();
    await waitFor(() => expect(release).toBeDefined());
    expect(within(screen.getByRole("table")).getByText("Synthetic PPO")).toBeTruthy();
    expect(screen.getByLabelText(DRAWER)).toBeTruthy();
    release?.();
  });

  it("never shows the previous patient's rows while another patient loads", async () => {
    let release: (() => void) | undefined;
    mount(
      (call) => {
        if (call.query.get("patientId") === PATIENT_ID)
          return { body: { items: [authorizationRow()] } };
        return new Promise((resolve) => {
          release = () => resolve({ body: { items: [] } });
        });
      },
      { goTo: `entity=${ENTITY_ID}&patient=${OTHER_PATIENT}` },
    );
    await screen.findByText("Synthetic PPO");
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    expect(screen.queryByText("Synthetic PPO")).toBeNull();
    await waitFor(() => expect(release).toBeDefined());
    release?.();
    await screen.findByText("No authorizations recorded");
  });
});
