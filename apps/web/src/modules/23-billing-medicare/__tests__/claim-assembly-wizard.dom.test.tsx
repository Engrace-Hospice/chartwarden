// The Medicare claim assembly screen (one compact form): it sends exactly the existing assemble body, opens the new
// claim in the existing editor by id, surfaces a server refusal inline without leaving, and never assembles from an
// incomplete or backwards request. The lookup fields are stubbed as plain inputs (they have their own tests).
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAllDrafts } from "../write-workflow";

vi.mock("../../../shell/entity-lookups", () => {
  const field =
    (id: string) =>
    ({
      label,
      value,
      onChange,
    }: { label: string; value: string; onChange: (v: string) => void }) => (
      <input
        aria-label={label}
        data-testid={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  return { ProviderEntityLookupField: field("pe"), PatientLookupField: field("pt") };
});

import { ClaimAssemblyWizard } from "../claim-assembly-wizard";

afterEach(() => {
  cleanup();
  clearAllDrafts();
});

function mount(post: ReturnType<typeof vi.fn>) {
  const client = {
    POST: post,
    GET: vi.fn(async () => ({ data: { items: [] } })),
  } as unknown as ApiClient;
  render(
    <ApiClientProvider client={client}>
      <MemoryRouter initialEntries={["/billing/claims/new"]}>
        <Routes>
          <Route path="/billing/claims/new" element={<ClaimAssemblyWizard />} />
          <Route path="/billing/claims/:claimId" element={<p>editor opened</p>} />
        </Routes>
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

function fill(over: { from?: string; to?: string } = {}) {
  fireEvent.change(screen.getByLabelText("Provider entity"), { target: { value: "pe1" } });
  fireEvent.change(screen.getByLabelText("Patient"), { target: { value: "pt1" } });
  fireEvent.change(screen.getByLabelText("Service from"), {
    target: { value: over.from ?? "2026-10-01" },
  });
  fireEvent.change(screen.getByLabelText("Service to"), {
    target: { value: over.to ?? "2026-10-31" },
  });
}
const button = () => screen.getByRole("button", { name: /assemble claim|assembling/i });

describe("ClaimAssemblyWizard", () => {
  it("cannot assemble until provider, patient and both dates are given, or when the dates run backwards", () => {
    mount(vi.fn());
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    fill({ from: "2026-11-01", to: "2026-10-01" });
    expect(screen.getByRole("alert").textContent).toMatch(/on or before/);
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    fill();
    expect((button() as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends exactly the assemble body and opens the new claim in the editor", async () => {
    const post = vi.fn(async () => ({
      data: { claimId: "c-new" },
      response: new Response(null, { status: 201 }),
    }));
    mount(post);
    fill();
    fireEvent.click(screen.getByLabelText(/813/));
    fireEvent.click(button());
    expect(await screen.findByText("editor opened")).toBeTruthy();
    expect(post).toHaveBeenCalledWith("/api/v1/billing/claims/assemble", {
      body: {
        providerEntityId: "pe1",
        patientId: "pt1",
        serviceFrom: "2026-10-01",
        serviceTo: "2026-10-31",
        tob: "813",
      },
    });
  });

  it("shows a server refusal inline and stays on the form", async () => {
    const post = vi.fn(async () => ({
      data: undefined,
      error: { error: { code: "NON_MEDICARE_PRIMARY_PAYER", message: "x" } },
      response: new Response(null, { status: 409 }),
    }));
    mount(post);
    fill();
    fireEvent.click(button());
    await waitFor(() =>
      expect(
        screen.getByText(/primary payer|Medicare/i, { selector: "[role=alert]" }),
      ).toBeTruthy(),
    );
    expect(screen.queryByText("editor opened")).toBeNull();
    expect((button() as HTMLButtonElement).disabled).toBe(false);
  });

  it("recovers from a thrown request: says so inline and lets the user try again", async () => {
    mount(vi.fn(async () => Promise.reject(new Error("network"))));
    fill();
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect((button() as HTMLButtonElement).disabled).toBe(false);
  });

  it("restores the in-progress form after leaving and coming back", () => {
    mount(vi.fn());
    fill();
    cleanup();
    mount(vi.fn());
    expect((screen.getByLabelText("Patient") as HTMLInputElement).value).toBe("pt1");
    expect((screen.getByLabelText("Service to") as HTMLInputElement).value).toBe("2026-10-31");
  });
});
