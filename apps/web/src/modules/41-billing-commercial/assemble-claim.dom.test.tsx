// The assemble-commercial-claim screen (M41): request body, the Idempotency-Key contract, refusals in fixed words (the server's
// message is never echoed), double-submit, the write gate and the redirect to the new claim. Synthetic data only.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommercialAssembleClaim } from "./assemble-claim";
import {
  CLAIM_ID,
  type Call,
  ENTITY_ID,
  PATIENT_ID,
  PLAN_ID,
  type Responder,
  entitiesRoute,
  mountScreen,
  planRow,
} from "./commercial-test-harness";

// The patient lookup is its own tested component; here it is a plain input so the screen's wiring is what is under test.
vi.mock("../../shell/entity-lookups", () => ({
  PatientLookupField: ({
    label,
    value,
    error,
    onChange,
  }: {
    label: string;
    value: string;
    error?: string;
    onChange: (v: string) => void;
  }) => (
    <div>
      <label>
        {label}
        <input value={value} onChange={(e) => onChange(e.target.value)} />
      </label>
      {error ? <span>{error}</span> : null}
    </div>
  ),
}));

const PATH = "/commercial/billing/claims/new";
const POST = "POST /api/v1/billing/commercial/claims/assemble";
const LEAK = "LEAK-diagnosis-F03.90-Acme";

const created = { claimId: CLAIM_ID, state: "draft", tob: "812", totalChargeCents: 620_000 };

function mount(responder: Responder, calls: Call[], write = true): ReturnType<typeof mountScreen> {
  return mountScreen({
    routes: {
      "GET /api/v1/provider-entities": entitiesRoute,
      "GET /api/v1/billing/commercial/payer-plans": () => ({ body: { items: [planRow()] } }),
      [POST]: responder,
    },
    calls,
    element: <CommercialAssembleClaim />,
    routePath: PATH,
    entry: `${PATH}?entity=${ENTITY_ID}`,
    permissions: write
      ? ["commercial_billing.read", "commercial_billing.write"]
      : ["commercial_billing.read"],
  });
}

async function fill(
  over: { from?: string; to?: string; plan?: boolean; key?: string } = {},
): Promise<void> {
  await screen.findByLabelText("Patient");
  fireEvent.change(screen.getByLabelText("Patient"), { target: { value: PATIENT_ID } });
  fireEvent.change(screen.getByLabelText(/Service from/), {
    target: { value: over.from ?? "2026-03-01" },
  });
  fireEvent.change(screen.getByLabelText(/Service to/), {
    target: { value: over.to ?? "2026-03-31" },
  });
  if (over.plan) {
    await screen.findByRole("option", { name: "Synthetic PPO" });
    fireEvent.change(screen.getByLabelText(/^Plan/), { target: { value: PLAN_ID } });
  }
  if (over.key !== undefined) {
    fireEvent.change(screen.getByLabelText(/Clearinghouse key/), { target: { value: over.key } });
  }
}
const submit = (): HTMLElement => screen.getByRole("button", { name: /^Assemble claim/ });
const posts = (calls: Call[]): Call[] => calls.filter((c) => c.method === "POST");
const keyOf = (c: Call | undefined): string | null => c?.headers.get("idempotency-key") ?? null;

afterEach(() => {
  cleanup();
  delete document.body.dataset.where;
});

