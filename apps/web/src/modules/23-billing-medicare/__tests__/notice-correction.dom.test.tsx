// "File corrected NOE / NOTR" (CMS Pub. 100-04 ch. 11 §20.1.1 / §20.1.2): a rejected notice offers a correction
// that shows the rejection, lets the biller keep or fix the notice date with a reason, posts it with an
// Idempotency-Key, and links both ways between the rejected notice and its correction.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  correctionAvailability,
  payerDateLabel,
  validateCorrectionDraft,
} from "../notice-correction-model";
import { NOE_CONFIG, NOTR_CONFIG, NoticeWindowDetail } from "../notice-window";

const REJECTED = "d1d2d3d4-0000-4000-8000-000000000001";
const CORRECTED = "c1c2c3c4-0000-4000-8000-000000000002";
const REASON = "Beneficiary MBI changed; refiled with the HETS-verified MBI.";

function noe(over: Record<string, unknown>) {
  return {
    noeId: REJECTED,
    state: "ack_rejected",
    electionEffectiveDate: "2026-10-01",
    windowTargetAt: "2026-10-06",
    windowBreachedAt: null,
    rejectedAt: "2026-10-04T15:30:00.000Z",
    rejectionStage: "277ca",
    rejectionCodes: ["A7:21"],
    correctsNoticeId: null,
    correctionReason: null,
    correctedBy: null,
    version: 4,
    ...over,
  };
}

function renderDetail(config: typeof NOE_CONFIG, data: unknown, post = vi.fn(), after?: unknown) {
  let calls = 0;
  const GET = vi.fn(async () => ({
    data: calls++ > 0 && after !== undefined ? after : data,
    error: undefined,
    response: new Response(null),
  }));
  const client = { GET, POST: post } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <NoticeWindowDetail config={config} id={REJECTED} />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, POST: post };
}

