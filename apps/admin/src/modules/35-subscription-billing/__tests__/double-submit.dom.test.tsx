import {
  ApiClientProvider,
  ToastProvider,
  createApiClient,
  discardStepUpDrafts,
} from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — a gated write that has succeeded must not be sendable again, and its
// confirmation must be heard. A second submit while the first is in flight sends nothing; on success the form navigates
// away at once (replacing its history entry, so Back does not return to a resubmittable form) and the confirmation is a
// toast, which lives above the router and is announced by the destination's live region.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RefundApprove } from "../refund-approve";
import { RefundNew } from "../refund-new";
import { DECIDED_REFUND_ICON } from "../status";
import { SubscriptionApplyPromo } from "../subscription-apply-promo";
import { SubscriptionPause } from "../subscription-pause";

const SUB = "44444444-4444-4444-8444-444444444444";
const INVOICE = "3f2b8c1e-1111-4111-8111-111111111111";
const REFUND = "55555555-5555-4555-8555-555555555555";
const PREVIOUS_PATH = "/previous";
/** A refund awaiting a decision, as the detail GET serves it. */
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

interface Posted {
  path: string;
  idempotencyKey: string | null;
}
let posted: Posted[] = [];
let reply: () => Response = () => json({ id: "r1" }, 201);
let getReply: () => Response = () => json({ id: SUB, organizationId: SUB });
/** While set, a write is held in flight until the test releases it. */
let writeGate: Promise<void> | null = null;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(input, init);
  if (req.method === "GET") return getReply();
  posted = [
    ...posted,
    { path: new URL(req.url).pathname, idempotencyKey: req.headers.get("Idempotency-Key") },
  ];
  if (writeGate) await writeGate;
  return reply();
}

/** Holds every write in flight until `release()`. */
function holdWrites(): { release: () => Promise<void> } {
  let open: () => void = () => undefined;
  writeGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    release: () =>
      act(async () => {
        open();
        await writeGate;
        writeGate = null;
      }),
  };
}

/** Shows where the router is and how it got there, and can leave for another page or step Back. */
function Where(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  return (
    <>
      <output data-testid="where">{location.pathname}</output>
      <output data-testid="how">{navigationType}</output>
      <button type="button" onClick={() => navigate("/away")}>
        leave the page
      </button>
      <button type="button" onClick={() => navigate(-1)}>
        history back
      </button>
    </>
  );
}

/** One earlier history entry, so Back from the form's replacement can be told apart from Back to the form. */
function mount(path: string): { unmountScreen: () => void } {
  const view = render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <ToastProvider>
        <MemoryRouter initialEntries={[PREVIOUS_PATH, path]} initialIndex={1}>
          <Routes>
            <Route path={PREVIOUS_PATH} element={<p>previous page</p>} />
            <Route path="/admin/refunds/new" element={<RefundNew />} />
            <Route path="/admin/refunds/:id/approve" element={<RefundApprove />} />
            <Route path="/admin/subscriptions/:id/pause" element={<SubscriptionPause />} />
            <Route
              path="/admin/subscriptions/:id/apply_promo"
              element={<SubscriptionApplyPromo />}
            />
            <Route path="*" element={<p>elsewhere</p>} />
          </Routes>
          <Where />
        </MemoryRouter>
      </ToastProvider>
    </ApiClientProvider>,
  );
  return { unmountScreen: () => view.unmount() };
}

const form = (): HTMLFormElement => {
  const found = document.querySelector("form");
  if (!found) throw new Error("no form rendered");
  return found;
};
const where = (): string => screen.getByTestId("where").textContent ?? "";
const how = (): string => screen.getByTestId("how").textContent ?? "";
/** The confirmation toast: a status entry in the provider's polite live region (the Where probes are <output>s too). */
const toastText = (): string =>
  document.querySelector('[aria-live="polite"] [role="status"]')?.textContent?.replace(/×$/, "") ??
  "";
