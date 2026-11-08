import { ApiClientProvider, createApiClient, discardStepUpDrafts } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — a gated write that has succeeded must not be sendable again. The
// screens navigate away on a short delay; until then Enter (an implicit form submit) used to POST a second time under a
// fresh Idempotency-Key. Now a submit while the first is in flight, and any submit after it succeeded, sends nothing.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RefundApprove } from "../refund-approve";
import { RefundNew } from "../refund-new";
import { SubscriptionApplyPromo } from "../subscription-apply-promo";
import { SubscriptionPause } from "../subscription-pause";
import { REFUND_REDIRECT_DELAY_MS, SUBSCRIPTION_REDIRECT_DELAY_MS } from "../use-success-redirect";

const SUB = "44444444-4444-4444-8444-444444444444";
const INVOICE = "3f2b8c1e-1111-4111-8111-111111111111";
const REFUND = "55555555-5555-4555-8555-555555555555";
const SETTLE_MS = 60;

interface Posted {
  path: string;
  idempotencyKey: string | null;
}
let posted: Posted[] = [];
let reply: () => Response = () => json({ id: "r1" }, 201);
let getReply: () => Response = () => json({ id: SUB, organizationId: SUB });

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(input, init);
  if (req.method === "GET") return getReply();
  posted = [
    ...posted,
    { path: new URL(req.url).pathname, idempotencyKey: req.headers.get("Idempotency-Key") },
  ];
  return reply();
}

/** Shows where the router is, and leaves for another page so a test can unmount the screen with a redirect pending. */
function Where(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="where">{location.pathname}</output>
      <button type="button" onClick={() => navigate("/away")}>
        leave the page
      </button>
    </>
  );
}

function mount(path: string): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/admin/refunds/new" element={<RefundNew />} />
          <Route path="/admin/refunds/:id/approve" element={<RefundApprove />} />
          <Route path="/admin/subscriptions/:id/pause" element={<SubscriptionPause />} />
          <Route path="/admin/subscriptions/:id/apply_promo" element={<SubscriptionApplyPromo />} />
          <Route path="*" element={<p>elsewhere</p>} />
        </Routes>
        <Where />
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

const form = (): HTMLFormElement => {
  const found = document.querySelector("form");
  if (!found) throw new Error("no form rendered");
  return found;
};
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  posted = [];
  reply = () => json({ id: "r1" }, 201);
  getReply = () => json({ id: SUB, organizationId: SUB });
  discardStepUpDrafts();
  window.sessionStorage.clear();
});

