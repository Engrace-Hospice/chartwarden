// The DDE work queue (ADR-0052): at-risk / overdue indicators first, the rail offers only what the server allows,
// recording a submission posts the right body with an Idempotency-Key and the expected version, a step-up demand
// routes to /step-up, and the screen never shows an MBI.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { DdeQueue } from "../dde-queue";
import {
  type DdeItem,
  deadlineNote,
  isNoticeType,
  validateOutcome,
  validateSubmission,
} from "../dde-queue-model";

const ITEM = "c3d4e5f6-0000-4000-8000-000000000001";
const PATIENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});
const fail = (status: number, code: string) => ({
  data: undefined,
  error: { error: { code, message: code } },
  response: new Response(null, { status }),
});

function item(over: Partial<DdeItem> = {}): DdeItem {
  return {
    ddeWorkItemId: ITEM,
    patientId: PATIENT,
    providerEntityId: "77777777-7777-4777-8777-777777777777",
    itemType: "noe",
    subjectKind: "noe_record",
    subjectId: "34343434-3434-4434-8434-343434343434",
    state: "in_progress",
    attemptNumber: 1,
    assigneeMembershipId: "abababab-abab-4bab-8bab-abababababab",
    priority: 1,
    source: "watchdog",
    deadlineAt: "2026-10-10",
    deadlineStatus: "at_risk",
    submittedAt: null,
    macAcceptedOn: null,
    dcn: null,
    rtpReasonCode: null,
    outcomeCode: null,
    notes: null,
    allowedActions: ["record_submission", "cancel"],
    version: 3,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

function client(items: DdeItem[], post: ReturnType<typeof vi.fn> = vi.fn(async () => ok({}))) {
  const get = vi.fn(async (path: string) => {
    if (path === "/api/v1/billing/dde-items")
      return ok({ items, nextCursor: null, hasMore: false });
    if (path === "/api/v1/billing/dde-items/{id}")
      return ok({
        ...items[0],
        events: [
          {
            eventId: "e1",
            event: "create",
            fromState: null,
            toState: "queued",
            attemptNumber: 1,
            occurredAt: "2026-10-01T00:00:00.000Z",
          },
        ],
      });
    return ok({ firstName: "Pat", lastName: "Patient" });
  });
  return { api: { GET: get, POST: post } as unknown as ApiClient, get, post };
}

function Where(): JSX.Element {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

function mount(api: ApiClient, entry = `/billing/dde?item=${ITEM}`) {
  return render(
    <ApiClientProvider client={api}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/billing/dde" element={<DdeQueue />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

describe("DdeQueue", () => {
  it("lists the work with its deadline indicator and counts what is overdue or at risk", async () => {
    const { api } = client([
      item(),
      item({
        ddeWorkItemId: "c3d4e5f6-0000-4000-8000-000000000002",
        deadlineStatus: "overdue",
        itemType: "adjustment",
      }),
    ]);
    mount(api, "/billing/dde");
    expect(await screen.findByText("2 items · 1 overdue · 1 at risk")).toBeTruthy();
    expect(screen.getAllByText("At risk").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Overdue").length).toBeGreaterThan(0);
    expect(within(screen.getByRole("table")).getAllByText("Adjustment").length).toBe(1);
  });

  it("filters server-side by overdue", async () => {
    const { api, get } = client([item()]);
    mount(api, "/billing/dde");
    await screen.findByText("1 items · 0 overdue · 1 at risk");
    fireEvent.click(screen.getByLabelText("Overdue only"));
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        "/api/v1/billing/dde-items",
        expect.objectContaining({ params: { query: expect.objectContaining({ overdue: true }) } }),
      ),
    );
  });

  it("records a submission with the expected version and an idempotency key", async () => {
    const post = vi.fn(async () => ok({}));
    const { api } = client([item()], post);
    mount(api);
    const rail = await screen.findByRole("complementary");
    fireEvent.click(within(rail).getByRole("button", { name: "Record as keyed in DDE" }));
    fireEvent.change(within(rail).getByLabelText(/DCN/), {
      target: { value: "22123456789012345" },
    });
    fireEvent.click(within(rail).getByRole("button", { name: "Record as keyed" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, args] = post.mock.calls[0] as unknown as [
      string,
      { params: { path: { id: string }; header: Record<string, string> }; body: unknown },
    ];
    expect(path).toBe("/api/v1/billing/dde-items/{id}/record-submission");
    expect(args.body).toEqual({ expectedVersion: 3, dcn: "22123456789012345" });
    expect(args.params.header["Idempotency-Key"]).toBeTruthy();
  });

  it("sends the person to /step-up when the server demands a fresh re-authentication", async () => {
    const post = vi.fn(async () => fail(403, "STEP_UP_REQUIRED"));
    const { api } = client([item()], post);
    mount(api);
    const rail = await screen.findByRole("complementary");
    fireEvent.click(within(rail).getByRole("button", { name: "Record as keyed in DDE" }));
    fireEvent.click(within(rail).getByRole("button", { name: "Record as keyed" }));
    expect(await screen.findByTestId("where")).toHaveProperty("textContent", "/step-up");
  });

  it("asks for the MAC acceptance date when an NOE is recorded as accepted, and never shows an MBI field", async () => {
    const post = vi.fn(async () => ok({}));
    const { api } = client(
      [item({ state: "submitted", allowedActions: ["record_outcome"] })],
      post,
    );
    mount(api);
    const rail = await screen.findByRole("complementary");
    fireEvent.click(within(rail).getByRole("button", { name: "Record what came back" }));
    fireEvent.change(within(rail).getByLabelText(/What came back/), {
      target: { value: "accepted" },
    });
    fireEvent.click(within(rail).getByRole("button", { name: "Record outcome" }));
    expect(await within(rail).findByText(/Enter the date the MAC accepted it/)).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    expect(within(rail).queryByRole("textbox", { name: /^(MBI|Medicare)/i })).toBeNull();
    fireEvent.change(within(rail).getByLabelText(/MAC acceptance date/), {
      target: { value: "2026-10-08" },
    });
    fireEvent.click(within(rail).getByRole("button", { name: "Record outcome" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, args] = post.mock.calls[0] as unknown as [string, { body: unknown }];
    expect(args.body).toEqual({
      expectedVersion: 3,
      outcome: "accepted",
      macAcceptedOn: "2026-10-08",
    });
  });
});

describe("dde-queue-model", () => {
  const base = item();
  it("flags a keyed notice with no acceptance date", () => {
    expect(deadlineNote({ ...base, state: "submitted" })).toMatch(
      /not met until the MAC acceptance date/,
    );
    expect(deadlineNote({ ...base, itemType: "adjustment", state: "submitted" })).toBe("");
    expect(deadlineNote({ ...base, state: "submitted", macAcceptedOn: "2026-10-08" })).toBe("");
    expect(isNoticeType("notr")).toBe(true);
    expect(isNoticeType("claim_entry")).toBe(false);
  });

  it("validates the forms", () => {
    expect(validateSubmission({ dcn: "bad dcn!", notes: "" }).dcn).toBeTruthy();
    expect(validateSubmission({ dcn: "", notes: "x".repeat(501) }).notes).toBeTruthy();
    expect(
      validateOutcome(
        { outcome: "", macAcceptedOn: "", rtpReasonCode: "", dcn: "", notes: "" },
        base,
      ).outcome,
    ).toBeTruthy();
    expect(
      validateOutcome(
        { outcome: "returned", macAcceptedOn: "", rtpReasonCode: "", dcn: "", notes: "" },
        base,
      ).rtpReasonCode,
    ).toBeTruthy();
    expect(
      validateOutcome(
        { outcome: "accepted", macAcceptedOn: "", rtpReasonCode: "", dcn: "", notes: "" },
        { ...base, itemType: "adjustment" },
      ),
    ).toEqual({});
  });
});