const back = (): void => {
  fireEvent.click(screen.getByRole("button", { name: "history back" }));
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  posted = [];
  reply = () => json({ id: "r1" }, 201);
  getReply = () => json({ id: SUB, organizationId: SUB });
  writeGate = null;
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

  it("sends exactly one POST when submitted twice in a row", async () => {
    const held = holdWrites();
    mount("/admin/refunds/new");
    fillRefund();
    fireEvent.submit(form());
    fireEvent.submit(form());
    await held.release();
    await waitFor(() => expect(where()).toBe("/admin/refunds"));
    expect(posted).toHaveLength(1);
    expect(posted[0]?.idempotencyKey).toBeTruthy();
  });

  it("sends exactly one POST when Enter is pressed twice in a field", async () => {
    const user = userEvent.setup();
    const held = holdWrites();
    mount("/admin/refunds/new");
    fillRefund();
    await user.type(screen.getByLabelText(/Invoice/), "{Enter}{Enter}");
    await held.release();
    await waitFor(() => expect(where()).toBe("/admin/refunds"));
    expect(posted).toHaveLength(1);
  });

  it("locks the form with a spinner while the request is in flight", async () => {
    const held = holdWrites();
    mount("/admin/refunds/new");
    fillRefund();
    fireEvent.submit(form());
    const submit = await screen.findByRole("button", { name: /Submit request/ });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(true));
    expect(submit.getAttribute("aria-busy")).toBe("true");
    await held.release();
  });

  it("keeps the character counter in the hint and the error static, so typing never re-announces the alert", async () => {
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

    fireEvent.change(detail, { target: { value: "short" } });
    fireEvent.submit(form());
    const alert = await screen.findByText("Describe the reason in at least 40 characters.");
    fireEvent.change(detail, { target: { value: "still short" } });
    expect(screen.getByText("Describe the reason in at least 40 characters.")).toBe(alert);
    // The PHI warning stays beside the error, and the field is described by both.
    expect(described()).toMatch(/Do not include patient information\./);
    expect(described()).toMatch(/Describe the reason in at least 40 characters\./);
  });

  it("marks the fields it validates as required", () => {
    mount("/admin/refunds/new");
    for (const label of [/Invoice id/, /Amount/, /Reason detail/]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).required).toBe(true);
    }
  });
});

describe("pause subscription submit", () => {
  it("sends exactly one POST when submitted twice in a row", async () => {
    const held = holdWrites();
    mount(`/admin/subscriptions/${SUB}/pause`);
    await screen.findByRole("button", { name: "Pause subscription" });
    fireEvent.submit(form());
    fireEvent.submit(form());
    await held.release();
    await waitFor(() => expect(where()).toBe(`/admin/subscriptions/${SUB}`));
    expect(posted).toHaveLength(1);
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
    expect(where()).toBe(`/admin/subscriptions/${SUB}/pause`);
  });
});

describe("apply promo submit", () => {
  it("sends exactly one POST when submitted twice in a row", async () => {
    const held = holdWrites();
    mount(`/admin/subscriptions/${SUB}/apply_promo`);
    fireEvent.change(await screen.findByLabelText(/Promo code/), { target: { value: "LAUNCH25" } });
    fireEvent.submit(form());
    fireEvent.submit(form());
    await held.release();
    await waitFor(() => expect(where()).toBe(`/admin/subscriptions/${SUB}`));
    expect(posted).toHaveLength(1);
  });

  it("marks the promo code as required, and describes the field by its error once it is refused empty", async () => {
    mount(`/admin/subscriptions/${SUB}/apply_promo`);
    const code = (await screen.findByLabelText(/Promo code/)) as HTMLInputElement;
    expect(code.required).toBe(true);
    fireEvent.submit(form());
    await screen.findByText("Enter the promo code to apply.");
    expect(code.getAttribute("aria-invalid")).toBe("true");
    expect(posted).toHaveLength(0);
  });
});

