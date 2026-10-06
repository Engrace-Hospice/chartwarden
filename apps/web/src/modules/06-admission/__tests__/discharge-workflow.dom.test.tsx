// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { DischargeWorkflow } from "../discharge-workflow";

const admissionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const patientId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  permissions: [
    "admission.read",
    "discharge.create",
    "discharge.moved",
    "discharge.no_longer_terminal",
    "discharge.for_cause",
    "discharge.other",
    "revocation.create",
    "transfer.out",
  ],
};

function ok(data: unknown, status = 200) {
  return { data, error: undefined, response: new Response(null, { status }) };
}
function fail(status: number, code: string) {
  return {
    data: undefined,
    error: { error: { code, message: code } },
    response: new Response(null, { status }),
  };
}

type PostResult = ReturnType<typeof ok> | ReturnType<typeof fail>;

function clientFor(post: (path: string) => PostResult = () => ok({ id: "x" }, 201)) {
  const POST = vi.fn(async (path: string, _init: unknown) => post(path));
  const client = {
    GET: vi.fn(async (path: string) => {
      if (path === "/api/v1/admissions/{id}")
        return ok({
          id: admissionId,
          state: "active",
          version: 7,
          patientId,
          admissionAt: "2026-08-28T12:00:00.000Z",
        });
      if (path === "/api/v1/patients/{patientId}/election-certification")
        return ok({
          periods: [{ id: "p1", state: "active", sequenceNumber: 1, effectiveAt: "2026-08-28" }],
        });
      if (path === "/api/v1/patients/{id}")
        return ok({
          id: patientId,
          organizationId: "org-1",
          mrn: "MRN-0001",
          firstName: "Rosa",
          lastName: "Delgado",
          dob: "1941-03-02",
          status: "active",
        });
      return ok({});
    }),
    POST,
  } as unknown as ApiClient;
  return { client, POST };
}

function DetailStub() {
  const location = useLocation();
  return <div>ADMISSION DETAIL {(location.state as { notice?: string } | null)?.notice ?? ""}</div>;
}

function renderWorkflow(client: ApiClient) {
  return render(
    <SessionProvider session={session}>
      <ApiClientProvider client={client}>
        <MemoryRouter initialEntries={[`/admissions/${admissionId}/discharge`]}>
          <Routes>
            <Route path="/admissions/:id/discharge" element={<DischargeWorkflow />} />
            <Route path="/admissions/:id" element={<DetailStub />} />
            <Route path="/login" element={<div>LOGIN</div>} />
          </Routes>
        </MemoryRouter>
      </ApiClientProvider>
    </SessionProvider>,
  );
}

const cont = () => fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
const pick = async (name: string) => fireEvent.click(await screen.findByRole("radio", { name }));
const typeNarrative = (text: string) =>
  fireEvent.change(screen.getByLabelText(/^Narrative/), { target: { value: text } });
