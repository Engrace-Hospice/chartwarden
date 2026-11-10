// @vitest-environment jsdom
// Step 3, BAA: read the agreement ChartWarden recorded; the compliance officer attests it (a fresh step-up).
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BaaPanel } from "./baa-panel";
import {
  COMPLIANCE_OFFICER,
  ORG_ADMIN,
  RETURNED_FROM_STEP_UP,
  deferred,
  keyOf,
  ok,
  panelProps,
  refused,
  renderAt,
  stubClient,
  wizardStep,
  wizardView,
} from "./test-support";

const LIST = "/api/v1/tenant/baa";
const ATTEST = "/api/v1/tenant/baa/{id}/attest";
const view = wizardView([wizardStep("baa_executed", 1)]);
const record = (over: Record<string, unknown> = {}) => ({
  id: "baa-1",
  tenantAccountId: "ta-1",
  addendumVersion: "2026-1",
  baaStatus: "executed",
  executedOn: "2026-10-01",
  effectiveOn: "2026-10-01",
  expiresOn: null,
  attestedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  ...over,
});
const page = (...items: unknown[]) => ok({ items, nextCursor: null, hasMore: false });

function mount(
  client: ReturnType<typeof stubClient>,
  session = COMPLIANCE_OFFICER,
  at: Parameters<typeof renderAt>[0] = "/x",
  onChanged = vi.fn(async () => undefined),
) {
  const view_ = renderAt(
    at,
    [
      {
        path: "/x",
        element: <BaaPanel {...panelProps(view, "baa_executed", session, onChanged)} />,
      },
    ],
    client,
    session,
  );
  return { onChanged, ...view_ };
}
const tick = async (): Promise<void> => {
  fireEvent.click(await screen.findByRole("checkbox", { name: /this agreement is correct/i }));
};
const attest = (): void => {
  fireEvent.submit(screen.getByRole("form", { name: "Attest the BAA" }));
};

describe("BaaPanel", () => {
  it("shows the recorded agreement and its facts", async () => {
    mount(
      stubClient({
        GET: { [LIST]: () => page(record({ attestedAt: "2026-10-02T00:00:00.000Z" })) },
      }),
    );
    expect(await screen.findByText("2026-1")).toBeTruthy();
    expect(screen.getByText("The BAA is executed")).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Attest the BAA" })).toBeNull();
  });

  it("lets the compliance officer attest, with an Idempotency-Key, and reloads", async () => {
    const client = stubClient({
      GET: { [LIST]: () => page(record()) },
      POST: { [ATTEST]: () => ok(record({ attestedAt: "now" })) },
    });
    const { onChanged } = mount(client);
    await tick();
    attest();

    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    const [path, init] = client.POST.mock.calls[0] as [string, { params: unknown; body: unknown }];
    expect(path).toBe(ATTEST);
    expect(init.params).toEqual({ path: { id: "baa-1" } });
    expect(init.body).toEqual({ attestationConfirmed: true });
    expect(keyOf(client.POST.mock.calls[0] as unknown[])).toMatch(/\S+/);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("says what to do when the server refuses", async () => {
    const client = stubClient({
      GET: { [LIST]: () => page(record()) },
      POST: { [ATTEST]: () => refused(409, "ONBOARDING_TASK_CHANGED") },
    });
    mount(client);
    await tick();
    attest();
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /changed while you were looking at it/i,
    );
  });

  it("offers Re-verify on a stale step-up and keeps the confirmation on return", async () => {
    const client = stubClient({
      GET: { [LIST]: () => page(record()) },
      POST: { [ATTEST]: () => refused(403, "STEP_UP_REQUIRED") },
    });
    const first = mount(client);
    await tick();
    attest();
    fireEvent.click(await screen.findByRole("link", { name: "Re-verify" }));
    expect(await screen.findByText("step-up page")).toBeTruthy();
    first.unmount();

    mount(client, COMPLIANCE_OFFICER, RETURNED_FROM_STEP_UP);
    const box = (await screen.findByRole("checkbox", {
      name: /this agreement is correct/i,
    })) as HTMLInputElement;
    expect(box.checked).toBe(true);
  });

  it("drops a second submit while the first is in flight", async () => {
    const gate = deferred(ok(record({ attestedAt: "now" })));
    const client = stubClient({
      GET: { [LIST]: () => page(record()) },
      POST: { [ATTEST]: gate.handler },
    });
    mount(client);
    await tick();
    attest();
    attest();
    gate.release();
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
  });

  it("reuses the same Idempotency-Key when the first attempt got no answer", async () => {
    let calls = 0;
    const client = stubClient({
      GET: { [LIST]: () => page(record()) },
      POST: {
        [ATTEST]: () => {
          calls += 1;
          if (calls === 1) throw new Error("offline");
          return ok(record({ attestedAt: "now" }));
        },
      },
    });
    mount(client);
    await tick();
    attest();
    await screen.findByText(/could not reach the server/i);
    attest();
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(2));
    expect(keyOf(client.POST.mock.calls[1] as unknown[])).toBe(
      keyOf(client.POST.mock.calls[0] as unknown[]),
    );
  });

  it("is read-only for the administrator: no attest form, and says who attests", async () => {
    mount(stubClient({ GET: { [LIST]: () => page(record()) } }), ORG_ADMIN);
    expect(await screen.findByText(/your compliance officer attests the baa/i)).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Attest the BAA" })).toBeNull();
  });
});
