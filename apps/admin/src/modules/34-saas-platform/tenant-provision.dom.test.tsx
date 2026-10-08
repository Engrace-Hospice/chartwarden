// apps/admin/src/modules/34-saas-platform — "New tenant" used to be a browser alert() placeholder. The drawer posts
// the six fields the route requires, and a step-up refusal must keep what was typed and offer Re-verify rather than
// claim success or wipe the form.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, createApiClient } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantProvisionDrawer } from "./tenant-provision";

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

function mount(respond: () => Response): { calls: Recorded[]; onAccepted: () => void } {
  const calls: Recorded[] = [];
  const onAccepted = vi.fn();
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(await req.clone().text()) as Record<string, unknown>;
      } catch {
        body = null;
      }
      calls.push({ method: req.method, path: new URL(req.url).pathname, body });
      return respond();
    },
  });
  render(
    <ApiClientProvider client={client}>
      <MemoryRouter initialEntries={["/tenants?tenant=new"]}>
        <TenantProvisionDrawer onClose={() => undefined} onAccepted={onAccepted} />
      </MemoryRouter>
    </ApiClientProvider>,
  );
  return { calls, onAccepted };
}

function fill(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function fillAll(): void {
  fill("Legal business name", "  Cedar Ridge Hospice LLC ");
  fill("Billing contact email", "billing@cedar.example");
  fill("Breach notification email", "privacy@cedar.example");
  fill("First admin full name", "Ada Admin");
  fill("First admin email", "ada@cedar.example");
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => cleanup());

describe("TenantProvisionDrawer", () => {
  it("keeps Provision disabled until every field is valid", () => {
    mount(() => json(202, {}));
    const submit = screen.getByRole("button", { name: "Provision tenant" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fillAll();
    expect(submit.disabled).toBe(false);
    fill("Billing contact email", "not-an-email");
    expect(submit.disabled).toBe(true);
  });

  it("posts the trimmed fields and reports the request as accepted", async () => {
    const { calls, onAccepted } = mount(() => json(202, { accepted: true }));
    fillAll();
    fireEvent.click(screen.getByRole("button", { name: "Provision tenant" }));
    await waitFor(() => expect(onAccepted).toHaveBeenCalled());
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/v1/platform/tenants",
        body: {
          legalBusinessName: "Cedar Ridge Hospice LLC",
          billingContactEmail: "billing@cedar.example",
          breachNotificationContactEmail: "privacy@cedar.example",
          firstAdminEmail: "ada@cedar.example",
          firstAdminFullName: "Ada Admin",
          planLabel: "standard",
        },
      },
    ]);
    expect(await screen.findByText(/Provisioning requested/)).toBeTruthy();
  });

  it("a step-up refusal keeps the typed values and offers Re-verify", async () => {
    const { onAccepted } = mount(() =>
      json(403, { error: { code: "STEP_UP_REQUIRED", message: "step up", correlationId: "c" } }),
    );
    fillAll();
    fireEvent.click(screen.getByRole("button", { name: "Provision tenant" }));
    expect(await screen.findByRole("link", { name: "Re-verify" })).toBeTruthy();
    expect(onAccepted).not.toHaveBeenCalled();
    expect((screen.getByLabelText("First admin email") as HTMLInputElement).value).toBe(
      "ada@cedar.example",
    );
  });
});
