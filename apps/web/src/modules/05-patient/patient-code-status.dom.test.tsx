// @vitest-environment jsdom
// ADR-0104: the patient code-status panel (?view=code-status) — current value, history, set form,
// entered-in-error, and the 403 / 422 messages.
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PatientCodeStatusTab } from "./patient-code-status";

afterEach(cleanup);

const ENTRY = {
  id: "e-1",
  patientId: "p-1",
  codeStatus: "dnr",
  reason: "Family chose DNR at admission",
  sourceDocumentId: null,
  recordedByMembershipId: "33333333-3333-4333-8333-333333333333",
  recordedAt: "2026-10-29T12:00:00.000Z",
  enteredInErrorAt: null,
};

type Result = { data?: unknown; error?: unknown; response?: { status: number } };

function renderTab(
  list: unknown,
  post: (path: string, init: { body: unknown }) => Promise<Result> = async () => ({
    data: ENTRY,
    response: { status: 201 },
  }),
) {
  const state = { list };
  const GET = vi.fn(async () => ({ data: state.list, response: { status: 200 } }));
  const POST = vi.fn(post);
  const client = { GET, POST } as unknown as ComponentProps<typeof ApiClientProvider>["client"];
  render(
    <ApiClientProvider client={client}>
      <PatientCodeStatusTab patientId="p-1" />
    </ApiClientProvider>,
  );
  return { GET, POST, state };
}

async function fillAndSubmit(label: RegExp, reason: string) {
  fireEvent.click(await screen.findByRole("radio", { name: label }));
  fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: reason } });
  fireEvent.click(screen.getByRole("button", { name: "Record code status" }));
}

describe("PatientCodeStatusTab", () => {
  it("shows the current status and the history row", async () => {
    renderTab({ current: ENTRY, history: [ENTRY] });
    expect(await screen.findByText("Current: DNR")).toBeTruthy();
    expect(screen.getByText("Family chose DNR at admission")).toBeTruthy();
  });

  it("says Not recorded when nothing is on file (never Full code)", async () => {
    renderTab({ current: null, history: [] });
    expect(await screen.findByText("Current: Not recorded")).toBeTruthy();
    expect(screen.queryByText(/Current: Full code/)).toBeNull();
  });

  it("offers exactly the four stored values", async () => {
    renderTab({ current: null, history: [] });
    const radios = await screen.findAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("value"))).toEqual([
      "full_code",
      "dnr",
      "dnr_dni",
      "comfort_measures_only",
    ]);
  });

  it("records the status, then re-reads the list", async () => {
    const { POST, GET } = renderTab({ current: null, history: [] });
    await fillAndSubmit(/^DNR$/, "Patient request");
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    expect(POST.mock.calls[0]).toEqual([
      "/api/v1/patients/{id}/code-status",
      { params: { path: { id: "p-1" } }, body: { codeStatus: "dnr", reason: "Patient request" } },
    ]);
    await waitFor(() => expect(GET.mock.calls.length).toBeGreaterThan(1));
  });

  it("survives a thrown write: shows a message and re-enables the form", async () => {
    renderTab({ current: null, history: [] }, async () => {
      throw new Error("network down");
    });
    await fillAndSubmit(/^DNR$/, "Patient request");
    expect(await screen.findByText(/could not be saved/i)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Record code status" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("sends one write when submitted twice in a row", async () => {
    let release: (r: Result) => void = () => {};
    const { POST } = renderTab(
      { current: null, history: [] },
      () =>
        new Promise<Result>((resolve) => {
          release = resolve;
        }),
    );
    await fillAndSubmit(/^DNR$/, "Patient request");
    fireEvent.submit(
      screen.getByRole("button", { name: "Record code status" }).closest("form") as Element,
    );
    expect(POST).toHaveBeenCalledTimes(1);
    release({ data: ENTRY, response: { status: 201 } });
  });

  it("will not submit without a reason", async () => {
    const { POST } = renderTab({ current: null, history: [] });
    fireEvent.click(await screen.findByRole("radio", { name: /^DNR$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Record code status" }));
    expect(await screen.findByText(/reason is required/i)).toBeTruthy();
    expect(POST).not.toHaveBeenCalled();
  });

  it("shows a plain message on 403", async () => {
    renderTab({ current: null, history: [] }, async () => ({
      error: { error: { message: "forbidden" } },
      response: { status: 403 },
    }));
    await fillAndSubmit(/^DNR$/, "x");
    expect(await screen.findByText(/not authorised to change code status/i)).toBeTruthy();
  });

  it("shows the server message on 422", async () => {
    renderTab({ current: null, history: [] }, async () => ({
      error: { error: { message: "source document must be this patient's code-status directive" } },
      response: { status: 422 },
    }));
    await fillAndSubmit(/^DNR$/, "x");
    expect(await screen.findByText(/must be this patient's code-status directive/)).toBeTruthy();
  });

  it("retracts an entry with a reason", async () => {
    const { POST } = renderTab({ current: ENTRY, history: [ENTRY] });
    fireEvent.click(await screen.findByRole("button", { name: "Mark entered in error" }));
    fireEvent.change(screen.getByLabelText(/why was this entered in error/i), {
      target: { value: "wrong chart" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm entered in error" }));
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    expect(POST.mock.calls[0]).toEqual([
      "/api/v1/patients/{id}/code-status/{entryId}/entered-in-error",
      {
        params: { path: { id: "p-1", entryId: "e-1" } },
        body: { reason: "wrong chart" },
      },
    ]);
  });

  it("labels a retracted entry and offers no second retraction", async () => {
    const eie = { ...ENTRY, enteredInErrorAt: "2026-10-29T13:00:00.000Z" };
    renderTab({ current: null, history: [eie] });
    expect(await screen.findByText("Entered in error")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark entered in error" })).toBeNull();
  });

  it("shows an error state when the list cannot be read", async () => {
    renderTab(undefined);
    expect(await screen.findByText(/could not be loaded/i)).toBeTruthy();
  });
});