describe("refund decision", () => {
  const open = async (status = "requested"): Promise<void> => {
    getReply = () => json({ ...requested, status });
    mount(`/admin/refunds/${REFUND}/approve`);
    await screen.findByRole("heading", { name: "Review refund" });
  };
  const approveButton = (): HTMLButtonElement =>
    screen.getByRole("button", { name: /Approve refund/ });
  const denyButton = (): HTMLButtonElement => screen.getByRole("button", { name: /Deny refund/ });
  const denyReason = (): HTMLTextAreaElement => screen.getByLabelText(/Deny reason/);

  it("approving sends one POST, locks both buttons, and shows the spinner on Approve only", async () => {
    const held = holdWrites();
    await open();
    fireEvent.click(approveButton());
    fireEvent.click(approveButton());
    fireEvent.click(denyButton());
    await waitFor(() => expect(approveButton().disabled).toBe(true));
    expect(denyButton().disabled).toBe(true);
    expect(approveButton().getAttribute("aria-busy")).toBe("true");
    expect(denyButton().getAttribute("aria-busy")).toBeNull();
    await held.release();
    await waitFor(() => expect(where()).toBe("/admin/refunds"));
    expect(posted.map((p) => p.path)).toEqual([`/api/admin/refunds/${REFUND}/approve`]);
    expect(posted[0]?.idempotencyKey).toBeTruthy();
  });

  it("denying sends one POST, locks both buttons and the reason, and shows the spinner on Deny only", async () => {
    const held = holdWrites();
    await open();
    fireEvent.change(denyReason(), { target: { value: "Duplicate of #4" } });
    fireEvent.click(denyButton());
    fireEvent.click(denyButton());
    fireEvent.click(approveButton());
    await waitFor(() => expect(denyButton().disabled).toBe(true));
    expect(approveButton().disabled).toBe(true);
    expect(denyButton().getAttribute("aria-busy")).toBe("true");
    expect(approveButton().getAttribute("aria-busy")).toBeNull();
    // The reason is what is being sent: it cannot be edited while the decision is in flight.
    expect(denyReason().readOnly).toBe(true);
    await held.release();
    await waitFor(() => expect(where()).toBe("/admin/refunds"));
    expect(posted.map((p) => p.path)).toEqual([`/api/admin/refunds/${REFUND}/deny`]);
  });

  it("denying without a reason sends nothing and unlocks the buttons", async () => {
    await open();
    fireEvent.click(denyButton());
    expect(await screen.findByText("Say why this refund is being denied.")).toBeTruthy();
    expect(posted).toHaveLength(0);
    expect(approveButton().disabled).toBe(false);
    expect(denyButton().disabled).toBe(false);
    expect(denyReason().readOnly).toBe(false);
  });

  it("marks the deny reason as required and says so in its hint, even when an error is showing", async () => {
    await open();
    expect(denyReason().required).toBe(true);
    fireEvent.click(denyButton());
    await screen.findByText("Say why this refund is being denied.");
    const described = (denyReason().getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual([
      "Required to deny a refund; leave it blank to approve.",
      "Say why this refund is being denied.",
    ]);
  });

  it("a refused approval re-enables both buttons and the reason, and returns focus to the button pressed", async () => {
    reply = () =>
      json({ error: { code: "REFUND_FOUR_EYES", message: "no", correlationId: "c" } }, 403);
    await open();
    approveButton().focus();
    fireEvent.click(approveButton());
    expect(
      await screen.findByText(/Four-eyes: you cannot approve a refund you requested/),
    ).toBeTruthy();
    expect(approveButton().disabled).toBe(false);
    expect(denyButton().disabled).toBe(false);
    expect(approveButton().getAttribute("aria-busy")).toBeNull();
    expect(denyReason().readOnly).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(approveButton()));
  });

  it("a refused denial returns focus to the Deny button", async () => {
    reply = () => json({ error: { code: "FORBIDDEN", message: "no", correlationId: "c" } }, 403);
    await open();
    fireEvent.change(denyReason(), { target: { value: "Duplicate of #4" } });
    denyButton().focus();
    fireEvent.click(denyButton());
    await screen.findByText("Could not deny the refund.");
    await waitFor(() => expect(document.activeElement).toBe(denyButton()));
  });

  it("a refund that is already decided offers no action", async () => {
    for (const status of ["approved", "denied", "executed_failed"]) {
      await open(status);
      expect(screen.getByText(/already/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Approve refund/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /Deny refund/ })).toBeNull();
      cleanup();
    }
  });

  it("a denial or failure does not wear the success tick", () => {
    // The icon is decorative (aria-hidden), so the mapping that picks it is what can be asserted.
    expect(DECIDED_REFUND_ICON.approved).toBeTruthy();
    expect(DECIDED_REFUND_ICON.denied).not.toBe(DECIDED_REFUND_ICON.approved);
    expect(DECIDED_REFUND_ICON.executed_failed).not.toBe(DECIDED_REFUND_ICON.approved);
    expect(DECIDED_REFUND_ICON.executed_failed).not.toBe(DECIDED_REFUND_ICON.denied);
  });
});

