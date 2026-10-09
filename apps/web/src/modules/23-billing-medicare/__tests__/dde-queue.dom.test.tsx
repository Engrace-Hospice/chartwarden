// The DDE work queue (ADR-0052): paging, deep links, filters, the action dispatch (expected version + idempotency
// key), the 412 notice held by the screen, double-submit protection, the step-up round trip (returnTo, exactly one
// post, the form restored), and the absence of any MBI field.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DdeQueue } from "../dde-queue";
import {
  type DdeItem,
  deadlineNote,
  isNoticeType,
  isRealDate,
  looksLikeMbi,
  plural,
  validateOutcome,
  validateSubmission,
} from "../dde-queue-model";
import { clearAllDrafts, clearDraft, loadDraft, saveDraft } from "../write-workflow";

const ITEM = "c3d4e5f6-0000-4000-8000-000000000001";
const ITEM2 = "c3d4e5f6-0000-4000-8000-000000000002";
const PATIENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DCN = "2212345678901";

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
const EVENTS = [
  {
    eventId: "e1",
    event: "create",
    fromState: null,
    toState: "queued",
    attemptNumber: 1,
    occurredAt: "2026-10-01T12:00:00.000Z",
  },
];

interface Setup {
  pages?: { items: DdeItem[]; hasMore: boolean; nextCursor: string | null }[];
  detail?: DdeItem | "missing";
  post?: ReturnType<typeof vi.fn>;
  listError?: boolean;
}

function setup(o: Setup = {}) {
  const pages = o.pages ?? [{ items: [item()], hasMore: false, nextCursor: null }];
  const post = o.post ?? vi.fn(async () => ok({}));
  const get = vi.fn(async (path: string, args?: { params?: { query?: { cursor?: string } } }) => {
    if (path === "/api/v1/billing/dde-items") {
      if (o.listError) return fail(500, "INTERNAL");
      const cursor = args?.params?.query?.cursor;
      const page = cursor ? (pages[1] ?? pages[0]) : pages[0];
      return ok(page);
    }
    if (path === "/api/v1/billing/dde-items/{id}") {
      if (o.detail === "missing") return fail(404, "NOT_FOUND");
      return ok({ ...(o.detail ?? pages[0]?.items[0] ?? item()), events: EVENTS });
    }
    return ok({ firstName: "Pat", lastName: "Patient" });
  });
  return { api: { GET: get, POST: post } as unknown as ApiClient, get, post };
}

