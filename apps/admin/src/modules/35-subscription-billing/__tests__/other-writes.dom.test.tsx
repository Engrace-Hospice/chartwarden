import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — the console's other platform writes (revenue recompute, dunning overrides, webhook
// replay, promo create/deactivate, plan create) behave like the money writes:
//   - success is "no error AND response.ok": an empty-body gateway 502 is a failure, not a success line;
//   - a request that never gets an answer releases the lock and says so (no endless spinner);
//   - the Idempotency-Key is held per write intent: a retry after no answer replays the SAME key (the first request may have landed and
//     only the reply been lost), a changed intent gets a new key, and any answer (success or refusal) renews it.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { Dunning } from "../dunning";
import { PlansList } from "../plans-list";
import { Promos } from "../promos";
import { Revenue } from "../revenue";
import { Webhooks } from "../webhooks";

const SUB = "44444444-4444-4444-8444-444444444444";
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The Nth write attempt (1-based) answers with a Response, or throws (no answer: offline). */
type Writer = (attempt: number) => Response;
const gateway502: Writer = () =>
  new Response(null, { status: 502, headers: { "content-length": "0" } });
const offline: Writer = () => {
  throw new TypeError("Failed to fetch");
};
const accepted = (): Response => json({ id: "r1" }, 200);
const refused = (): Response =>
  json({ error: { code: "FORBIDDEN", message: "no", correlationId: "c" } }, 403);
const dropThen =
  (answer: () => Response): Writer =>
  (attempt) =>
    attempt === 1 ? offline(attempt) : answer();

const current = {
  mrrCents: 120000,
  arrCents: 1440000,
  activeSubscriptions: 12,
  asOf: "2026-11-01T00:00:00.000Z",
};
const dunningRow = {
  subscriptionId: SUB,
  organizationId: SUB,
  organizationName: "Cedar Ridge",
  planName: "Pro Monthly",
  stage: "day_7",
  enteredAt: "2026-11-01T00:00:00.000Z",
  nextAttemptAt: null,
};
const receipt = {
  stripeEventId: "evt_123",
  eventType: "invoice.paid",
  receivedAt: "2026-11-01T00:00:00.000Z",
  processedAt: null,
  processingAttemptCount: 1,
};
const promo = {
  id: SUB,
  code: "SPRING",
  percentOff: 20,
  fixedOffCents: null,
  duration: "once",
  durationInMonths: null,
  redemptionCount: 3,
  maxRedemptions: null,
  isActive: true,
};

interface Sent {
  readonly key: string | null;
}

function mount(element: JSX.Element, write: Writer, entry = "/x"): { writes: Sent[] } {
  const writes: Sent[] = [];
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (req.method !== "GET") {
      writes.push({ key: req.headers.get("Idempotency-Key") });
      return write(writes.length);
    }
    const path = new URL(req.url).pathname;
    if (path === "/api/admin/revenue/current") return json(current);
    if (path === "/api/admin/revenue/snapshots")
      return json({ items: [], nextCursor: null, hasMore: false });
    if (path === "/api/admin/webhooks/stripe/recent")
      return json({ items: [receipt], nextCursor: null, hasMore: false });
    if (path === "/api/admin/promos") return json([promo]);
    if (path === "/api/admin/plans") return json([]);
    return json({ items: [dunningRow], nextCursor: null, hasMore: false });
  };
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: fetchStub })}>
      <ToastProvider>
        <MemoryRouter initialEntries={[entry]}>{element}</MemoryRouter>
      </ToastProvider>
    </ApiClientProvider>,
  );
  return { writes };
}

const button = (name: RegExp | string): HTMLButtonElement =>
  screen.getByRole("button", { name }) as HTMLButtonElement;
const idle = (b: HTMLButtonElement): boolean => !b.disabled && b.getAttribute("aria-busy") === null;
/** Press `name` once it is idle (a previous attempt has settled). */
async function press(name: RegExp | string): Promise<void> {
  await waitFor(() => expect(idle(button(name))).toBe(true));
  fireEvent.click(button(name));
}
const UNREACHABLE = /Could not reach the server/;

afterEach(cleanup);

describe("revenue recompute", () => {
  it("an empty-body 502 is a failure, not 'recomputed'", async () => {
    mount(<Revenue />, gateway502);
    fireEvent.click(await screen.findByRole("button", { name: "Recompute" }));
    expect(await screen.findByText("Could not recompute revenue.")).toBeTruthy();
    expect(screen.queryByText("Revenue snapshot recomputed.")).toBeNull();
  });

  it("no answer at all releases the button and says the server was not reached", async () => {
    mount(<Revenue />, offline);
    fireEvent.click(await screen.findByRole("button", { name: "Recompute" }));
    expect(await screen.findByText(UNREACHABLE)).toBeTruthy();
    await waitFor(() => expect(idle(button("Recompute"))).toBe(true));
  });

  it("a retry after no answer replays the key; a success renews it for the next recompute", async () => {
    const { writes } = mount(<Revenue />, dropThen(accepted));
    await screen.findByRole("button", { name: "Recompute" });
    await press("Recompute");
    await screen.findByText(UNREACHABLE);
    await press("Recompute");
    await screen.findByText("Revenue snapshot recomputed.");
    expect(writes[1]?.key).toBe(writes[0]?.key);
    await press("Recompute");
    await waitFor(() => expect(writes).toHaveLength(3));
    expect(writes[2]?.key).not.toBe(writes[0]?.key);
  });

  it("a refusal renews the key: the next attempt is a new intent, not a replay of the cached refusal", async () => {
    const { writes } = mount(<Revenue />, refused);
    await screen.findByRole("button", { name: "Recompute" });
    await press("Recompute");
    await screen.findByText("Could not recompute revenue.");
    await press("Recompute");
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.key).not.toBe(writes[0]?.key);
  });
});

