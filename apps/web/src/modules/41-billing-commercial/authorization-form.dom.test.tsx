// The record-authorization form (M41): client checks, the Idempotency-Key contract, server errors inline, auth redirects and the
// number never outliving the submission. Synthetic data only.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorizationForm } from "./authorization-form";
import {
  type Call,
  ENTITY_ID,
  PATIENT_ID,
  PLAN_ID,
  type Responder,
  authorizationRow,
  mountScreen,
} from "./commercial-test-harness";

const POST = "POST /api/v1/billing/commercial/authorizations";
const PLANS = [
  { id: PLAN_ID, planName: "Synthetic PPO", authorizationRequirement: "required_at_admission" },
];

function Where(): null {
  const { pathname, search } = useLocation();
  document.body.dataset.where = pathname + search;
  return null;
}

function mount(
  responder: Responder,
  calls: Call[],
  handlers: { onRecorded?: () => void; onClose?: () => void } = {},
): ReturnType<typeof mountScreen> {
  return mountScreen({
    routes: { [POST]: responder },
    calls,
    element: (
      <>
        <Where />
        <AuthorizationForm
          providerEntityId={ENTITY_ID}
          patientId={PATIENT_ID}
          plans={PLANS}
          onRecorded={handlers.onRecorded ?? (() => undefined)}
          onClose={handlers.onClose ?? (() => undefined)}
          onReload={() => undefined}
        />
      </>
    ),
    routePath: "/commercial/billing/authorizations",
    entry: "/commercial/billing/authorizations",
    permissions: ["commercial_billing.read", "commercial_billing.write"],
  });
}

function fill(over: { number?: string; from?: string; to?: string; obtained?: string } = {}): void {
  fireEvent.change(screen.getByLabelText(/Plan/), { target: { value: PLAN_ID } });
  fireEvent.change(screen.getByLabelText(/Authorization number/), {
    target: { value: over.number ?? "AUTH-001" },
  });
  fireEvent.change(screen.getByLabelText(/Obtained on/), {
    target: { value: over.obtained ?? "2026-02-20" },
  });
  fireEvent.change(screen.getByLabelText(/Effective from/), {
    target: { value: over.from ?? "2026-03-01" },
  });
  if (over.to !== undefined) {
    fireEvent.change(screen.getByLabelText(/Effective to/), { target: { value: over.to } });
  }
}
const submit = (): HTMLElement => screen.getByRole("button", { name: /^Record authorization/ });
const posts = (calls: Call[]): Call[] => calls.filter((c) => c.method === "POST");

afterEach(() => {
  cleanup();
  delete document.body.dataset.where;
});