describe("File corrected NOE / NOTR", () => {
  it("drafts a corrected NOE from a rejected one: shows the rejection, posts reason + Idempotency-Key", async () => {
    const POST = vi.fn(async () => ({
      data: { created: true, notice: { noeId: CORRECTED } },
      error: undefined,
      response: new Response(null, { status: 201 }),
    }));
    // After filing, the detail reloads and the rejected NOE now links to its correction.
    renderDetail(
      NOE_CONFIG,
      noe({}),
      POST,
      noe({ correctedBy: { noticeId: CORRECTED, state: "draft" } }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "File corrected NOE" }));
    const form = screen.getByRole("region", { name: "File corrected NOE" });
    expect(form.textContent).toContain("277CA (claim content)");
    expect(form.textContent).toContain("A7:21");
    expect((screen.getByLabelText(/Admission \(election\) date/) as HTMLInputElement).value).toBe(
      "2026-10-01",
    );

    // Too short a reason is refused before anything is posted.
    fireEvent.change(screen.getByLabelText(/What was wrong/), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Draft corrected NOE" }));
    expect(POST).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/What was wrong/), { target: { value: REASON } });
    fireEvent.click(screen.getByRole("button", { name: "Draft corrected NOE" }));
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    const [path, init] = POST.mock.calls[0] as unknown as [string, Record<string, any>];
    expect(path).toBe("/api/v1/noe-records/{id}/correct");
    expect(init.params.path.id).toBe(REJECTED);
    expect(init.params.header["Idempotency-Key"]).toBeTruthy();
    // The date was kept, so only the reason is sent (the server copies the date).
    expect(init.body).toEqual({ reason: REASON });
    const link = await screen.findByRole("link", { name: "Open it" });
    expect(link.getAttribute("href")).toBe(`/billing/noe/${CORRECTED}`);
    expect(screen.getByText("Corrected by")).toBeTruthy();
  });

  it("sends a corrected NOTR end date when the biller changes it", async () => {
    const POST = vi.fn(async () => ({
      data: { created: true, notice: { notrId: CORRECTED } },
      error: undefined,
      response: new Response(null, { status: 201 }),
    }));
    renderDetail(
      NOTR_CONFIG,
      noe({
        noeId: undefined,
        notrId: REJECTED,
        electionEffectiveDate: undefined,
        effectiveEndDate: "2026-10-02",
      }),
      POST,
    );
    fireEvent.click(await screen.findByRole("button", { name: "File corrected NOTR" }));
    fireEvent.change(screen.getByLabelText(/Discharge \/ revocation date/), {
      target: { value: "2026-10-01" },
    });
    fireEvent.change(screen.getByLabelText(/What was wrong/), { target: { value: REASON } });
    fireEvent.click(screen.getByRole("button", { name: "Draft corrected NOTR" }));
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    const [, init] = POST.mock.calls[0] as unknown as [string, Record<string, any>];
    expect(init.body).toEqual({ reason: REASON, correctedDate: "2026-10-01" });
  });

  it("shows the server's refusal inline", async () => {
    const POST = vi.fn(async () => ({
      data: undefined,
      error: {
        error: {
          message: "this admission already has a Notice of Election in progress or accepted",
        },
      },
      response: new Response(null, { status: 409 }),
    }));
    renderDetail(NOE_CONFIG, noe({}), POST);
    fireEvent.click(await screen.findByRole("button", { name: "File corrected NOE" }));
    fireEvent.change(screen.getByLabelText(/What was wrong/), { target: { value: REASON } });
    fireEvent.click(screen.getByRole("button", { name: "Draft corrected NOE" }));
    expect(await screen.findByText(/already has a Notice of Election/)).toBeTruthy();
  });

  it("links a rejected NOE to its correction instead of offering a second one", async () => {
    renderDetail(NOE_CONFIG, noe({ correctedBy: { noticeId: CORRECTED, state: "submitted" } }));
    expect(await screen.findByText("Corrected by")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "File corrected NOE" })).toBeNull();
    const links = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).toContain(`/billing/noe/${CORRECTED}`);
  });

  it("links a corrected NOE back to the rejected one, with the biller's reason", async () => {
    renderDetail(
      NOE_CONFIG,
      noe({
        noeId: CORRECTED,
        state: "draft",
        rejectedAt: null,
        rejectionStage: null,
        rejectionCodes: [],
        correctsNoticeId: REJECTED,
        correctionReason: REASON,
      }),
    );
    expect(await screen.findByText("Corrects")).toBeTruthy();
    expect(screen.getByText(REASON)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Rejected NOE/ }).getAttribute("href")).toBe(
      `/billing/noe/${REJECTED}`,
    );
  });

  it("shows Medicare's own acceptance date with its source", async () => {
    renderDetail(
      NOE_CONFIG,
      noe({
        state: "ack_accepted",
        rejectedAt: null,
        acceptedAt: "2026-10-06T15:30:00.000Z",
        payerStatusDate: "2026-10-05",
        payerStatusDateSource: "277ca_stc02",
      }),
    );
    expect(await screen.findByText("2026-10-05 (277CA status date)")).toBeTruthy();
  });
});

describe("notice-correction-model", () => {
  it("offers a correction only on a rejected notice without a live correction", () => {
    expect(correctionAvailability({ state: "ack_accepted" })).toEqual({ kind: "none" });
    expect(correctionAvailability({ state: "ack_rejected" })).toEqual({ kind: "file" });
    expect(
      correctionAvailability({
        state: "ack_rejected",
        correctedBy: { noticeId: "x", state: "cancelled" },
      }),
    ).toEqual({ kind: "file" });
    expect(
      correctionAvailability({
        state: "ack_rejected",
        correctedBy: { noticeId: "x", state: "ready" },
      }),
    ).toEqual({ kind: "in_progress", noticeId: "x" });
    expect(
      correctionAvailability({
        state: "ack_rejected",
        correctedBy: { noticeId: "x", state: "ack_rejected" },
      }),
    ).toEqual({ kind: "correct_latest", noticeId: "x" });
  });

  it("validates the date and the reason", () => {
    expect(validateCorrectionDraft({ date: "2026-10-01", reason: REASON }, "2026-10-06")).toEqual(
      {},
    );
    expect(validateCorrectionDraft({ date: "", reason: REASON }, "2026-10-06").date).toBeTruthy();
    expect(
      validateCorrectionDraft({ date: "2026-10-07", reason: REASON }, "2026-10-06").date,
    ).toMatch(/future/);
    expect(
      validateCorrectionDraft({ date: "2026-10-01", reason: "x" }, "2026-10-06").reason,
    ).toBeTruthy();
  });

  it("labels the payer date with its source", () => {
    expect(payerDateLabel("2026-10-05", "receipt")).toBe("2026-10-05 (date we received it)");
    expect(payerDateLabel(null, "receipt")).toBeNull();
  });
});
