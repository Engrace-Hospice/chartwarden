// #672: the DSAR queue's patient filter can be filled by name / MRN instead of a pasted id.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { DsarQueue } from "../dsar-queue";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const SEARCH = "/api/v1/patients/messaging-search";
const JOBS = "/api/v1/tenant/dsar-export-jobs";
const SETTLE_MS = 600;
const withPatient = (calls: { path: string; search: string }[]) =>
  calls.filter((c) => c.path === JOBS && c.search.includes(`patientId=${PATIENT_ID}`));

interface Call {
  path: string;
  search: string;
}

function mount(searchResponse: () => Response): Call[] {
  const calls: Call[] = [];
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(req.url);
      calls.push({ path: url.pathname, search: url.search });
      if (url.pathname === SEARCH) return searchResponse();
      return new Response(JSON.stringify({ items: [], nextCursor: null, hasMore: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  render(
    <ApiClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <DsarQueue />
        </MemoryRouter>
      </ToastProvider>
    </ApiClientProvider>,
  );
  return calls;
}

const ok = (): Response =>
  new Response(
    JSON.stringify({
      patients: [
        { patientId: PATIENT_ID, displayName: "Ada Lovelace", medicalRecordNumber: "MRN-7" },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

afterEach(cleanup);

describe("DSAR queue patient lookup", () => {
  it("searches by name and filters the queue by the picked patient's id", async () => {
    const calls = mount(ok);
    const field = await screen.findByRole("combobox", { name: /find patient/i });
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "Ada" } });
    const option = await screen.findByRole("option", { name: /Ada Lovelace/ });
    expect(calls.find((c) => c.path === SEARCH)?.search).toContain("q=Ada");
    fireEvent.click(option);
    await waitFor(() => expect(withPatient(calls)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    expect(withPatient(calls)).toHaveLength(1); // the debounced effect must not fetch it a second time
    expect((screen.getByLabelText("Patient id") as HTMLInputElement).value).toBe(PATIENT_ID);
  });

  it("keeps the status filter when a patient is picked, and clearing the pick resets the patient filter", async () => {
    const calls = mount(ok);
    fireEvent.change(await screen.findByLabelText("Status"), { target: { value: "fulfilled" } });
    const field = screen.getByRole("combobox", { name: /find patient/i });
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "Ada" } });
    fireEvent.click(await screen.findByRole("option", { name: /Ada Lovelace/ }));
    await waitFor(() => expect(withPatient(calls)).toHaveLength(1));
    expect(withPatient(calls)[0]?.search).toContain("status=fulfilled");
    fireEvent.click(await screen.findByRole("button", { name: "Clear selection" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Patient id") as HTMLInputElement).value).toBe(""),
    );
  });

  it("does not show a pasted id as a picked patient", async () => {
    mount(ok);
    fireEvent.change(await screen.findByLabelText("Patient id"), { target: { value: PATIENT_ID } });
    expect(screen.queryByRole("button", { name: "Clear selection" })).toBeNull();
  });

  it("says the lookup is unavailable (and leaves the id field usable) when search is refused", async () => {
    const calls = mount(
      () =>
        new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "x" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );
    const field = await screen.findByRole("combobox", { name: /find patient/i });
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "Ada" } });
    expect(await screen.findByText("Lookup unavailable.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Patient id"), { target: { value: PATIENT_ID } });
    await waitFor(() =>
      expect(
        calls.some((c) => c.path === JOBS && c.search.includes(`patientId=${PATIENT_ID}`)),
      ).toBe(true),
    );
  });
});
