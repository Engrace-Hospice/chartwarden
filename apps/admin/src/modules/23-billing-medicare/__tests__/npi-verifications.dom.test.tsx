import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
// ADR-0053 amendment precondition 2 — the platform NPI-verification list: shows every tenant's provider entities with
// their state, verifies one (the NPI shown + the operator's evidence, with an Idempotency-Key), revokes a verified one,
// and offers Re-verify on STEP_UP_REQUIRED. Synthetic NPIs and names only.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { NpiVerifications } from "../npi-verifications";

const PE_A = "11111111-1111-4111-8111-111111111111";
const PE_B = "22222222-2222-4222-8222-222222222222";
const base = {
  organizationId: "33333333-3333-4333-8333-333333333333",
  verificationId: null,
  evidence: null,
  verifiedAt: null,
  verifiedByMembershipId: null,
  revokedAt: null,
  revokedByMembershipId: null,
};
const unverified = {
  ...base,
  providerEntityId: PE_A,
  organizationName: "Synthetic Org A",
  legalName: "Synthetic Hospice A",
  npi: "1234567893",
  state: "unverified",
};
const verified = {
  ...base,
  providerEntityId: PE_B,
  organizationName: "Synthetic Org B",
  legalName: "Synthetic Hospice B",
  npi: "1999999984",
  state: "verified",
  verificationId: "44444444-4444-4444-8444-444444444444",
  verifiedAt: "2026-11-05T12:00:00.000Z",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Seen {
  method: string;
  path: string;
  body: unknown;
  idempotencyKey: string | null;
}

function mount(onPost?: (path: string) => Response): Seen[] {
  const seen: Seen[] = [];
  let rows: unknown[] = [unverified, verified];
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input as RequestInfo, init);
    const text = await req.text();
    const path = new URL(req.url).pathname;
    seen.push({
      method: req.method,
      path,
      body: text ? JSON.parse(text) : undefined,
      idempotencyKey: req.headers.get("Idempotency-Key"),
    });
    if (req.method === "GET") return json(rows);
    const refused = onPost?.(path);
    if (refused) return refused;
    if (path.endsWith("/verify")) {
      rows = [{ ...unverified, state: "verified", verifiedAt: verified.verifiedAt }, verified];
      return json(rows[0]);
    }
    rows = [unverified, { ...verified, state: "revoked", revokedAt: verified.verifiedAt }];
    return json(rows[1]);
  };
  render(
    <MemoryRouter>
      <ApiClientProvider
        client={createApiClient({ baseUrl: "http://localhost", fetch: fetchStub })}
      >
        <NpiVerifications />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return seen;
}

afterEach(cleanup);

describe("NPI verification (ADR-0053 amendment)", () => {
  it("lists each provider entity with its verification state", async () => {
    mount();
    const rowA = (await screen.findByText("Synthetic Hospice A")).closest("tr") as HTMLElement;
    expect(within(rowA).getByText("Not verified")).toBeTruthy();
    expect(within(rowA).getByText("1234567893")).toBeTruthy();
    const rowB = screen.getByText("Synthetic Hospice B").closest("tr") as HTMLElement;
    expect(within(rowB).getByText("Verified")).toBeTruthy();
  });

  it("verifies the NPI shown, with the operator's evidence and an Idempotency-Key", async () => {
    const seen = mount();
    fireEvent.click(await screen.findByRole("button", { name: /Verify NPI 1234567893/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Verify NPI" }));
    expect(await screen.findByText(/Say how you confirmed ownership/)).toBeTruthy();
    expect(seen.some((s) => s.method === "POST")).toBe(false);
    fireEvent.change(within(dialog).getByLabelText(/How you confirmed it/), {
      target: { value: "NPPES record matches; called listed contact" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Verify NPI" }));
    expect(await screen.findByText(/Verified NPI 1234567893/)).toBeTruthy();
    const post = seen.find((s) => s.method === "POST");
    expect(post).toMatchObject({
      path: `/api/v1/admin/billing/npi-verifications/${PE_A}/verify`,
      body: { npi: "1234567893", evidence: "NPPES record matches; called listed contact" },
    });
    expect(post?.idempotencyKey).toBeTruthy();
  });

  it("revokes a verified NPI", async () => {
    const seen = mount();
    fireEvent.click(await screen.findByRole("button", { name: /Revoke NPI 1999999984/ }));
    expect(await screen.findByText(/Revoked NPI 1999999984/)).toBeTruthy();
    await waitFor(() =>
      expect(
        seen.some(
          (s) =>
            s.method === "POST" &&
            s.path === `/api/v1/admin/billing/npi-verifications/${PE_B}/revoke` &&
            s.idempotencyKey,
        ),
      ).toBe(true),
    );
    const rowB = screen.getByText("Synthetic Hospice B").closest("tr") as HTMLElement;
    expect(await within(rowB).findByText("Revoked")).toBeTruthy();
  });

  it("offers Re-verify when the session needs a fresh step-up", async () => {
    mount(() => json({ error: { code: "STEP_UP_REQUIRED", message: "step up" } }, 403));
    fireEvent.click(await screen.findByRole("button", { name: /Revoke NPI 1999999984/ }));
    expect(await screen.findByText(/needs a fresh verification/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Re-verify" })).toBeTruthy();
  });
});
