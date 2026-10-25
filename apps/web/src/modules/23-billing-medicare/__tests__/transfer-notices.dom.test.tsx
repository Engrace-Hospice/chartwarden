import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// The transfer-notice worklist (TOB 8xC / 8xD): the hold shows first, the rail offers only what the server
// allows, and each action posts the right body with an Idempotency-Key and the expected version.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  type TransferNotice,
  statusOf,
  validateConfirm,
  validateCorrection,
} from "../transfer-notice-model";
import { TransferNotices } from "../transfer-notices";

const TN = "c3d4e5f6-0000-4000-8000-000000000001";
const PATIENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ADM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const ok = (data: unknown, status = 200) => ({
  data,
  error: undefined,
  response: new Response(null, { status }),
});
const fail = (status: number, code: string, message = code) => ({
  data: undefined,
  error: { error: { code, message } },
  response: new Response(null, { status }),
});

const HOLD = {
  code: "PRIOR_BILLING_NOT_CONFIRMED",
  message: "Confirm that the transferring hospice has finalized its billing.",
  citation: "CMS Pub. 100-04 ch. 11 §20.1.3",
};

function notice(over: Partial<TransferNotice> = {}): TransferNotice {
  return {
    transferNoticeId: TN,
    patientId: PATIENT,
    admissionId: ADM,
    action: "original",
    supersedesNoticeId: null,
    state: "draft",
    tob: "81C",
    statementFromDate: "2026-03-10",
    originalTransferDate: null,
    admissionDate: "2026-03-10",
    benefitPeriodSequence: 2,
    benefitPeriodStartDate: "2026-01-01",
    priorHospiceName: "Sunrise Hospice",
    priorHospiceCcn: "381777",
    priorHospiceNpi: null,
    providerCcn: "381501",
    priorBillingConfirmedAt: null,
    priorHospiceThroughDate: null,
    priorHospicePatientStatus: null,
    controlNumber: "381501-260310-abcde-00",
    payerControlNumber: null,
    latestSubmissionOutcome: null,
    cancelReason: null,
    blockers: [HOLD],
    warnings: [],
    conditionCodes: [],
    occurrenceCodes: [],
    allowedActions: ["confirm_prior_billing", "cancel"],
    followUp: null,
    version: 3,
    createdAt: "2026-03-11T00:00:00Z",
    ...over,
  };
}

function makeClient(
  items: TransferNotice[],
  post: (...args: unknown[]) => Promise<unknown> = vi.fn(async () => ok(items[0])),
) {
  const GET = vi.fn(async (path: string) => {
    if (path === "/api/v1/billing/transfer-notices")
      return ok({ items, nextCursor: null, hasMore: false });
    if (path === "/api/v1/patients/{id}") return ok({ firstName: "Jane", lastName: "Doe" });
    return fail(404, "NOT_FOUND");
  });
  return { GET, POST: post };
}