function Where(): JSX.Element {
  return (
    <output data-testid="where">
      {useLocation().pathname}
      {useLocation().search}
    </output>
  );
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
const rail = async () => within(await screen.findByRole("complementary"));
const postCall = (post: ReturnType<typeof vi.fn>, i = 0) =>
  post.mock.calls[i] as unknown as [
    string,
    { params: { header: Record<string, string> }; body: Record<string, unknown> },
  ];

beforeEach(() => clearDraft(`dde:${ITEM}`));

describe("DdeQueue list", () => {
  it("shows the deadline indicators and labels the counts as being of what is loaded", async () => {
    const second = item({
      ddeWorkItemId: ITEM2,
      deadlineStatus: "overdue",
      itemType: "adjustment",
    });
    const { api } = setup({
      pages: [{ items: [item(), second], hasMore: false, nextCursor: null }],
    });
    mount(api, "/billing/dde");
    expect(
      await screen.findByText("2 items loaded · 1 overdue · 1 at risk (of those loaded)"),
    ).toBeTruthy();
    expect(within(screen.getByRole("table")).getAllByText("Overdue").length).toBe(1);
  });

  it("says '1 item' for one item", async () => {
    const { api } = setup();
    mount(api, "/billing/dde");
    expect(await screen.findByText(/^1 item loaded/)).toBeTruthy();
    expect(plural(1, "item")).toBe("1 item");
  });

  it("pages with Load more by cursor, de-duplicates, and starts over when a filter changes", async () => {
    const a = item();
    const b = item({ ddeWorkItemId: ITEM2, itemType: "adjustment" });
    const { api, get } = setup({
      pages: [
        { items: [a], hasMore: true, nextCursor: "CUR1" },
        { items: [a, b], hasMore: false, nextCursor: null },
      ],
    });
    mount(api, "/billing/dde");
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() =>
      expect(within(screen.getByRole("table")).getAllByRole("row").length).toBe(3),
    );
    expect(get).toHaveBeenCalledWith(
      "/api/v1/billing/dde-items",
      expect.objectContaining({ params: { query: expect.objectContaining({ cursor: "CUR1" }) } }),
    );
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "noe" } });
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith(
        "/api/v1/billing/dde-items",
        expect.objectContaining({
          params: { query: expect.not.objectContaining({ cursor: expect.anything() }) },
        }),
      ),
    );
  });

  it.each([
    ["Status", "submitted", { state: "submitted" }],
    ["Type", "adjustment", { itemType: "adjustment" }],
    ["Overdue only", true, { overdue: true }],
    ["At risk only", true, { atRisk: true }],
  ])("wires the %s filter to the query", async (label, value, query) => {
    const { api, get } = setup();
    mount(api, "/billing/dde");
    const control = await screen.findByLabelText(label);
    if (typeof value === "boolean") fireEvent.click(control);
    else fireEvent.change(control, { target: { value } });
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        "/api/v1/billing/dde-items",
        expect.objectContaining({ params: { query: expect.objectContaining(query) } }),
      ),
    );
  });

  it("shows the empty, error and loading states", async () => {
    const empty = setup({ pages: [{ items: [], hasMore: false, nextCursor: null }] });
    const first = mount(empty.api, "/billing/dde");
    expect(await screen.findByText("No DDE work")).toBeTruthy();
    first.unmount();
    const broken = setup({ listError: true });
    mount(broken.api, "/billing/dde");
    expect((await screen.findByText("DDE queue unavailable")).closest("[role=alert]")).toBeTruthy();
  });
});

describe("DdeQueue deep links", () => {
  it("opens an item beyond the loaded page (fetched by id) and says it is not in the list", async () => {
    const other = item({ ddeWorkItemId: ITEM2 });
    const { api } = setup({
      pages: [{ items: [other], hasMore: true, nextCursor: "C" }],
      detail: item(),
    });
    mount(api);
    const r = await rail();
    expect(await r.findByText("This item is no longer in the list.")).toBeTruthy();
  });

  it("explains an item that cannot be found", async () => {
    const { api } = setup({ detail: "missing" });
    mount(api);
    expect((await screen.findByText(/could not be found/)).closest("[role=alert]")).toBeTruthy();
    expect(screen.queryByRole("complementary")).toBeNull();
  });
});