const setDate = (label: RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-06T15:00:00"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("DischargeWorkflow (M6 discharge / revocation / transfer-out)", () => {
  it("moved out of service area: walks the steps and POSTs the discharge body", async () => {
    const { client, POST } = clientFor();
    renderWorkflow(client);
    await pick("Moved out of service area");
    // Guidance points at Transfer out when another hospice is taking over.
    expect(screen.getAllByText(/Is another hospice in the new area taking over care/).length).toBe(
      1,
    );
    cont();
    const narrative =
      "Moved to Tucson AZ on 9/29 to live with daughter; family notified; records faxed to Dr. Ruiz.";
    typeNarrative(narrative);
    cont();
    setDate(/^Discharge date/, "2026-09-30");
    cont();
    // Review step states the cascades, including the NOTR 5-day due date.
    expect(
      within(screen.getByRole("list", { name: "What happens" })).getByText(
        /The admission becomes Discharged/,
      ),
    ).toBeTruthy();
    expect(
      screen.getAllByText(/Billing drafts the NOTR — due within 5 calendar days, by Oct 5, 2026/)
        .length,
    ).toBeGreaterThan(0);
    cont();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Discharge patient" }));
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    expect(POST).toHaveBeenCalledWith("/api/v1/admissions/{id}/discharge", {
      params: { path: { id: admissionId } },
      body: {
        reason: "moved_out_of_service_area",
        dischargeDate: "2026-09-30",
        narrative,
      },
    });
    expect(
      await screen.findByText(/ADMISSION DETAIL Patient discharged effective Sep 30, 2026/),
    ).toBeTruthy();
  });

  it("moved → one-click switch to Transfer out keeps the narrative and POSTs transfer-out", async () => {
    const { client, POST } = clientFor();
    renderWorkflow(client);
    await pick("Moved out of service area");
    fireEvent.click(screen.getByRole("button", { name: "Switch to Transfer out" }));
    expect(
      (screen.getByRole("radio", { name: "Transfer out to another hospice" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    cont();
    fireEvent.change(screen.getByLabelText(/^Receiving hospice name/), {
      target: { value: "Desert Sun Hospice" },
    });
    fireEvent.change(screen.getByLabelText(/^Receiving hospice CCN/), {
      target: { value: "031234" },
    });
    typeNarrative("Family relocating to Tucson; Desert Sun accepted the patient on 10/1.");
    cont();
    setDate(/^Transfer effective date/, "2026-10-01");
    cont();
    expect(
      within(screen.getByRole("list", { name: "What happens" })).getByText(
        /no new election needed/,
      ),
    ).toBeTruthy();
    cont();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Transfer out" }));
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    expect(POST).toHaveBeenCalledWith("/api/v1/admissions/{id}/transfer-out", {
      params: { path: { id: admissionId } },
      body: {
        direction: "out",
        effectiveDate: "2026-10-01",
        otherHospiceName: "Desert Sun Hospice",
        otherHospiceCcn: "031234",
        narrative: "Family relocating to Tucson; Desert Sun accepted the patient on 10/1.",
      },
    });
  });

  it("for cause: submits forCauseReason and shows the pending-cosign result (patient stays on service)", async () => {
    const { client, POST } = clientFor(() =>
      ok(
        {
          id: "d1",
          state: "pending_cosign",
          version: 1,
          requiresMedicalDirectorCosign: true,
          reason: "for_cause",
        },
        201,
      ),
    );
    renderWorkflow(client);
    await pick("Discharge for cause");
    cont();
    fireEvent.change(screen.getByLabelText(/^For-cause reason/), {
      target: { value: "Repeated unsafe home environment with threats to staff." },
    });
    typeNarrative("Two documented incidents; family informed on 10/2.");
    cont();
    setDate(/^Proposed discharge date/, "2026-10-03");
    cont();
    expect(
      within(screen.getByRole("list", { name: "What happens" })).getByText(
        /Until the cosign, the patient stays on service/,
      ),
    ).toBeTruthy();
    cont();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "File for cosign" }));
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    expect(POST.mock.calls[0]?.[1]).toMatchObject({
      body: {
        reason: "for_cause",
        forCauseReason: "Repeated unsafe home environment with threats to staff.",
      },
    });
    expect(await screen.findByText("Pending medical-director cosign")).toBeTruthy();
    expect(screen.getByText(/the patient stays on service until then/)).toBeTruthy();
    expect(screen.queryByText(/ADMISSION DETAIL/)).toBeNull();
  });

  it.each([
    ["Moved out of service area", 10],
    ["No longer terminally ill", 20],
    ["Other live discharge", 40],
  ])("enforces the narrative minimum for %s (%i chars)", async (label, min) => {
    const { client } = clientFor();
    renderWorkflow(client);
    await pick(label);
    cont();
    typeNarrative("x".repeat(min - 1));
    cont();
    expect(screen.getByText(`Enter at least ${min} characters (${min - 1} so far).`)).toBeTruthy();
    // Still on the details step.
    expect(screen.getByLabelText(/^Narrative/)).toBeTruthy();
    typeNarrative("x".repeat(min));
    cont();
    expect(screen.getByLabelText(/date/i, { selector: "input[type=date]" })).toBeTruthy();
  });

  it("bounds the effective date: not in the future, not before admission", async () => {
    const { client } = clientFor();
    renderWorkflow(client);
    await pick("Moved out of service area");
    cont();
    typeNarrative("Moved to Oregon, records sent.");
    cont();
    const input = screen.getByLabelText(/^Discharge date/) as HTMLInputElement;
    expect(input.min).toBe("2026-08-28");
    expect(input.max).toBe("2026-10-06");
    setDate(/^Discharge date/, "2026-10-07");
    cont();
    expect(screen.getByText("The effective date cannot be in the future.")).toBeTruthy();
    setDate(/^Discharge date/, "2026-08-27");
    expect(
      screen.getByText("The effective date cannot be before the admission date (Aug 28, 2026)."),
    ).toBeTruthy();
    setDate(/^Discharge date/, "2026-08-28");
    cont();
    expect(
      within(screen.getByRole("list", { name: "What happens" })).getByText(
        /The admission becomes Discharged/,
      ),
    ).toBeTruthy();
  });

  it("maps server codes to human messages and redirects a lost session to /login", async () => {
    let next: PostResult = fail(409, "TRANSFER_LIMIT_EXCEEDED");
    const { client } = clientFor(() => next);
    renderWorkflow(client);
    await pick("Transfer out to another hospice");
    cont();
    fireEvent.change(screen.getByLabelText(/^Receiving hospice name/), {
      target: { value: "Desert Sun Hospice" },
    });
    typeNarrative("Transfer agreed with the receiving hospice.");
    cont();
    setDate(/^Transfer effective date/, "2026-10-01");
    cont();
    cont();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Transfer out" }));
    expect(await screen.findByText(/only one is allowed per period/)).toBeTruthy();
    next = fail(401, "UNAUTHENTICATED");
    fireEvent.click(screen.getByRole("button", { name: "Transfer out" }));
    expect(await screen.findByText("LOGIN")).toBeTruthy();
  });

  it("does not offer a discharge for an admission that is not active or on hold", async () => {
    const { client } = clientFor();
    const baseGet = (client as unknown as { GET: (path: string) => Promise<unknown> }).GET;
    (client as unknown as { GET: unknown }).GET = vi.fn(async (path: string) =>
      path === "/api/v1/admissions/{id}"
        ? ok({ id: admissionId, state: "discharged", version: 9, patientId })
        : baseGet(path),
    );
    renderWorkflow(client);
    expect(
      await screen.findByText(/Only an active or on-hold admission can be discharged/),
    ).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
  });
});