function mount(el: JSX.Element, client: object, path = "/billing/transfer-notices") {
  return render(
    <ApiClientProvider client={client as unknown as ApiClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/billing/transfer-notices" element={el} />
          <Route path="/admissions/:id" element={el} />
          <Route path="/step-up" element={<p>step-up page</p>} />
          <Route path="*" element={<p>elsewhere</p>} />
        </Routes>
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

describe("transfer-notice model", () => {
  it("names the prior-hospice hold before the raw state", () => {
    expect(statusOf(notice())).toEqual({ label: "Held for prior hospice", tone: "warning" });
    expect(statusOf(notice({ blockers: [], state: "ready" })).label).toBe("Ready");
    expect(
      statusOf(
        notice({
          state: "ack_accepted",
          blockers: [],
          followUp: { transferNoticeId: "v", action: "void", state: "ack_accepted" },
        }),
      ).label,
    ).toBe("Voided");
  });

  it("validates the confirmation and correction forms", () => {
    expect(
      Object.keys(
        validateConfirm(
          { throughDate: "", patientStatus: "", ccn: "12", npi: "1" },
          { ccn: true, npi: true },
        ),
      ).sort(),
    ).toEqual(["ccn", "npi", "patientStatus", "throughDate"]);
    expect(validateCorrection("2026-03-10", "2026-03-10")).toBe(
      "That is the date already on file.",
    );
    expect(validateCorrection("2026-03-11", "2026-03-10")).toBeNull();
  });
});

describe("TransferNotices worklist", () => {
  it("lists the notice held for the prior hospice, and opens its rail with the blocker and citation", async () => {
    mount(<TransferNotices />, makeClient([notice()]));
    const row = await screen.findByText("Doe, Jane");
    expect(screen.getByText("Held for prior hospice")).toBeTruthy();
    fireEvent.click(row);
    const rail = await screen.findByRole("complementary", {
      name: /Transfer notice for Doe, Jane/,
    });
    expect(within(rail).getByText(HOLD.message)).toBeTruthy();
    expect(within(rail).getByText(HOLD.citation)).toBeTruthy();
    // The server did not allow submit, so it is not offered.
    expect(within(rail).queryByRole("button", { name: "Submit to Medicare" })).toBeNull();
    expect(within(rail).getByRole("button", { name: "Confirm prior billing" })).toBeTruthy();
  });

  it("confirms the transferring hospice's final claim with the version and an Idempotency-Key", async () => {
    const POST = vi.fn(async () => ok(notice()));
    const client = makeClient([notice()], POST);
    mount(<TransferNotices />, client, `/billing/transfer-notices?notice=${TN}`);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm prior billing" }));
    fireEvent.change(screen.getByLabelText(/Patient status on that claim/), {
      target: { value: "51" },
    });
    fireEvent.change(screen.getByLabelText(/Their NPI/), { target: { value: "1234567893" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(POST).toHaveBeenCalled());
    expect(POST).toHaveBeenCalledWith(
      "/api/v1/billing/transfer-notices/{id}/confirm-prior-billing",
      {
        params: { path: { id: TN }, header: { "Idempotency-Key": expect.any(String) } },
        body: {
          expectedVersion: 3,
          priorHospiceThroughDate: "2026-03-10",
          priorHospicePatientStatus: "51",
          priorHospiceNpi: "1234567893",
        },
      },
    );
  });

  it("submits a ready notice, and sends a step-up refusal to the step-up screen", async () => {
    const ready = notice({ state: "ready", blockers: [], allowedActions: ["submit", "cancel"] });
    const POST = vi.fn(async () => fail(403, "STEP_UP_REQUIRED"));
    mount(<TransferNotices />, makeClient([ready], POST), `/billing/transfer-notices?notice=${TN}`);
    fireEvent.click(await screen.findByRole("button", { name: "Submit to Medicare" }));
    await screen.findByText("step-up page");
    expect(POST).toHaveBeenCalledWith("/api/v1/billing/transfer-notices/{id}/submit", {
      params: { path: { id: TN }, header: { "Idempotency-Key": expect.any(String) } },
      body: { expectedVersion: 3 },
    });
  });

  it("shows the server's blocker message when submit is refused", async () => {
    const ready = notice({ state: "ready", blockers: [], allowedActions: ["submit"] });
    const POST = vi.fn(async () =>
      fail(422, "TRANSFER_NOTICE_BLOCKED", "This patient already changed hospices."),
    );
    mount(<TransferNotices />, makeClient([ready], POST), `/billing/transfer-notices?notice=${TN}`);
    fireEvent.click(await screen.findByRole("button", { name: "Submit to Medicare" }));
    expect(await screen.findByText("This patient already changed hospices.")).toBeTruthy();
  });

  it("drafts a date correction for an accepted notice", async () => {
    const accepted = notice({
      state: "ack_accepted",
      blockers: [],
      allowedActions: ["correct_date", "void"],
      payerControlNumber: "PAYER-1",
    });
    const POST = vi.fn(async () =>
      ok(notice({ transferNoticeId: "new-id", action: "correction" }), 201),
    );
    mount(
      <TransferNotices />,
      makeClient([accepted], POST),
      `/billing/transfer-notices?notice=${TN}`,
    );
    expect(await screen.findByText("PAYER-1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Correct date" }));
    fireEvent.change(screen.getByLabelText(/Correct transfer date/), {
      target: { value: "2026-03-11" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Draft correction" }));
    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith("/api/v1/billing/transfer-notices/{id}/correct-date", {
        params: { path: { id: TN }, header: { "Idempotency-Key": expect.any(String) } },
        body: { correctedTransferDate: "2026-03-11" },
      }),
    );
  });

  it("requires a reason to cancel", async () => {
    const POST = vi.fn(async () => ok(notice({ state: "cancelled" })));
    mount(
      <TransferNotices />,
      makeClient([notice()], POST),
      `/billing/transfer-notices?notice=${TN}`,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Cancel notice" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel notice" }).at(-1) as HTMLElement);
    expect(await screen.findByText("Enter a reason.")).toBeTruthy();
    expect(POST).not.toHaveBeenCalled();
  });
});
