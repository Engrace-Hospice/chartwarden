// #851 — the claim assembly screen checks the patient's payer coverage as soon as a patient is chosen, shows the
// outcome (role=status / role=alert), blocks assemble where the server would refuse, never reads payers for a
// malformed patient id (the route is an audited PHI read), offers a retry, and ignores a stale response.
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const PT1 = "11111111-1111-4111-8111-111111111111";
const OLD = "22222222-2222-4222-8222-222222222222";
const NEW = "33333333-3333-4333-8333-333333333333";

const row = (over: Partial<PayerCoverageRow> = {}): PayerCoverageRow => ({
  id: "cov-1",
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
function fill(patient = PT1) {
  fireEvent.change(screen.getByLabelText("Provider entity"), { target: { value: "pe1" } });
  fireEvent.change(screen.getByLabelText("Patient"), { target: { value: patient } });
  fireEvent.change(screen.getByLabelText("Service from"), { target: { value: "2026-10-01" } });
  fireEvent.change(screen.getByLabelText("Service to"), { target: { value: "2026-10-31" } });
}
const assemble = () => screen.getByRole("button", { name: /assemble claim/i }) as HTMLButtonElement;
const liveRegion = () => screen.getByRole("status");

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
  it("prefers the best-ranked in-force FFS row over an ended or lower-ranked one", () => {
    const ended = row({ id: "cov-2", rank: 2, effectiveTo: "2026-12-31" });
    expect(classifyPayerCoverage([ended, row()], "2026-10-01", "2026-10-31")).toBe("ok");
  });
  it("tolerates ISO timestamps on the coverage dates", () => {
    const stamped = row({ effectiveFrom: "2026-10-01T00:00:00.000Z" });
    expect(classifyPayerCoverage([stamped], "2026-10-01", "2026-10-31")).toBe("ok");
  });
  it("is no-medicare when different FFS rows (by id) cover each end of the range", () => {
    const a = row({ id: "a", effectiveTo: "2026-10-15" });
    const b = row({ id: "b", effectiveFrom: "2026-10-16" });
    expect(classifyPayerCoverage([a, b], "2026-10-01", "2026-10-31")).toBe("no-medicare");
  });
  it("is medicare-advantage when only MA, or MA outranks FFS", () => {
    const ma = row({ id: "ma", coverageKind: "medicare_advantage" });
    expect(classifyPayerCoverage([ma], "2026-10-01", "2026-10-31")).toBe("medicare-advantage");
    expect(classifyPayerCoverage([ma, row({ rank: 2 })], "2026-10-01", "2026-10-31")).toBe(
      "medicare-advantage",
    );
  });
});

describe("ClaimAssemblyWizard payer preflight", () => {
  it("keeps an empty live region mounted and does not block until a service-date range is entered", async () => {
    const get = payers();
    mount(get);
    expect(liveRegion().textContent).toBe("");
    fireEvent.change(screen.getByLabelText("Patient"), { target: { value: PT1 } });
    await act(async () => {});
    expect(liveRegion().textContent).toBe("");
    expect(get).toHaveBeenCalledTimes(1); // fetched on selection; judged only once dates exist
    expect(screen.queryByText(/No Original Medicare/i)).toBeNull();
  });

  it("announces loading, then ok, in the same live region, and leaves assemble enabled", async () => {
    mount(payers(row()));
    const region = liveRegion();
    fill();
    expect(region.textContent).toMatch(/checking/i);
    await waitFor(() => expect(region.textContent).toMatch(/primary payer/i));
    expect(liveRegion()).toBe(region);
    expect(assemble().disabled).toBe(false);
  });

  it("never reads payers for partial or non-UUID patient text", async () => {
    const get = payers();
    mount(get);
    fill("Smi");
    fireEvent.change(screen.getByLabelText("Patient"), { target: { value: `${PT1}x` } });
    await act(async () => {});
    expect(get).not.toHaveBeenCalled();
    expect(liveRegion().textContent).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("blocks assemble with an alert when there is no Medicare coverage", async () => {
    mount(payers());
    fill();
    const alert = await screen.findByText(/No Original Medicare/i);
    expect(alert.getAttribute("role")).toBe("alert");
    expect(assemble().disabled).toBe(true);
    expect(assemble().getAttribute("aria-describedby")).toBe("payer-preflight");
  });

  it("blocks assemble when Medicare is not the primary payer", async () => {
    mount(payers(row({ rank: 2 })));
    fill();
    expect((await screen.findByText(/not the primary payer/i)).getAttribute("role")).toBe("alert");
    expect(assemble().disabled).toBe(true);
  });

  it("does not block when the check fails, and Retry re-runs it", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error("net"))
      .mockResolvedValue({ data: { payers: [row()] } });
    mount(get);
    fill();
    await screen.findByText(/could not be checked/i);
    expect(assemble().disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /retry payer check/i }));
    await waitFor(() => expect(liveRegion().textContent).toMatch(/primary payer/i));
    expect(get).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: /retry payer check/i })).toBeNull();
  });

  it("does not block on an error response either", async () => {
    mount(vi.fn(async () => ({ data: undefined, error: { error: { code: "X" } } })));
    fill();
    await screen.findByText(/could not be checked/i);
    expect(assemble().disabled).toBe(false);
  });

  it("ignores a stale response and aborts the previous request when the patient changes", async () => {
    const resolvers: Record<string, (v: unknown) => void> = {};
    const signals: Record<string, AbortSignal> = {};
    const get = vi.fn(
      (_path: string, opts: { params: { path: { id: string } }; signal: AbortSignal }) =>
        new Promise((resolve) => {
          resolvers[opts.params.path.id] = resolve;
          signals[opts.params.path.id] = opts.signal;
        }),
    );
    mount(get);
    fill(OLD);
    fireEvent.change(screen.getByLabelText("Patient"), { target: { value: NEW } });
    expect(signals[OLD]?.aborted).toBe(true);
    expect(signals[NEW]?.aborted).toBe(false);
    resolvers[NEW]?.({ data: { payers: [row()] } });
    await waitFor(() => expect(liveRegion().textContent).toMatch(/primary payer/i));
    resolvers[OLD]?.({ data: { payers: [] } }); // late, for the previous patient
    await act(async () => {});
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
    expect((screen.getByLabelText("Patient") as HTMLInputElement).value).toBe(PT1);
  });
});