describe("dunning overrides", () => {
  it("an empty-body 502 is a failure, not 'reset'", async () => {
    mount(<Dunning />, gateway502);
    fireEvent.click(await screen.findByRole("button", { name: "Reset" }));
    expect(await screen.findByText("Could not reset.")).toBeTruthy();
    expect(screen.queryByText("Dunning reset.")).toBeNull();
  });

  it("no answer at all releases the row's buttons", async () => {
    mount(<Dunning />, offline);
    fireEvent.click(await screen.findByRole("button", { name: "Skip stage" }));
    expect(await screen.findByText(UNREACHABLE)).toBeTruthy();
    await waitFor(() => expect(idle(button("Skip stage"))).toBe(true));
  });

  it("the same override replays its key after no answer; another override is a new intent", async () => {
    const { writes } = mount(<Dunning />, offline);
    await screen.findByRole("button", { name: "Skip stage" });
    await press("Skip stage");
    await screen.findByText(UNREACHABLE);
    await press("Skip stage");
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.key).toBe(writes[0]?.key);
    await press("Reset");
    await waitFor(() => expect(writes).toHaveLength(3));
    expect(writes[2]?.key).not.toBe(writes[0]?.key);
  });
});

describe("stripe webhook replay", () => {
  it("a retry after no answer replays the key (no second replay if the first landed), a refusal renews it", async () => {
    const { writes } = mount(<Webhooks />, offline);
    await screen.findByRole("button", { name: "Replay" });
    await press("Replay");
    await screen.findByText(UNREACHABLE);
    await press("Replay");
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.key).toBe(writes[0]?.key);
    cleanup();

    const answered = mount(<Webhooks />, refused);
    await screen.findByRole("button", { name: "Replay" });
    await press("Replay");
    await screen.findByText("Could not replay this event.");
    await press("Replay");
    await waitFor(() => expect(answered.writes).toHaveLength(2));
    expect(answered.writes[1]?.key).not.toBe(answered.writes[0]?.key);
  });

  it("an empty-body 502 is a failure, not 're-enqueued'", async () => {
    mount(<Webhooks />, gateway502);
    fireEvent.click(await screen.findByRole("button", { name: "Replay" }));
    expect(await screen.findByText("Could not replay this event.")).toBeTruthy();
    expect(screen.queryByText(/re-enqueued/)).toBeNull();
  });
});

describe("promos", () => {
  it("deactivate: a retry after no answer replays the key; an answer renews it", async () => {
    const { writes } = mount(<Promos />, dropThen(refused), `/x?promo=${SUB}`);
    await screen.findByRole("complementary", { name: "Promo code" });
    await press("Deactivate");
    await screen.findByText(UNREACHABLE);
    await press("Deactivate");
    await screen.findByText("Could not deactivate this promo.");
    expect(writes[1]?.key).toBe(writes[0]?.key);
    await press("Deactivate");
    await waitFor(() => expect(writes).toHaveLength(3));
    expect(writes[2]?.key).not.toBe(writes[0]?.key); // the refusal at attempt 2 was an answer
  });

  it("create: the same unchanged promo replays its key, a changed one gets a new key", async () => {
    const { writes } = mount(<Promos />, offline);
    fireEvent.click(await screen.findByRole("button", { name: "New promo" }));
    await screen.findByRole("complementary", { name: "New promo" });
    const set = (label: RegExp, value: string): void => {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    };
    set(/^Code/, "LAUNCH25");
    set(/^Percent/, "25");
    await press("Create promo");
    await screen.findByText(UNREACHABLE);
    await press("Create promo");
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.key).toBe(writes[0]?.key);
    set(/^Percent/, "30");
    await press("Create promo");
    await waitFor(() => expect(writes).toHaveLength(3));
    expect(writes[2]?.key).not.toBe(writes[0]?.key);
  });
});

describe("plans list: create plan", () => {
  it("the same unchanged plan replays its key after no answer, so a lost reply cannot create two drafts; a changed plan is new", async () => {
    const { writes } = mount(<PlansList />, offline);
    fireEvent.click(await screen.findByRole("button", { name: "New plan" }));
    await screen.findByRole("complementary", { name: "New plan" });
    const set = (label: string, value: string): void => {
      fireEvent.change(screen.getByLabelText(new RegExp(`^${label.replace(/[()]/g, "\\$&")}`)), {
        target: { value },
      });
    };
    set("Slug", "team");
    set("Name", "Team");
    set("Base price (USD)", "12.34");
    await press("Create draft");
    await screen.findByText(UNREACHABLE);
    await press("Create draft");
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.key).toBe(writes[0]?.key);
    set("Base price (USD)", "15.00");
    await press("Create draft");
    await waitFor(() => expect(writes).toHaveLength(3));
    expect(writes[2]?.key).not.toBe(writes[0]?.key);
  });
});
