// The authorization drawer (M41): what is shown (never the number), and the Deny / Void confirm flow. Synthetic data only.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorizationDrawer } from "./authorization-drawer";
import type { AuthorizationView } from "./commercial-model";
import {
  AUTH_ID,
  type Call,
  PLAN_ID,
  type Responder,
  authorizationRow,
  mountScreen,
} from "./commercial-test-harness";

const STATUS = `POST /api/v1/billing/commercial/authorizations/${AUTH_ID}/status`;
const plan = {
  id: PLAN_ID,
  planName: "Synthetic PPO",
  authorizationRequirement: "required_at_admission",
  authorizationLeadDays: 3,
};

function mount(
  over: Record<string, unknown>,
  opts: { canWrite?: boolean; responder?: Responder; calls?: Call[] } = {},
  handlers: { onChanged?: () => void; onReload?: () => void } = {},
): ReturnType<typeof mountScreen> {
  return mountScreen({
    routes: opts.responder ? { [STATUS]: opts.responder } : {},
    calls: opts.calls ?? [],
    element: (
      <AuthorizationDrawer
        authorization={authorizationRow(over) as unknown as AuthorizationView}
        plan={plan}
        today="2026-03-15"
        canWrite={opts.canWrite ?? true}
        onClose={() => undefined}
        onChanged={handlers.onChanged ?? (() => undefined)}
        onReload={handlers.onReload ?? (() => undefined)}
      />
    ),
    routePath: "/commercial/billing/authorizations",
    entry: "/commercial/billing/authorizations",
    permissions: ["commercial_billing.read"],
  });
}

afterEach(cleanup);

describe("AuthorizationDrawer", () => {
  it("shows plan, policy, level of care, period and status, and says the number is never shown", () => {
    mount({ authorizationNumber: "LEAK-123" });
    expect(screen.getByRole("heading", { name: "Synthetic PPO" })).toBeTruthy();
    expect(screen.getByText("Required at admission")).toBeTruthy();
    expect(screen.getByText(/3 days/)).toBeTruthy();
    expect(screen.getByText("Routine Home Care")).toBeTruthy();
    expect(screen.getByText("2026-03-01 to 2026-03-31")).toBeTruthy();
    expect(screen.getByText("Approved")).toBeTruthy();
    expect(screen.getByText("The authorization number is stored but never shown.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("LEAK-123");
  });

  it("offers no actions without the write grant", () => {
    mount({}, { canWrite: false });
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Void" })).toBeNull();
  });

  it.each(["denied", "voided"])(
    "is final once %s: no buttons, a pointer to record anew",
    (status) => {
      mount({ status });
      expect(screen.getByText("Final. Record a new authorization instead.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Void" })).toBeNull();
    },
  );

  it("notes an ended period as a hint, not a status", () => {
    mount({ effectiveTo: "2026-03-10" });
    expect(screen.getByText("Period ended")).toBeTruthy();
    expect(screen.getByText("Approved")).toBeTruthy();
  });

  it("needs a confirm before denying, then posts the status with an Idempotency-Key", async () => {
    const calls: Call[] = [];
    const onChanged = vi.fn();
    mount(
      {},
      { calls, responder: () => ({ body: authorizationRow({ status: "denied" }) }) },
      { onChanged },
    );
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(screen.getByText(/ready claims.*back to draft/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm deny" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe(`/api/v1/billing/commercial/authorizations/${AUTH_ID}/status`);
    expect(post?.body).toEqual({ status: "denied" });
    expect((post?.headers.get("idempotency-key") ?? "").length).toBeGreaterThan(0);
  });

  it("voids the same way", async () => {
    const calls: Call[] = [];
    const onChanged = vi.fn();
    mount(
      {},
      { calls, responder: () => ({ body: authorizationRow({ status: "voided" }) }) },
      { onChanged },
    );
    fireEvent.click(screen.getByRole("button", { name: "Void" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm void" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ status: "voided" });
  });

  it("moves focus into the confirm pair and back to the opener on Keep", () => {
    mount({});
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Confirm deny" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Deny" }));
  });

  it("uses a NEW key after a 503 and KEEPS it after a thrown fetch", async () => {
    const calls: Call[] = [];
    let n = 0;
    mount(
      {},
      {
        calls,
        responder: () => {
          n += 1;
          if (n === 1) throw new TypeError("network down");
          if (n === 2) return { status: 503, body: { error: { code: "UNAVAILABLE" } } };
          return { body: authorizationRow({ status: "denied" }) };
        },
      },
    );
    const keys = (): (string | null)[] =>
      calls.filter((c) => c.method === "POST").map((c) => c.headers.get("idempotency-key"));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm deny" }));
    await screen.findByText(/Check your connection/i);
    fireEvent.click(screen.getByRole("button", { name: "Confirm deny" }));
    await waitFor(() => expect(keys()).toHaveLength(2));
    expect(keys()[1]).toBe(keys()[0]); // thrown fetch: same key
    await screen.findByText(/Try again\./);
    fireEvent.click(screen.getByRole("button", { name: "Confirm deny" }));
    await waitFor(() => expect(keys()).toHaveLength(3));
    expect(keys()[2]).not.toBe(keys()[1]); // after a 503: new key
  });

  it("shows a 409 inline and reloads the list", async () => {
    const onReload = vi.fn();
    mount(
      {},
      { responder: () => ({ status: 409, body: { error: { code: "CONFLICT", message: "x" } } }) },
      { onReload },
    );
    fireEvent.click(screen.getByRole("button", { name: "Void" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm void" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/no longer approved/i)).toBeTruthy();
    expect(onReload).toHaveBeenCalled();
  });
});
