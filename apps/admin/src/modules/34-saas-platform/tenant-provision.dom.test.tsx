import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
// apps/admin/src/modules/34-saas-platform — "New tenant" used to be a browser alert() placeholder. The drawer posts
// the six fields the route requires, and a step-up refusal must keep what was typed and offer Re-verify rather than
// claim success or wipe the form.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  // Required fields carry a visible "*" after the label text, so match the start of it.
  fireEvent.change(screen.getByLabelText(new RegExp(`^${label}`)), { target: { value } });
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

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe("TenantProvisionDrawer", () => {
  it("explains what is missing instead of silently disabling Provision (#597)", async () => {
    const { calls } = mount(() => json(202, {}));
    const submit = screen.getByRole("button", { name: "Provision tenant" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(screen.queryByText("Enter the billing contact email.")).toBeNull();
    fireEvent.click(submit);
    expect(await screen.findByText("Enter the billing contact email.")).toBeTruthy();
    expect(screen.getByText(/Enter the legal business name/)).toBeTruthy();
    expect(calls).toEqual([]);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText(/^Legal business name/)),
    );
    fillAll();
    fill("Billing contact email", "not-an-email");
    fireEvent.click(submit);
    expect(await screen.findByText(/Enter a valid email address/)).toBeTruthy();
    expect(calls).toEqual([]);
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
    // Queued, not created yet: a second click must not enqueue a duplicate provision.
    const again = screen.getByRole("button", { name: "Requested" }) as HTMLButtonElement;
    expect(again.disabled).toBe(true);
    fireEvent.click(again);
    expect(calls).toHaveLength(1);
  });

  it("sends the optional subdomain trimmed, and refuses a reserved or malformed one before posting", async () => {
    const { calls } = mount(() => json(202, {}));
    fillAll();
    fill("Subdomain", "admin");
    fireEvent.click(screen.getByRole("button", { name: "Provision tenant" }));
    expect(await screen.findByText(/reserved/)).toBeTruthy();
    fill("Subdomain", "Bad_Slug");
    fireEvent.click(screen.getByRole("button", { name: "Provision tenant" }));
    expect(await screen.findByText(/lowercase letters/)).toBeTruthy();
    expect(calls).toEqual([]);
    fill("Subdomain", " sunrise ");
    fireEvent.click(screen.getByRole("button", { name: "Provision tenant" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({ slug: "sunrise" });
  });

  it("a step-up refusal keeps the typed values and offers Re-verify", async () => {
    const { onAccepted } = mount(() =>
      json(403, { error: { code: "STEP_UP_REQUIRED", message: "step up", correlationId: "c" } }),
    );
    fillAll();
    fireEvent.click(screen.getByRole("button", { name: "Provision tenant" }));
    expect(await screen.findByRole("link", { name: "Re-verify" })).toBeTruthy();
    expect(onAccepted).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/^First admin email/) as HTMLInputElement).value).toBe(
      "ada@cedar.example",
    );
  });

  it("restores the typed values after the Re-verify round trip", async () => {
    mount(() =>
      json(403, { error: { code: "STEP_UP_REQUIRED", message: "step up", correlationId: "c" } }),
    );
    fillAll();
    fireEvent.click(screen.getByRole("button", { name: "Provision tenant" }));
    fireEvent.click(await screen.findByRole("link", { name: "Re-verify" }));
    cleanup();
    mount(() => json(202, {}));
    expect((screen.getByLabelText(/^Legal business name/) as HTMLInputElement).value).toBe(
      "  Cedar Ridge Hospice LLC ",
    );
    expect((screen.getByLabelText(/^First admin email/) as HTMLInputElement).value).toBe(
      "ada@cedar.example",
    );
  });

  it("shows the server's reason when provisioning is refused (e.g. a duplicate name)", async () => {
    const { onAccepted } = mount(() =>
      json(409, {
        error: {
          code: "CONFLICT",
          message: "a tenant with that legal name already exists",
          correlationId: "c",
        },
      }),
    );
    fillAll();
    fireEvent.click(screen.getByRole("button", { name: "Provision tenant" }));

    expect(await screen.findByText(/already exists/)).toBeTruthy();
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it("a network failure shows a retryable message and re-enables the button", async () => {
    mount(() => {
      throw new Error("offline");
    });
    fillAll();
    fireEvent.click(screen.getByRole("button", { name: "Provision tenant" }));

    expect(await screen.findByText(/could not reach the server/i)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Provision tenant" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("points the operator at the tenant to follow provisioning progress", async () => {
    mount(() => json(202, { tenantAccountId: "t-1", jobId: "j" }));
    fillAll();
    fireEvent.click(screen.getByRole("button", { name: "Provision tenant" }));

    expect(await screen.findByText(/open the tenant to follow its progress/i)).toBeTruthy();
  });
});