describe("after a successful write", () => {
  // Only setTimeout is faked: a delayed redirect would not have fired after a 1 ms advance, so reaching the destination
  // proves the navigation is immediate. (findBy*/waitFor wait on a setTimeout, so they cannot be used while it is faked.)
  const advance = (ms: number): Promise<void> =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const FLUSH_MS = 1;

  const submitPromo = async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mount(`/admin/subscriptions/${SUB}/apply_promo`);
    await advance(FLUSH_MS);
    fireEvent.change(screen.getByLabelText(/Promo code/), { target: { value: "LAUNCH25" } });
    fireEvent.submit(form());
    await advance(FLUSH_MS);
  };

  it("promo: navigates at once, replacing the form's entry, and announces the confirmation as a toast", async () => {
    await submitPromo();
    expect(where()).toBe(`/admin/subscriptions/${SUB}`);
    expect(how()).toBe("REPLACE");
    expect(toastText()).toBe('Promo "LAUNCH25" applied.');
    expect(posted).toHaveLength(1);
    // Back skips the form: the entry it occupied was replaced, so one step back is the page before it.
    back();
    await advance(FLUSH_MS);
    expect(screen.getByText("previous page")).toBeTruthy();
    expect(where()).toBe(PREVIOUS_PATH);
  });

  it("pause: navigates back to the subscription at once with a toast", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mount(`/admin/subscriptions/${SUB}/pause`);
    await advance(FLUSH_MS);
    fireEvent.submit(form());
    await advance(FLUSH_MS);
    expect(where()).toBe(`/admin/subscriptions/${SUB}`);
    expect(how()).toBe("REPLACE");
    expect(toastText()).toBe("Subscription paused.");
  });

  it("refund request: returns to the queue at once with the four-eyes confirmation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mount("/admin/refunds/new");
    for (const [label, value] of [
      [/Invoice/, INVOICE],
      [/Amount/, "25.00"],
      [/Reason detail/, "Customer asked for a partial refund, TICKET-9, see the thread."],
    ] as const) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.submit(form());
    await advance(FLUSH_MS);
    expect(where()).toBe("/admin/refunds");
    expect(how()).toBe("REPLACE");
    expect(toastText()).toBe("Refund request created — awaiting a distinct approver (four-eyes).");
  });

  it("refund decision: approving and denying each replace the page and toast their own outcome", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    getReply = () => json(requested);
    mount(`/admin/refunds/${REFUND}/approve`);
    await advance(FLUSH_MS);
    fireEvent.click(screen.getByRole("button", { name: /Approve refund/ }));
    await advance(FLUSH_MS);
    expect(where()).toBe("/admin/refunds");
    expect(how()).toBe("REPLACE");
    expect(toastText()).toBe("Refund approved — queued for execution.");
  });

  it("a write that lands after the operator left the page toasts but pulls nobody back", async () => {
    const held = holdWrites();
    mount(`/admin/subscriptions/${SUB}/pause`);
    await screen.findByRole("button", { name: "Pause subscription" });
    fireEvent.submit(form());
    await waitFor(() => expect(posted).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "leave the page" }));
    expect(where()).toBe("/away");
    await held.release();
    expect(await screen.findByText("Subscription paused.")).toBeTruthy();
    expect(where()).toBe("/away");
    expect(how()).toBe("PUSH");
    expect(posted).toHaveLength(1);
  });
});