describe("CommercialAssembleClaim", () => {
  it("posts the required fields with a 1..128 char key, omits blank options and opens the new claim", async () => {
    const calls: Call[] = [];
    mount(() => ({ status: 201, body: created }), calls);
    await fill();
    fireEvent.click(submit());
    await waitFor(() =>
      expect(document.body.dataset.where).toBe(
        `/commercial/billing/claims/${CLAIM_ID}?entity=${ENTITY_ID}`,
      ),
    );
    const [post] = posts(calls);
    expect(post?.body).toEqual({
      providerEntityId: ENTITY_ID,
      patientId: PATIENT_ID,
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-31",
    });
    const key = keyOf(post) ?? "";
    expect(key.length).toBeGreaterThanOrEqual(1);
    expect(key.length).toBeLessThanOrEqual(128);
  });

  it("sends the chosen plan and clearinghouse key", async () => {
    const calls: Call[] = [];
    mount(() => ({ status: 201, body: created }), calls);
    await fill({ plan: true, key: "stedi" });
    fireEvent.click(submit());
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]?.body).toMatchObject({ planId: PLAN_ID, clearinghouseKey: "stedi" });
  });

  it("checks the fields before sending anything", async () => {
    const calls: Call[] = [];
    mount(() => ({ status: 201, body: created }), calls);
    await screen.findByLabelText("Patient");
    fireEvent.click(submit());
    await screen.findByText("Choose a patient.");
    expect(screen.getByText("Enter the first day to bill.")).toBeTruthy();
    cleanup();
    mount(() => ({ status: 201, body: created }), calls);
    await fill({ from: "2026-03-31", to: "2026-03-01", key: "Bad Key" });
    fireEvent.click(submit());
    await screen.findByText("The last day cannot be before the first day.");
    expect(screen.getByText(/Use 1 to 40 lowercase letters/)).toBeTruthy();
    expect(posts(calls)).toHaveLength(0);
  });

  it.each([
    [409, "NON_COMMERCIAL_PRIMARY_PAYER", /primary coverage .* is not a commercial plan/],
    [422, "COMMERCIAL_PLAN_NOT_FOUND", /No payer plan is in effect/],
    [409, "PATIENT_NOT_ELECTED", /No hospice election covers these dates/],
    [503, "SERVICE_UNAVAILABLE", /not available right now/],
  ])(
    "shows a %i %s refusal in fixed words and never the server's text",
    async (status, code, text) => {
      const calls: Call[] = [];
      mount(() => ({ status, body: { error: { code, message: LEAK } } }), calls);
      await fill();
      fireEvent.click(submit());
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(text);
      expect(document.body.textContent).not.toContain(LEAK);
    },
  );

  it.each([409, 422, 500, 503])("uses a NEW key when retried after a %i", async (status) => {
    const calls: Call[] = [];
    let n = 0;
    mount(() => {
      n += 1;
      return n === 1
        ? { status, body: { error: { code: "X", message: LEAK } } }
        : { status: 201, body: created };
    }, calls);
    await fill();
    fireEvent.click(submit());
    await screen.findByRole("alert");
    fireEvent.click(submit());
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    const [a, b] = posts(calls);
    expect(keyOf(a)).toBeTruthy();
    expect(keyOf(b)).not.toBe(keyOf(a));
  });

  it("KEEPS the key when the fetch threw, and drops it once a field changes", async () => {
    const calls: Call[] = [];
    let n = 0;
    mount(() => {
      n += 1;
      if (n === 1) throw new TypeError("network down");
      return { status: 500, body: { error: { code: "INTERNAL" } } };
    }, calls);
    await fill();
    fireEvent.click(submit());
    await screen.findByText(/did not go through/i);
    fireEvent.click(submit());
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    const [a, b] = posts(calls);
    expect(keyOf(b)).toBe(keyOf(a));
    await screen.findByRole("alert");
    fireEvent.change(screen.getByLabelText(/Service to/), { target: { value: "2026-03-30" } });
    fireEvent.click(submit());
    await waitFor(() => expect(posts(calls)).toHaveLength(3));
    expect(keyOf(posts(calls)[2])).not.toBe(keyOf(a));
  });

  it("blocks a double submit while one is in flight", async () => {
    const calls: Call[] = [];
    let release: (() => void) | undefined;
    mount(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: 201, body: created });
        }),
      calls,
    );
    await fill();
    const form = submit().closest("form") as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    release?.();
  });

  it("sends an unauthenticated answer to the login page", async () => {
    mount(() => ({ status: 401, body: { error: { code: "UNAUTHENTICATED" } } }), []);
    await fill();
    fireEvent.click(submit());
    await waitFor(() => expect(document.body.dataset.where).toBe("/login"));
  });

  it("offers no form without commercial_billing.write", async () => {
    mount(() => ({ status: 201, body: created }), [], false);
    await screen.findByText("You are not allowed to assemble commercial claims.");
    expect(screen.queryByRole("button", { name: /^Assemble claim/ })).toBeNull();
  });
});
