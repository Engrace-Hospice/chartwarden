// #851 — the claim assembly screen checks the patient's payer coverage as soon as a patient is chosen, shows the
// outcome (role=status / role=alert), blocks assemble where the server would refuse, and ignores a stale response.
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyPayerCoverage } from "../payer-preflight";
import type { PayerCoverageRow } from "../payer-preflight";
import { clearAllDrafts } from "../write-workflow";

vi.mock("../../../shell/entity-lookups", () => {
  const field =
    () =>
    ({
      label,
      value,
      onChange,
    }: { label: string; value: string; onChange: (v: string) => void }) => (
      <input aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
    );
  return { ProviderEntityLookupField: field(), PatientLookupField: field() };
});

import { ClaimAssemblyWizard } from "../claim-assembly-wizard";

afterEach(() => {
  cleanup();
  clearAllDrafts();
});

const row = (over: Partial<PayerCoverageRow> = {}): PayerCoverageRow => ({
  coverageKind: "medicare_ffs",
  rank: 1,
  current: true,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  ...over,
});

function mount(get: ReturnType<typeof vi.fn>, post: ReturnType<typeof vi.fn> = vi.fn()) {
  const client = { GET: get, POST: post } as unknown as ApiClient;
  render(
    <ApiClientProvider client={client}>
      <MemoryRouter>
        <ClaimAssemblyWizard />
      </MemoryRouter>
    </ApiClientProvider>,
  );
}
const payers = (...rows: PayerCoverageRow[]) => vi.fn(async () => ({ data: { payers: rows } }));
function fill(patient = "pt1") {
  fireEvent.change(screen.getByLabelText("Provider entity"), { target: { value: "pe1" } });
  fireEvent.change(screen.getByLabelText("Patient"), { target: { value: patient } });
  fireEvent.change(screen.getByLabelText("Service from"), { target: { value: "2026-10-01" } });
  fireEvent.change(screen.getByLabelText("Service to"), { target: { value: "2026-10-31" } });
}
const assemble = () => screen.getByRole("button", { name: /assemble claim/i }) as HTMLButtonElement;

describe("classifyPayerCoverage", () => {
  it("is ok for Original Medicare ranked 1 covering the range", () => {
    expect(classifyPayerCoverage([row()], "2026-10-01", "2026-10-31")).toBe("ok");
  });
  it("is no-medicare with no covering medicare_ffs row", () => {
    expect(classifyPayerCoverage([], "2026-10-01", "2026-10-31")).toBe("no-medicare");
    expect(
      classifyPayerCoverage([row({ effectiveTo: "2026-10-15" })], "2026-10-01", "2026-10-31"),
    ).toBe("no-medicare");
  });
  it("is non-primary when medicare_ffs is ranked below another payer", () => {
    expect(classifyPayerCoverage([row({ rank: 2 })], "2026-10-01", "2026-10-31")).toBe(
      "non-primary",
    );
  });
  it("is medicare-advantage when only MA, or MA outranks FFS", () => {
    const ma = row({ coverageKind: "medicare_advantage" });
    expect(classifyPayerCoverage([ma], "2026-10-01", "2026-10-31")).toBe("medicare-advantage");
    expect(classifyPayerCoverage([ma, row({ rank: 2 })], "2026-10-01", "2026-10-31")).toBe(
      "medicare-advantage",
    );
  });
});

describe("ClaimAssemblyWizard payer preflight", () => {
  it("announces loading, then ok, and leaves assemble enabled", async () => {
    mount(payers(row()));
    fill();
    expect(screen.getByRole("status").textContent).toMatch(/checking/i);
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/primary payer/i));
    expect(assemble().disabled).toBe(false);
  });

  it("blocks assemble with an alert when there is no Medicare coverage", async () => {
    mount(payers());
    fill();
    const alert = await screen.findByText(/No Original Medicare/i);
    expect(alert.getAttribute("role")).toBe("alert");
    expect(assemble().disabled).toBe(true);
  });

  it("blocks assemble when Medicare is not the primary payer", async () => {
    mount(payers(row({ rank: 2 })));
    fill();
    expect((await screen.findByText(/not the primary payer/i)).getAttribute("role")).toBe("alert");
    expect(assemble().disabled).toBe(true);
  });

  it("does not block when the check itself fails (server stays authoritative)", async () => {
    mount(vi.fn(async () => Promise.reject(new Error("net"))));
    fill();
    await screen.findByText(/could not be checked/i);
    expect(assemble().disabled).toBe(false);
  });

  it("does not block on an error response either", async () => {
    mount(vi.fn(async () => ({ data: undefined, error: { error: { code: "X" } } })));
    fill();
    await screen.findByText(/could not be checked/i);
    expect(assemble().disabled).toBe(false);
  });

  it("ignores a stale response when the patient changes", async () => {
    const resolvers: Record<string, (v: unknown) => void> = {};
    const get = vi.fn(
      (_path: string, opts: { params: { path: { id: string } } }) =>
        new Promise((resolve) => {
          resolvers[opts.params.path.id] = resolve;
        }),
    );
    mount(get);
    fill("old");
    fireEvent.change(screen.getByLabelText("Patient"), { target: { value: "new" } });
    resolvers.new?.({ data: { payers: [row()] } });
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/primary payer/i));
    resolvers.old?.({ data: { payers: [] } }); // late, for the previous patient
    await Promise.resolve();
    expect(screen.queryByText(/No Original Medicare/i)).toBeNull();
    expect(assemble().disabled).toBe(false);
  });

  it("keeps the draft and the server refusal when assemble is rejected after an ok preflight", async () => {
    const post = vi.fn(async () => ({
      data: undefined,
      error: { error: { code: "NON_MEDICARE_PRIMARY_PAYER", message: "x" } },
      response: new Response(null, { status: 409 }),
    }));
    mount(payers(row()), post);
    fill();
    await waitFor(() => expect(assemble().disabled).toBe(false));
    fireEvent.click(assemble());
    await screen.findByText(/primary payer is not Medicare/i);
    expect((screen.getByLabelText("Patient") as HTMLInputElement).value).toBe("pt1");
  });
});