describe("refund request submit", () => {
  const fillRefund = (): void => {
    const set = (label: RegExp, value: string): void => {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    };
    set(/Invoice/, INVOICE);
    set(/Amount/, "25.00");
    set(/Reason detail/, "Customer asked for a partial refund, TICKET-9, see the thread.");
  };

  it("sends exactly one POST when submitted twice in a row, and none after it succeeded", async () => {
    mount("/admin/refunds/new");
    fillRefund();
    fireEvent.submit(form());
    fireEvent.submit(form());
    await screen.findByText(/Refund request created/);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.idempotencyKey).toBeTruthy();

    fireEvent.submit(form());
    await settle();
    expect(posted).toHaveLength(1);
    expect(
      (screen.getByRole("button", { name: /Submit request/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("sends exactly one POST when Enter is pressed twice in a field", async () => {
    mount("/admin/refunds/new");
    fillRefund();
    await userEvent.type(screen.getByLabelText(/Invoice/), "{Enter}{Enter}");
    await screen.findByText(/Refund request created/);
    await userEvent.type(screen.getByLabelText(/Invoice/), "{Enter}");
    await settle();
    expect(posted).toHaveLength(1);
  });

  it("ties the character counter to the textarea and says 'too short' in words", async () => {
    mount("/admin/refunds/new");
    const detail = screen.getByLabelText(/Reason detail/);
    const described = (): string =>
      (detail.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
    expect(described()).toMatch(/0\/40 characters — too short, 40 needed/);
    fireEvent.change(detail, { target: { value: "x".repeat(40) } });
    expect(described()).toMatch(/40\/40 characters/);
    expect(described()).not.toMatch(/too short/);
  });
});

describe("pause subscription submit", () => {
  it("sends exactly one POST when submitted twice in a row, and none after it succeeded", async () => {
    mount(`/admin/subscriptions/${SUB}/pause`);
    await screen.findByRole("button", { name: "Pause subscription" });
    fireEvent.submit(form());
    fireEvent.submit(form());
    await screen.findByText("Subscription paused.");
    expect(posted).toHaveLength(1);

    fireEvent.submit(form());
    await settle();
    expect(posted).toHaveLength(1);
    expect(
      (screen.getByRole("button", { name: /Pause subscription/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("leaves the form usable after a refusal, so the operator can retry", async () => {
    reply = () =>
      json({ error: { code: "FORBIDDEN", message: "refused", correlationId: "c" } }, 403);
    mount(`/admin/subscriptions/${SUB}/pause`);
    await screen.findByRole("button", { name: "Pause subscription" });
    fireEvent.submit(form());
    await screen.findByText("Could not pause the subscription.");
    fireEvent.submit(form());
    await waitFor(() => expect(posted).toHaveLength(2));
  });
});

describe("apply promo submit", () => {
  it("sends exactly one POST when submitted twice in a row, and none after it succeeded", async () => {
    mount(`/admin/subscriptions/${SUB}/apply_promo`);
    fireEvent.change(await screen.findByLabelText("Promo code"), { target: { value: "LAUNCH25" } });
    fireEvent.submit(form());
    fireEvent.submit(form());
    await screen.findByText(/applied\./);
    expect(posted).toHaveLength(1);

    fireEvent.submit(form());
    await settle();
    expect(posted).toHaveLength(1);
  });
});

describe("refund decision", () => {
  const requested = {
    id: REFUND,
    organizationId: SUB,
    organizationName: "Cedar Ridge",
    amountCents: 2500,
    kind: "partial",
    reasonCode: "duplicate",
    status: "requested",
    requestedAt: "2026-01-01T00:00:00.000Z",
    requestedByMembershipId: "member-1",
  };
  const open = async (status = "requested"): Promise<void> => {
    getReply = () => json({ ...requested, status });
    mount(`/admin/refunds/${REFUND}/approve`);
    await screen.findByRole("heading", { name: "Review refund" });
  };
  const approveButton = (): HTMLButtonElement =>
    screen.getByRole("button", { name: /Approve refund/ });
  const denyButton = (): HTMLButtonElement => screen.getByRole("button", { name: /Deny refund/ });

  it("approving sends one POST, locks both buttons, and shows the spinner on Approve only", async () => {
    await open();
    fireEvent.click(approveButton());
    fireEvent.click(approveButton());
    fireEvent.click(denyButton());
    await screen.findByText(/Refund approved/);
    expect(posted.map((p) => p.path)).toEqual([`/api/admin/refunds/${REFUND}/approve`]);
    expect(posted[0]?.idempotencyKey).toBeTruthy();
    expect(approveButton().disabled).toBe(true);
    expect(denyButton().disabled).toBe(true);
    expect(approveButton().getAttribute("aria-busy")).toBe("true");
    expect(denyButton().getAttribute("aria-busy")).toBeNull();
    fireEvent.click(approveButton());
    await settle();
    expect(posted).toHaveLength(1);
  });

  it("denying sends one POST, locks both buttons, and shows the spinner on Deny only", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Deny reason"), {
      target: { value: "Duplicate of #4" },
    });
    fireEvent.click(denyButton());
    fireEvent.click(denyButton());
    fireEvent.click(approveButton());
    await screen.findByText("Refund denied.");
    expect(posted.map((p) => p.path)).toEqual([`/api/admin/refunds/${REFUND}/deny`]);
    expect(approveButton().disabled).toBe(true);
    expect(denyButton().disabled).toBe(true);
    expect(denyButton().getAttribute("aria-busy")).toBe("true");
    expect(approveButton().getAttribute("aria-busy")).toBeNull();
  });

  it("denying without a reason sends nothing and unlocks the buttons", async () => {
    await open();
    fireEvent.click(denyButton());
    expect(await screen.findByText("Say why this refund is being denied.")).toBeTruthy();
    expect(posted).toHaveLength(0);
    expect(approveButton().disabled).toBe(false);
    expect(denyButton().disabled).toBe(false);
  });

  it("a refused approval re-enables both buttons so the decision can be retried", async () => {
    reply = () =>
      json({ error: { code: "REFUND_FOUR_EYES", message: "no", correlationId: "c" } }, 403);
    await open();
    fireEvent.click(approveButton());
    expect(
      await screen.findByText(/Four-eyes: you cannot approve a refund you requested/),
    ).toBeTruthy();
    expect(approveButton().disabled).toBe(false);
    expect(denyButton().disabled).toBe(false);
    expect(approveButton().getAttribute("aria-busy")).toBeNull();
  });

  it("a refund that is already decided offers no action, and a denial or failure does not wear the success tick", async () => {
    const iconPath = (): string | null | undefined =>
      screen
        .getByText(/already/)
        .previousElementSibling?.querySelector("path")
        ?.getAttribute("d");
    const paths: Record<string, string | null | undefined> = {};
    for (const status of ["approved", "denied", "executed_failed"]) {
      await open(status);
      expect(screen.queryByRole("button", { name: /Approve refund/ })).toBeNull();
      paths[status] = iconPath();
      cleanup();
    }
    expect(paths.approved).toBeTruthy();
    expect(paths.denied).toBeTruthy();
    expect(paths.denied).not.toBe(paths.approved);
    expect(paths.executed_failed).not.toBe(paths.approved);
    expect(paths.executed_failed).not.toBe(paths.denied);
  });
});

describe("redirect after success", () => {
  // setTimeout is faked only: the redirect timer is what is under test, and findBy*/waitFor poll on an interval.
  const useFakeRedirectTimers = (): void => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  };
  const advance = (ms: number): Promise<void> =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const where = (): string => screen.getByTestId("where").textContent ?? "";
  const MARGIN_MS = 100;

  const submitPromo = async (): Promise<void> => {
    useFakeRedirectTimers();
    mount(`/admin/subscriptions/${SUB}/apply_promo`);
    await advance(1);
    fireEvent.change(screen.getByLabelText("Promo code"), { target: { value: "LAUNCH25" } });
    fireEvent.submit(form());
    await advance(1);
  };

  it("promo: stays on the page until the delay has passed, then navigates once", async () => {
    await submitPromo();
    expect(screen.getByText(/applied\./)).toBeTruthy();
    expect(where()).toBe(`/admin/subscriptions/${SUB}/apply_promo`);
    await advance(SUBSCRIPTION_REDIRECT_DELAY_MS - MARGIN_MS);
    expect(where()).toBe(`/admin/subscriptions/${SUB}/apply_promo`);
    await advance(MARGIN_MS * 2);
    expect(where()).toBe(`/admin/subscriptions/${SUB}`);
    expect(posted).toHaveLength(1);
  });

  it("promo: shows no 'enter the code' error once the success cleared the field", async () => {
    await submitPromo();
    expect(screen.getByText(/applied\./)).toBeTruthy();
    expect((screen.getByLabelText("Promo code") as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Enter the promo code to apply.")).toBeNull();
  });

  it("promo: leaving the page cancels the pending redirect", async () => {
    await submitPromo();
    fireEvent.click(screen.getByRole("button", { name: "leave the page" }));
    expect(where()).toBe("/away");
    await advance(SUBSCRIPTION_REDIRECT_DELAY_MS * 2);
    expect(where()).toBe("/away");
  });

  it("pause: navigates back to the subscription after the same delay", async () => {
    useFakeRedirectTimers();
    mount(`/admin/subscriptions/${SUB}/pause`);
    await advance(1);
    fireEvent.submit(form());
    await advance(1);
    expect(screen.getByText("Subscription paused.")).toBeTruthy();
    await advance(SUBSCRIPTION_REDIRECT_DELAY_MS - MARGIN_MS);
    expect(where()).toBe(`/admin/subscriptions/${SUB}/pause`);
    await advance(MARGIN_MS * 2);
    expect(where()).toBe(`/admin/subscriptions/${SUB}`);
  });

  it("refund request: waits the longer refund delay before returning to the queue", async () => {
    useFakeRedirectTimers();
    mount("/admin/refunds/new");
    for (const [label, value] of [
      [/Invoice/, INVOICE],
      [/Amount/, "25.00"],
      [/Reason detail/, "Customer asked for a partial refund, TICKET-9, see the thread."],
    ] as const) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.submit(form());
    await advance(1);
    expect(screen.getByText(/Refund request created/)).toBeTruthy();
    await advance(SUBSCRIPTION_REDIRECT_DELAY_MS + MARGIN_MS);
    expect(where()).toBe("/admin/refunds/new");
    await advance(REFUND_REDIRECT_DELAY_MS);
    expect(where()).toBe("/admin/refunds");
  });
});