describe("AuthorizationForm", () => {
  it("posts every field with a 1..128 char Idempotency-Key and reports success", async () => {
    const calls: Call[] = [];
    const onRecorded = vi.fn();
    mount(() => ({ status: 201, body: authorizationRow() }), calls, { onRecorded });
    fill({ to: "2026-03-31" });
    fireEvent.change(screen.getByLabelText(/Level of care/), {
      target: { value: "routine_home_care" },
    });
    fireEvent.click(submit());
    await waitFor(() => expect(onRecorded).toHaveBeenCalled());

    const [post] = posts(calls);
    expect(post?.body).toEqual({
      providerEntityId: ENTITY_ID,
      patientId: PATIENT_ID,
      planId: PLAN_ID,
      authorizationNumber: "AUTH-001",
      levelOfCare: "routine_home_care",
      obtainedOn: "2026-02-20",
      effectiveFrom: "2026-03-01",
      effectiveTo: "2026-03-31",
    });
    const key = post?.headers.get("idempotency-key") ?? "";
    expect(key.length).toBeGreaterThanOrEqual(1);
    expect(key.length).toBeLessThanOrEqual(128);
  });

  it("omits effectiveTo and level of care when left blank", async () => {
    const calls: Call[] = [];
    const onRecorded = vi.fn();
    mount(() => ({ status: 201, body: authorizationRow() }), calls, { onRecorded });
    fill();
    fireEvent.click(submit());
    await waitFor(() => expect(onRecorded).toHaveBeenCalled());
    const body = posts(calls)[0]?.body as Record<string, unknown>;
    expect(body.effectiveTo ?? null).toBeNull();
    expect(body.levelOfCare ?? null).toBeNull();
  });

  it("sends nothing and says why when the client checks fail", async () => {
    const calls: Call[] = [];
    mount(() => ({ status: 201, body: authorizationRow() }), calls);
    fireEvent.click(submit());
    expect(await screen.findByText("Choose a plan.")).toBeTruthy();

    fill({ number: "has space", to: "2026-03-31" });
    fireEvent.click(submit());
    expect(await screen.findByText(/letters, digits, dots, underscores and hyphens/)).toBeTruthy();

    fill({ number: "OK-1", from: "2026-03-10", to: "2026-03-01" });
    fireEvent.click(submit());
    expect(await screen.findByText("The end date cannot be before the start date.")).toBeTruthy();
    expect(posts(calls)).toHaveLength(0);
  });

  it("uses a new Idempotency-Key for a separate submission", async () => {
    const calls: Call[] = [];
    const onRecorded = vi.fn();
    mount(() => ({ status: 201, body: authorizationRow() }), calls, { onRecorded });
    fill();
    fireEvent.click(submit());
    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
    fill({ number: "AUTH-002" });
    fireEvent.click(submit());
    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(2));
    const keys = posts(calls).map((c) => c.headers.get("idempotency-key"));
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBeTruthy();
    expect(keys[0]).not.toBe(keys[1]);
  });

  it.each([500, 503])(
    "uses a NEW key when retried after a %i (the server caches the error)",
    async (status) => {
      const calls: Call[] = [];
      let n = 0;
      mount(
        () => {
          n += 1;
          return n === 1
            ? { status, body: { error: { code: "INTERNAL" } } }
            : { status: 201, body: authorizationRow() };
        },
        calls,
        { onRecorded: () => undefined },
      );
      fill();
      fireEvent.click(submit());
      await screen.findByText(/did not go through/i);
      fireEvent.click(submit());
      await waitFor(() => expect(posts(calls)).toHaveLength(2));
      const [a, b] = posts(calls);
      expect(a?.headers.get("idempotency-key")).toBeTruthy();
      expect(b?.headers.get("idempotency-key")).not.toBe(a?.headers.get("idempotency-key"));
    },
  );

  it("KEEPS the key when the fetch threw (no response arrived)", async () => {
    const calls: Call[] = [];
    let n = 0;
    mount(
      () => {
        n += 1;
        if (n === 1) throw new TypeError("network down");
        return { status: 201, body: authorizationRow() };
      },
      calls,
      { onRecorded: () => undefined },
    );
    fill();
    fireEvent.click(submit());
    await screen.findByText(/did not go through/i);
    fireEvent.click(submit());
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    const [a, b] = posts(calls);
    expect(a?.headers.get("idempotency-key")).toBeTruthy();
    expect(b?.headers.get("idempotency-key")).toBe(a?.headers.get("idempotency-key"));
  });

  it("blocks a double submit while one is in flight", async () => {
    const calls: Call[] = [];
    let release: (() => void) | undefined;
    mount(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: 201, body: authorizationRow() });
        }),
      calls,
    );
    fill();
    // Submit the form twice directly: the disabled button is not what stops the second one.
    const form = submit().closest("form") as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    release?.();
  });

  it("drops the Idempotency-Key when a field changes after a failure", async () => {
    const calls: Call[] = [];
    let n = 0;
    mount(() => {
      n += 1;
      return n === 1
        ? { status: 500, body: { error: { code: "INTERNAL" } } }
        : { status: 201, body: authorizationRow() };
    }, calls);
    fill();
    fireEvent.click(submit());
    await screen.findByText(/did not go through/i);
    fireEvent.change(screen.getByLabelText(/Authorization number/), {
      target: { value: "AUTH-2" },
    });
    fireEvent.click(submit());
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    const [a, b] = posts(calls);
    expect(a?.headers.get("idempotency-key")).toBeTruthy();
    expect(b?.headers.get("idempotency-key")).not.toBe(a?.headers.get("idempotency-key"));
  });

  it("shows 409, 404 and 422 inline with the right words", async () => {
    const cases: [number, RegExp][] = [
      [409, /already be recorded.*reload the list/is],
      [404, /not in your scope.*no admission under this entity/is],
      [422, /^The end date cannot be before the start date\.$/],
    ];
    for (const [status, text] of cases) {
      const calls: Call[] = [];
      mount(
        () => ({
          status,
          body: { error: { code: "X", message: status === 422 ? "SERVER-ECHO" : "x" } },
        }),
        calls,
      );
      fill();
      fireEvent.click(submit());
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(text);
      expect(alert.textContent).not.toContain("SERVER-ECHO");
      cleanup();
    }
  });

  it("sends a 401 to /login and a step-up demand to /step-up", async () => {
    mount(() => ({ status: 401, body: { error: { code: "UNAUTHENTICATED" } } }), []);
    fill();
    fireEvent.click(submit());
    await waitFor(() => expect(document.body.dataset.where).toBe("/login"));
    cleanup();

    mount(() => ({ status: 403, body: { error: { code: "STEP_UP_REQUIRED" } } }), []);
    fill();
    fireEvent.click(submit());
    await waitFor(() => expect(document.body.dataset.where).toMatch(/^\/step-up\?returnTo=/));
  });

  it("clears the number from the field after success", async () => {
    const onRecorded = vi.fn();
    mount(() => ({ status: 201, body: authorizationRow() }), [], { onRecorded });
    fill({ number: "SECRET-9" });
    fireEvent.click(submit());
    await waitFor(() => expect(onRecorded).toHaveBeenCalled());
    expect((screen.getByLabelText(/Authorization number/) as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain("SECRET-9");
  });

  it("keeps the number field out of autofill", () => {
    mount(() => ({ status: 201, body: authorizationRow() }), []);
    expect(screen.getByLabelText(/Authorization number/).getAttribute("autocomplete")).toBe("off");
  });
});