describe("DdeQueue actions", () => {
  it.each([
    ["claim", "Take it", ["claim", "cancel"]],
    ["start", "Start work", ["start", "cancel"]],
    ["retry", "Reopen as a new attempt", ["retry", "close"]],
    ["cancel", "Cancel item", ["cancel"]],
    ["close", "Close", ["close"]],
  ] as const)(
    "dispatches %s with the expected version and an idempotency key",
    async (path, label, actions) => {
      const { api, post } = setup({
        pages: [
          { items: [item({ allowedActions: [...actions] })], hasMore: false, nextCursor: null },
        ],
      });
      mount(api);
      fireEvent.click((await rail()).getByRole("button", { name: label }));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      const [url, args] = postCall(post);
      expect(url).toBe(`/api/v1/billing/dde-items/{id}/${path}`);
      expect(args.body).toEqual({ expectedVersion: 3 });
      expect(args.params.header["Idempotency-Key"]).toBeTruthy();
    },
  );

  it("offers only the actions the server allows", async () => {
    const { api } = setup();
    mount(api);
    const r = await rail();
    await r.findByRole("button", { name: "Record as keyed in DDE" });
    for (const name of [
      "Take it",
      "Start work",
      "Record what came back",
      "Close",
      "Reopen as a new attempt",
    ])
      expect(r.queryByRole("button", { name })).toBeNull();
  });

  it("records a submission, and a double submit sends one request", async () => {
    let release: (v: unknown) => void = () => undefined;
    const post = vi.fn(
      () =>
        new Promise((res) => {
          release = res;
        }),
    );
    const { api } = setup({ post });
    mount(api);
    const r = await rail();
    fireEvent.click(r.getByRole("button", { name: "Record as keyed in DDE" }));
    fireEvent.change(r.getByLabelText(/DCN/), { target: { value: DCN } });
    const form = r.getByRole("form", { name: "Record as keyed in DDE" });
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(post).toHaveBeenCalledTimes(1);
    const [path, args] = postCall(post);
    expect(path).toBe("/api/v1/billing/dde-items/{id}/record-submission");
    expect(args.body).toEqual({ expectedVersion: 3, dcn: DCN });
    await act(async () => release(ok({})));
  });

  it("sends an acceptance to record-acceptance (date required for an NOE) and a return to record-outcome", async () => {
    const post = vi.fn(async () => ok({}));
    const { api } = setup({
      post,
      pages: [
        {
          items: [
            item({ state: "submitted", allowedActions: ["record_outcome", "record_acceptance"] }),
          ],
          hasMore: false,
          nextCursor: null,
        },
      ],
    });
    mount(api);
    const r = await rail();
    fireEvent.click(r.getByRole("button", { name: "Record what came back" }));
    fireEvent.change(r.getByLabelText(/What came back/), { target: { value: "accepted" } });
    fireEvent.submit(r.getByRole("form", { name: "Record what came back" }));
    expect(await r.findByText(/Enter the date the MAC accepted it/)).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    fireEvent.change(r.getByLabelText(/MAC acceptance date/), { target: { value: "2026-10-08" } });
    fireEvent.submit(r.getByRole("form", { name: "Record what came back" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(postCall(post)[0]).toBe("/api/v1/billing/dde-items/{id}/record-acceptance");
    expect(postCall(post)[1].body).toEqual({ expectedVersion: 3, macAcceptedOn: "2026-10-08" });
  });

  it("returns an item through record-outcome with its RTP code", async () => {
    const post = vi.fn(async () => ok({}));
    const { api } = setup({
      post,
      pages: [
        {
          items: [
            item({ state: "submitted", allowedActions: ["record_outcome", "record_acceptance"] }),
          ],
          hasMore: false,
          nextCursor: null,
        },
      ],
    });
    mount(api);
    const r = await rail();
    fireEvent.click(r.getByRole("button", { name: "Record what came back" }));
    fireEvent.change(r.getByLabelText(/What came back/), { target: { value: "returned" } });
    fireEvent.change(r.getByLabelText(/RTP reason code/), { target: { value: "37001" } });
    fireEvent.submit(r.getByRole("form", { name: "Record what came back" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(postCall(post)[0]).toBe("/api/v1/billing/dde-items/{id}/record-outcome");
    expect(postCall(post)[1].body).toEqual({
      expectedVersion: 3,
      outcome: "returned",
      rtpReasonCode: "37001",
    });
  });

  it("holds a 412 notice on the screen (role=alert) and reloads, without remounting the rail", async () => {
    const post = vi.fn(async () => fail(412, "VERSION_CONFLICT"));
    const { api, get } = setup({
      post,
      pages: [
        {
          items: [item({ allowedActions: ["start", "cancel"] })],
          hasMore: false,
          nextCursor: null,
        },
      ],
    });
    mount(api);
    fireEvent.click((await rail()).getByRole("button", { name: "Start work" }));
    const alert = await screen.findByText(/changed since you opened it/);
    expect(alert.closest("[role=alert]")).toBeTruthy();
    const detailLoads = get.mock.calls.filter(
      (c) => c[0] === "/api/v1/billing/dde-items/{id}",
    ).length;
    expect(detailLoads).toBeGreaterThan(1);
    expect(screen.getByRole("complementary")).toBeTruthy();
  });

  it("goes to /step-up with returnTo, posts exactly once, and restores the open form on return", async () => {
    const post = vi.fn(async () => fail(403, "STEP_UP_REQUIRED"));
    const { api } = setup({ post });
    const view = mount(api);
    const r = await rail();
    fireEvent.click(r.getByRole("button", { name: "Record as keyed in DDE" }));
    fireEvent.change(r.getByLabelText(/DCN/), { target: { value: DCN } });
    fireEvent.submit(r.getByRole("form", { name: "Record as keyed in DDE" }));
    const where = await screen.findByTestId("where");
    expect(where.textContent).toContain("/step-up");
    expect(decodeURIComponent(where.textContent ?? "")).toContain(
      `returnTo=/billing/dde?item=${ITEM}`,
    );
    expect(post).toHaveBeenCalledTimes(1);
    view.unmount();
    mount(setup().api);
    const back = await rail();
    expect(await back.findByRole("form", { name: "Record as keyed in DDE" })).toBeTruthy();
    expect((back.getByLabelText(/DCN/) as HTMLInputElement).value).toBe(DCN);
  });

  it("has no MBI field: no input is named or labelled for a Medicare number", async () => {
    const { api } = setup({
      pages: [
        {
          items: [
            item({ state: "submitted", allowedActions: ["record_outcome", "record_acceptance"] }),
          ],
          hasMore: false,
          nextCursor: null,
        },
      ],
    });
    mount(api);
    const r = await rail();
    fireEvent.click(r.getByRole("button", { name: "Record what came back" }));
    fireEvent.change(r.getByLabelText(/What came back/), { target: { value: "accepted" } });
    for (const field of document.querySelectorAll("input, textarea, select")) {
      const name = field.getAttribute("name") ?? "";
      const label = field.closest("label")?.querySelector("span")?.textContent ?? "";
      expect(`${name} ${label}`).not.toMatch(/mbi|medicare/i);
    }
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

  it("refuses MBI-shaped notes and DCNs, however they are spaced", () => {
    for (const note of [
      "1EG4-TE5-MK73",
      "1EG4 TE5 MK73",
      "x1EG4TE5MK73y",
      "1.E.G.4.T.E.5.M.K.7.3",
    ]) {
      expect(looksLikeMbi(note)).toBe(true);
      expect(validateSubmission({ dcn: "", notes: note }).notes).toMatch(/Medicare number/);
    }
    expect(validateSubmission({ dcn: "1EG4TE5MK73", notes: "" }).dcn).toBeTruthy();
    expect(validateSubmission({ dcn: DCN, notes: "called MAC, ref 4471" })).toEqual({});
  });

  it("validates the forms", () => {
    expect(validateSubmission({ dcn: "bad dcn!", notes: "" }).dcn).toBeTruthy();
    expect(validateSubmission({ dcn: "", notes: "x".repeat(501) }).notes).toBeTruthy();
    const empty = {
      outcome: "",
      macAcceptedOn: "",
      rtpReasonCode: "",
      dcn: "",
      notes: "",
    } as const;
    expect(validateOutcome({ ...empty }, base).outcome).toBeTruthy();
    expect(validateOutcome({ ...empty, outcome: "returned" }, base).rtpReasonCode).toBeTruthy();
    expect(
      validateOutcome({ ...empty, outcome: "accepted" }, { ...base, itemType: "adjustment" }),
    ).toEqual({});
  });
});

describe("DdeQueue paging races and notices", () => {
  const apiWith = (get: ReturnType<typeof vi.fn>, post = vi.fn(async () => ok({}))) =>
    ({ GET: get, POST: post }) as unknown as ApiClient;
  const page = (items: DdeItem[], hasMore = false, nextCursor: string | null = null) =>
    ok({ items, hasMore, nextCursor });

  it("discards a Load more response that arrives after a filter change", async () => {
    let release: (v: unknown) => void = () => undefined;
    const stale = item({ ddeWorkItemId: ITEM2, itemType: "cancel" });
    const get = vi.fn((path: string, args?: { params?: { query?: Record<string, unknown> } }) => {
      if (path !== "/api/v1/billing/dde-items") return Promise.resolve(ok({}));
      const q = args?.params?.query ?? {};
      if (q.cursor)
        return new Promise((res) => {
          release = res;
        });
      return Promise.resolve(
        page([item({ itemType: q.itemType === "noe" ? "noe" : "adjustment" })], true, "C1"),
      );
    });
    mount(apiWith(get), "/billing/dde");
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "noe" } });
    await waitFor(() =>
      expect(within(screen.getByRole("table")).getAllByText("Notice of Election").length).toBe(1),
    );
    await act(async () => release(page([stale], false, null)));
    expect(within(screen.getByRole("table")).queryByText("Claim cancel")).toBeNull();
    expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy();
  });

  it("keeps the rows and shows an error beside the control when Load more fails", async () => {
    const get = vi.fn(
      async (path: string, args?: { params?: { query?: Record<string, unknown> } }) => {
        if (path !== "/api/v1/billing/dde-items") return ok({});
        return args?.params?.query?.cursor ? fail(500, "INTERNAL") : page([item()], true, "C1");
      },
    );
    mount(apiWith(get), "/billing/dde");
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText(/More items could not be loaded/)).toBeTruthy();
    expect(within(screen.getByRole("table")).getAllByRole("row").length).toBe(2);
    expect(screen.queryByText("DDE queue unavailable")).toBeNull();
  });

  it("clears the 412 notice once an action succeeds, without nesting alerts", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(fail(412, "VERSION_CONFLICT"))
      .mockResolvedValue(ok({}));
    const { api } = setup({
      post,
      pages: [{ items: [item({ allowedActions: ["start"] })], hasMore: false, nextCursor: null }],
    });
    mount(api);
    fireEvent.click((await rail()).getByRole("button", { name: "Start work" }));
    const banner = await screen.findByText(/changed since you opened it/);
    expect(banner.closest("[role=alert]")?.parentElement?.closest("[role=alert]")).toBeNull();
    fireEvent.click((await rail()).getByRole("button", { name: "Start work" }));
    await waitFor(() => expect(screen.queryByText(/changed since you opened it/)).toBeNull());
  });

  it("lets Escape close the rail again after an edited form is dismissed", async () => {
    const { api } = setup();
    mount(api);
    const r = await rail();
    fireEvent.click(r.getByRole("button", { name: "Record as keyed in DDE" }));
    fireEvent.change(r.getByLabelText(/DCN/), { target: { value: DCN } });
    const aside = screen.getByRole("complementary");
    fireEvent.keyDown(aside, { key: "Escape" });
    expect(screen.queryByRole("complementary")).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "Back" }));
    fireEvent.keyDown(screen.getByRole("complementary"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
  });
});

describe("dates and drafts", () => {
  it("accepts only real calendar dates", () => {
    expect(isRealDate("2026-02-28")).toBe(true);
    expect(isRealDate("2026-02-31")).toBe(false);
    expect(isRealDate("2026-13-01")).toBe(false);
    expect(isRealDate("26-02-01")).toBe(false);
    expect(
      validateOutcome(
        { outcome: "accepted", macAcceptedOn: "2026-02-31", rtpReasonCode: "", dcn: "", notes: "" },
        item({ itemType: "adjustment" }),
      ).macAcceptedOn,
    ).toBeTruthy();
  });

  it("forgets every stashed draft on sign-out", () => {
    saveDraft("dde:x", { panel: "submit" });
    expect(loadDraft("dde:x")).toBeTruthy();
    clearAllDrafts();
    expect(loadDraft("dde:x")).toBeUndefined();
  });
});
