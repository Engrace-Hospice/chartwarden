// Sending a DDE queue item through the DDE access provider (ADR-0103, #761): the provider badge, the Send and Sync
// actions (one Idempotency-Key per attempt, one POST per click, step-up round trip, manual keying always kept), the
// plain-language refusals (not wired, not enrolled, in doubt: no retry), verified-vs-attested evidence, the
// platform provider status for administrators, and the hospice eligibility panel. Deterministic: waitFor/findBy only.
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import {
  canSubmitViaProvider,
  canSyncProvider,
  evidenceOf,
  providerBadge,
  providerRefusal,
  providerStatusText,
  syncMessage,
} from "../dde-provider-model";
import { DdeQueue } from "../dde-queue";
import type { DdeEvent, DdeItem, DdeProviderCapability } from "../dde-queue-model";
import { clearAllDrafts } from "../write-workflow";

beforeEach(() => clearAllDrafts());

const ITEM = "c3d4e5f6-0000-4000-8000-000000000001";
const PATIENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TEST_PROVIDER: DdeProviderCapability = {
  mode: "test_provider",
  label: "Test provider — not connected to Medicare",
  submissionItemTypes: [
    "noe",
    "notr",
    "claim_entry",
    "rtp_correction",
    "adjustment",
    "cancel",
    "adr_response",
  ],
  statusCheckItemTypes: [
    "noe",
    "notr",
    "claim_entry",
    "rtp_correction",
    "adjustment",
    "cancel",
    "adr_response",
  ],
  explanation: "Local reference provider only.",
};

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});
const fail = (status: number, code: string, message = code) => ({
  data: undefined,
  error: { error: { code, message } },
  response: new Response(null, { status }),
});

function item(over: Partial<DdeItem> = {}): DdeItem {
  return {
    ddeWorkItemId: ITEM,
    patientId: PATIENT,
    providerEntityId: "77777777-7777-4777-8777-777777777777",
    itemType: "claim_entry",
    subjectKind: "claim",
    subjectId: "34343434-3434-4434-8434-343434343434",
    state: "in_progress",
    attemptNumber: 1,
    assigneeMembershipId: "abababab-abab-4bab-8bab-abababababab",
    priority: 1,
    source: "manual",
    deadlineAt: "2026-10-10",
    deadlineStatus: "at_risk",
    submittedAt: null,
    macAcceptedOn: null,
    submissionMode: null,
    providerReference: null,
    dcn: null,
    rtpReasonCode: null,
    outcomeCode: null,
    notes: null,
    allowedActions: ["record_submission", "submit_via_provider", "cancel"],
    version: 3,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

const HOSPICE = {
  status: "available",
  hetsConfigured: true,
  checkId: "c1",
  asOfServiceDate: "2026-10-01",
  outcome: "eligible",
  checkedAt: "2026-10-20T10:00:00.000Z",
  staleAt: null,
  stale: false,
  synthetic: false,
  hospiceHistoryReturned: true,
  hospiceElectionOpen: true,
  hospiceHistoryTruncated: false,
  nextPeriodNumber: null,
  nextPeriodBasis: "election_open",
  lastAttempt: null,
};

interface Setup {
  detail?: DdeItem;
  post?: ReturnType<typeof vi.fn>;
  status?: { provider: string; wired: boolean } | "forbidden";
  hospice?: unknown;
  providerCapability?: DdeProviderCapability;
  events?: DdeEvent[];
  listFailureAfter?: number;
}

function setup(o: Setup = {}) {
  let detail = o.detail ?? item();
  let listCalls = 0;
  const post = o.post ?? vi.fn(async () => ok({}));
  const get = vi.fn(async (path: string) => {
    if (path === "/api/v1/billing/dde-items") {
      listCalls += 1;
      if (o.listFailureAfter !== undefined && listCalls >= o.listFailureAfter) {
        throw new Error("synthetic queue reload failure");
      }
      return ok({
        items: [detail],
        providerCapability: o.providerCapability ?? TEST_PROVIDER,
        hasMore: false,
        nextCursor: null,
      });
    }
    if (path === "/api/v1/billing/dde-items/{id}") return ok({ ...detail, events: o.events ?? [] });
    if (path === "/api/v1/admin/billing/dde-provider")
      return o.status === "forbidden" || !o.status ? fail(403, "FORBIDDEN") : ok(o.status);
    if (path === "/api/v1/billing/eligibility/hospice-periods")
      return o.hospice === "forbidden" ? fail(403, "FORBIDDEN") : ok(o.hospice ?? HOSPICE);
    return ok({ firstName: "Pat", lastName: "Patient" });
  });
  // Stands in for the server: a refused-in-doubt send leaves the durable marker (and moves the version by 2).
  const markInDoubt = () => {
    detail = { ...detail, providerInDoubt: true, version: detail.version + 2 };
  };
  return { api: { GET: get, POST: post } as unknown as ApiClient, get, post, markInDoubt };
}

function Where(): JSX.Element {
  const l = useLocation();
  return (
    <output data-testid="where">
      {l.pathname}
      {l.search}
    </output>
  );
}

function mount(api: ApiClient, permissions?: string[]) {
  const session = {
    userId: "u",
    organizationId: "org",
    membershipId: "abababab-abab-4bab-8bab-abababababab",
    roles: [],
    permissions: permissions ?? [
      "billing.dde.read",
      "billing.dde.work",
      "billing.dde.mark_submitted",
      "billing.dde.submit_via_provider",
      "billing.dde.admin",
    ],
    isAdmin: false,
  };
  return render(
    <ApiClientProvider client={api}>
      <SessionProvider session={session}>
        <MemoryRouter initialEntries={[`/billing/dde?item=${ITEM}`]}>
          <Routes>
            <Route path="/billing/dde" element={<DdeQueue />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
}
const rail = async () => within(await screen.findByRole("complementary"));
const SEND = { name: "Send via provider" };

describe("provider model", () => {
  it("badges who keyed it and says Not sent before anything is recorded", () => {
    expect(providerBadge({ submissionMode: "provider" })?.label).toBe("Provider receipt");
    expect(providerBadge({ submissionMode: "manual" })?.label).toBe("Manual submission");
    expect(providerBadge({ submissionMode: null })).toEqual({ label: "Not sent", tone: "neutral" });
    expect(providerBadge({})).toEqual({ label: "Not sent", tone: "neutral" });
    expect(providerBadge({ submissionMode: null, state: "accepted" }).label).toBe(
      "Mode not recorded",
    );
  });

  it("only calls an answer verified when the provider gave it", () => {
    const base = { attemptNumber: 2, providerReference: "ref-2" };
    const providerOutcome = {
      eventId: "event-2",
      event: "accept",
      fromState: "submitted",
      toState: "accepted",
      attemptNumber: 2,
      actorKind: "user",
      detail: { submissionMode: "provider", providerReference: "ref-2" },
      occurredAt: "2026-10-05T00:00:00.000Z",
    };
    expect(
      evidenceOf({
        ...base,
        state: "accepted",
        macAcceptedOn: "2026-10-05",
        submissionMode: "provider",
        events: [providerOutcome],
      }),
    ).toMatchObject({ verified: true, label: "Outcome reported by the DDE provider" });
    expect(
      evidenceOf({
        ...base,
        state: "accepted",
        macAcceptedOn: "2026-10-05",
        submissionMode: "provider",
        events: [{ ...providerOutcome, detail: { outcomeSource: "operator" } }],
      }),
    ).toMatchObject({ verified: false, label: "Outcome recorded by an operator" });
    expect(
      evidenceOf({
        ...base,
        state: "accepted",
        macAcceptedOn: "2026-10-05",
        submissionMode: null,
      })?.label,
    ).toBe("Outcome source unknown");
    expect(
      evidenceOf({ ...base, state: "submitted", macAcceptedOn: null, submissionMode: "provider" }),
    ).toMatchObject({ verified: false, label: "Provider receipt recorded; outcome pending" });
    expect(
      evidenceOf({
        ...base,
        state: "submitted",
        macAcceptedOn: null,
        submissionMode: null,
        events: [
          {
            eventId: "event-submit",
            event: "submit",
            fromState: "in_progress",
            toState: "submitted",
            attemptNumber: 2,
            actorKind: "user",
            detail: { submissionSource: "operator_verified_existing" },
            occurredAt: "2026-10-05T00:00:00.000Z",
          },
        ],
      }),
    ).toMatchObject({
      verified: false,
      label: "Operator confirmed existing submission; channel unknown; outcome pending",
    });
    expect(
      evidenceOf({ ...base, state: "queued", macAcceptedOn: null, submissionMode: null }),
    ).toBeNull();
  });

  it("offers sync only for provider-submitted items the server allows", () => {
    expect(
      canSyncProvider(
        {
          itemType: "noe",
          submissionMode: "provider",
          providerReference: "ref",
          allowedActions: ["sync_provider"],
        },
        TEST_PROVIDER,
        true,
      ),
    ).toBe(true);
    expect(
      canSyncProvider(
        {
          itemType: "noe",
          submissionMode: "manual",
          providerReference: null,
          allowedActions: ["sync_provider"],
        },
        TEST_PROVIDER,
        true,
      ),
    ).toBe(false);
    expect(
      canSyncProvider(
        {
          itemType: "noe",
          submissionMode: "provider",
          providerReference: "ref",
          allowedActions: ["sync_provider"],
        },
        { ...TEST_PROVIDER, statusCheckItemTypes: [] },
        true,
      ),
    ).toBe(false);
    expect(canSubmitViaProvider("noe", null, true, false)).toBe(false);
    expect(canSubmitViaProvider("noe", TEST_PROVIDER, false, false)).toBe(false);
    const noeOnly: DdeProviderCapability = {
      ...TEST_PROVIDER,
      submissionItemTypes: ["noe"],
      statusCheckItemTypes: ["noe"],
    };
    expect(canSubmitViaProvider("claim_entry", noeOnly, true, false)).toBe(false);
    expect(
      canSyncProvider(
        {
          itemType: "claim_entry",
          submissionMode: "provider",
          providerReference: "ref",
          allowedActions: ["sync_provider"],
        },
        noeOnly,
        true,
      ),
    ).toBe(false);
  });

  it.each([
    ["DDE_NOT_WIRED", /manual keying/i, false, false],
    ["DDE_NOT_PROVISIONED", /not set up/i, false, false],
    ["DDE_UNAVAILABLE", /may have reached DDE/i, false, true],
    ["DDE_OPERATOR_NOT_ENROLLED", /DDE ID/, false, false],
    ["DDE_IN_DOUBT", /Do not send or key it again/, false, true],
    ["DDE_PROVIDER_ERROR", /may have reached DDE/, false, true],
    ["DDE_PROVIDER_ANSWER_INVALID", /not proof that DDE has no transaction/, false, true],
    ["DDE_IDEMPOTENCY_CONFLICT", /may already hold an operation/, false, true],
  ])("explains %s", (code, text, retryable, inDoubt) => {
    const r = providerRefusal({ error: { code } }, "x");
    expect(r?.message).toMatch(text);
    expect(r?.retryable).toBe(retryable);
    expect(r?.inDoubt).toBe(inDoubt);
  });

  it("passes the provider's own words for an invalid request and ignores non-DDE errors", () => {
    expect(
      providerRefusal({ error: { code: "DDE_INVALID_REQUEST", message: "bad TOB" } }, "x")?.message,
    ).toBe("bad TOB");
    expect(providerRefusal({ error: { code: "INTERNAL" } }, "x")).toBeNull();
  });

  it("classifies a read-only status failure separately from a submission failure", () => {
    expect(providerRefusal({ error: { code: "DDE_UNAVAILABLE" } }, "x", "status")).toMatchObject({
      inDoubt: false,
      retryable: true,
      message: expect.stringMatching(/status check did not complete/i),
    });
    expect(
      providerRefusal({ error: { code: "INTERNAL_SERVER_ERROR" } }, "x", "status"),
    ).toMatchObject({
      inDoubt: false,
      retryable: true,
      message: expect.stringMatching(/original submission and outcome are unchanged/i),
    });
    expect(providerRefusal({ error: { code: "DDE_NOT_READY" } }, "x", "status")).toMatchObject({
      message: expect.stringMatching(/not enabled for this operation.*unchanged/i),
      retryable: false,
      inDoubt: false,
    });
    expect(providerRefusal({ error: { code: "DDE_NOT_WIRED" } }, "x", "status")).toMatchObject({
      message: expect.stringMatching(/manual DDE.*unchanged/i),
      retryable: false,
      inDoubt: false,
    });
  });

  it("says in words what a pending provider answer means", () => {
    expect(syncMessage("received")).toMatch(/Nothing changed/);
    expect(syncMessage("not_found")).toMatch(/no record/);
    expect(providerStatusText({ provider: "manual", wired: false })).toMatch(/Manual keying only/);
    expect(providerStatusText({ provider: "episode_alert", wired: true })).toMatch(/Episode Alert/);
  });
});

describe("DDE item rail: send via provider", () => {
  it("sends with the expected version and one idempotency key, and reloads the item", async () => {
    const post = vi.fn(async () => ok({}));
    const { api, get } = setup({ post });
    mount(api);
    const r = await rail();
    const before = get.mock.calls.length;
    fireEvent.click(r.getByRole("button", SEND));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, args] = post.mock.calls[0] as unknown as [
      string,
      { params: { path: { id: string }; header: Record<string, string> }; body: unknown },
    ];
    expect(path).toBe("/api/v1/billing/dde-items/{id}/submit-via-provider");
    expect(args.params.path.id).toBe(ITEM);
    expect(args.params.header["Idempotency-Key"]).toBeTruthy();
    expect(args.body).toEqual({ expectedVersion: 3 });
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(before));
  });

  it("disables the button while pending so a double click posts once", async () => {
    const gate: { resolve: (v: unknown) => void } = { resolve: () => undefined };
    const pending = new Promise((res) => {
      gate.resolve = res;
    });
    const post = vi.fn(() => pending);
    const { api } = setup({ post });
    mount(api);
    const r = await rail();
    const button = r.getByRole("button", SEND) as HTMLButtonElement;
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(post).toHaveBeenCalledTimes(1);
    gate.resolve(ok({}));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  });

  it("goes to /step-up with returnTo when a recent step-up is missing", async () => {
    const post = vi.fn(async () => fail(403, "STEP_UP_REQUIRED"));
    const { api } = setup({ post });
    mount(api);
    fireEvent.click((await rail()).getByRole("button", SEND));
    const where = await screen.findByTestId("where");
    expect(where.textContent).toContain("/step-up");
    expect(decodeURIComponent(where.textContent ?? "")).toContain(
      `returnTo=/billing/dde?item=${ITEM}`,
    );
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("keeps manual DDE as the available workflow when the provider is not configured", async () => {
    const post = vi.fn(async () => ok({}));
    const { api } = setup({
      post,
      providerCapability: {
        mode: "manual_only",
        label: "Manual DDE workflow",
        submissionItemTypes: [],
        statusCheckItemTypes: [],
        explanation: "No electronic DDE provider is enabled.",
      },
    });
    mount(api);
    const r = await rail();
    expect(screen.getByRole("status", { name: "DDE operating mode" }).textContent).toMatch(
      /Manual DDE workflow/,
    );
    expect(r.queryByRole("button", SEND)).toBeNull();
    expect(r.getByRole("button", { name: "Record manual submission" })).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it("drops a stale provider capability after a queue refresh fails", async () => {
    const detail = item({ state: "queued", allowedActions: ["start", "submit_via_provider"] });
    const { api } = setup({ detail, listFailureAfter: 2 });
    mount(api);
    const r = await rail();
    expect(r.getByRole("button", SEND)).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "Start work" }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/could not be loaded/i);
    });
    expect(r.queryByRole("button", SEND)).toBeNull();
  });

  it("hides provider actions from an actor without the provider permission", async () => {
    const { api } = setup();
    mount(api, []);
    const r = await rail();
    expect(r.queryByRole("button", SEND)).toBeNull();
    expect(r.queryByRole("button", { name: "Check provider status" })).toBeNull();
  });

  it("labels the in-memory reference provider as a test provider", async () => {
    const { api } = setup();
    mount(api);
    expect((await screen.findByRole("status", { name: "DDE operating mode" })).textContent).toMatch(
      /Test provider — not connected to Medicare/,
    );
  });

  it("tells an operator without a DDE ID so", async () => {
    const post = vi.fn(async () => fail(409, "DDE_OPERATOR_NOT_ENROLLED"));
    const { api } = setup({ post });
    mount(api);
    const r = await rail();
    fireEvent.click(r.getByRole("button", SEND));
    expect((await r.findByRole("alert")).textContent).toMatch(/do not have a DDE ID/);
  });

  it("offers no retry after DDE_IN_DOUBT but keeps recording by hand", async () => {
    const hold: { mark?: () => void } = {};
    const post = vi.fn(async () => {
      hold.mark?.();
      return fail(409, "DDE_IN_DOUBT");
    });
    const { api, markInDoubt } = setup({ post });
    hold.mark = markInDoubt;
    mount(api);
    const r = await rail();
    fireEvent.click(r.getByRole("button", SEND));
    expect((await r.findByRole("alert")).textContent).toMatch(/Verify the transaction in DDE/);
    await waitFor(() => expect(r.queryByRole("button", SEND)).toBeNull());
    expect(r.getByRole("button", { name: "Record confirmed submission" })).toBeTruthy();
  });

  it("requires explicit DDE verification before resolving an uncertain submission", async () => {
    const detail = item({
      providerInDoubt: true,
      providerInDoubtAt: "2026-10-25T10:00:00.000Z",
      allowedActions: ["record_submission"],
    });
    const { api, post } = setup({ detail });
    mount(api);
    const r = await rail();
    fireEvent.click(r.getByRole("button", { name: "Record confirmed submission" }));
    const form = r.getByRole("form", { name: "Record confirmed submission" });
    fireEvent.submit(form);
    await waitFor(() => {
      expect(
        r
          .getAllByRole("alert")
          .some((alert) => /found this transaction in DDE/i.test(alert.textContent ?? "")),
      ).toBe(true);
    });
    expect(post).not.toHaveBeenCalled();

    fireEvent.click(r.getByRole("checkbox", { name: "I verified this transaction exists in DDE" }));
    fireEvent.submit(form);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]?.[1]).toMatchObject({
      body: { confirmedExistingTransaction: true },
    });
  });

  it("requires explicit DDE verification before recording an outcome on an uncertain attempt", async () => {
    const detail = item({
      state: "submitted",
      submittedAt: "2026-10-25T09:00:00.000Z",
      submissionMode: "manual",
      providerInDoubt: true,
      providerInDoubtAt: "2026-10-25T10:00:00.000Z",
      allowedActions: ["record_outcome"],
    });
    const { api, post } = setup({ detail });
    mount(api);
    const r = await rail();
    fireEvent.click(r.getByRole("button", { name: "Record confirmed outcome" }));
    const form = r.getByRole("form", { name: "Record confirmed outcome" });
    fireEvent.change(within(form).getByRole("combobox"), { target: { value: "returned" } });
    fireEvent.change(await within(form).findByRole("textbox", { name: /RTP reason code/ }), {
      target: { value: "37001" },
    });
    fireEvent.submit(form);
    await waitFor(() => {
      expect(
        r
          .getAllByRole("alert")
          .some((alert) =>
            /found this transaction and outcome in DDE/i.test(alert.textContent ?? ""),
          ),
      ).toBe(true);
    });
    expect(post).not.toHaveBeenCalled();

    fireEvent.click(
      r.getByRole("checkbox", { name: "I verified this transaction and outcome in DDE" }),
    );
    fireEvent.submit(form);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]?.[1]).toMatchObject({
      body: { confirmedExistingTransaction: true, outcome: "returned" },
    });
  });

  it("treats a lost response on Send as in doubt once the server shows its marker", async () => {
    const hold: { mark?: () => void } = {};
    const post = vi.fn(async () => {
      hold.mark?.();
      throw new Error("network");
    });
    const { api, markInDoubt } = setup({ post });
    hold.mark = markInDoubt;
    mount(api);
    const r = await rail();
    fireEvent.click(r.getByRole("button", SEND));
    expect((await r.findByRole("alert")).textContent).toMatch(/Verify the transaction in DDE/);
    await waitFor(() => expect(r.queryByRole("button", SEND)).toBeNull());
  });

  it("keeps Send blocked after a lost response even when the reload shows no marker yet", async () => {
    const post = vi.fn(async () => {
      throw new Error("network");
    });
    const { api } = setup({ post });
    mount(api);
    const r = await rail();
    fireEvent.click(r.getByRole("button", SEND));
    await waitFor(() => {
      expect(
        r
          .getAllByRole("alert")
          .some((alert) => /Verify the transaction in DDE/.test(alert.textContent ?? "")),
      ).toBe(true);
    });
    expect(r.queryByRole("button", SEND)).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("keeps an in-doubt item blocked after a reload, with guidance and the manual path", async () => {
    const detail = item({
      providerInDoubt: true,
      providerInDoubtAt: "2026-10-25T10:00:00.000Z",
      allowedActions: [
        "record_submission",
        "submit_via_provider",
        "sync_provider",
        "retry",
        "cancel",
      ],
      submissionMode: "provider",
    });
    const { api, post } = setup({ detail });
    mount(api);
    const r = await rail();
    expect(await r.findByText(/Do not resend or key it again/)).toBeTruthy();
    expect(r.queryByRole("button", SEND)).toBeNull();
    expect(r.queryByRole("button", { name: "Check provider status" })).toBeNull();
    expect(r.queryByRole("button", { name: "Reopen as a new attempt" })).toBeNull();
    expect(r.queryByRole("button", { name: "Cancel item" })).toBeNull();
    expect(r.getByRole("button", { name: "Record confirmed submission" })).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it("offers Send again once the marker is cleared (older server: field absent)", async () => {
    const { api } = setup({ detail: item({ providerInDoubt: false }) });
    mount(api);
    expect((await rail()).getByRole("button", SEND)).toBeTruthy();
  });

  it("reloads on a version conflict instead of retrying", async () => {
    const post = vi.fn(async () => fail(409, "STALE_VERSION"));
    const { api } = setup({ post });
    mount(api);
    fireEvent.click((await rail()).getByRole("button", SEND));
    expect(await screen.findByText(/changed since you opened it/)).toBeTruthy();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("hides Send when the server does not allow it", async () => {
    const { api } = setup({ detail: item({ allowedActions: ["record_submission"] }) });
    mount(api);
    const r = await rail();
    expect(r.queryByRole("button", SEND)).toBeNull();
    expect(r.getByRole("button", { name: "Record manual submission" })).toBeTruthy();
  });
});

describe("DDE item rail: provider status check and evidence", () => {
  const providerItem = (over: Partial<DdeItem> = {}) =>
    item({
      state: "submitted",
      submissionMode: "provider",
      providerReference: "EA-12345",
      submittedAt: "2026-10-02T10:00:00.000Z",
      allowedActions: ["sync_provider", "record_outcome", "record_acceptance"],
      ...over,
    });

  it("checks the provider with no body and announces a pending answer as unchanged", async () => {
    const post = vi.fn(async () => ok({ item: providerItem(), providerState: "received" }));
    const { api } = setup({ detail: providerItem(), post });
    mount(api);
    const r = await rail();
    fireEvent.click(r.getByRole("button", { name: "Check provider status" }));
    const status = await r.findByRole("status", { name: "Provider answer" });
    expect(status.textContent).toMatch(/Nothing changed/);
    const [path, args] = post.mock.calls[0] as unknown as [string, { body?: unknown }];
    expect(path).toBe("/api/v1/billing/dde-items/{id}/sync-provider");
    expect(args.body).toBeUndefined();
  });

  it("does not offer the check on a hand-keyed item", async () => {
    const { api } = setup({
      detail: providerItem({ submissionMode: "manual", allowedActions: ["sync_provider"] }),
    });
    mount(api);
    expect((await rail()).queryByRole("button", { name: "Check provider status" })).toBeNull();
  });

  it("shows a provider-verified acceptance and the provider reference", async () => {
    const providerOutcome: DdeEvent = {
      eventId: "event-1",
      event: "accept",
      fromState: "submitted",
      toState: "accepted",
      attemptNumber: 1,
      actorKind: "system",
      actorMembershipId: null,
      detail: {
        outcomeSource: "provider",
        submissionMode: "provider",
        providerReference: "EA-12345",
      },
      occurredAt: "2026-10-05T00:00:00.000Z",
    };
    const { api } = setup({
      detail: providerItem({ state: "accepted", macAcceptedOn: "2026-10-05", allowedActions: [] }),
      events: [providerOutcome],
    });
    mount(api);
    const r = await rail();
    expect(r.getByText("Outcome reported by the DDE provider")).toBeTruthy();
    expect(r.getByText("EA-12345")).toBeTruthy();
  });

  it("labels a hand-recorded acceptance as attested", async () => {
    const manualOutcome: DdeEvent = {
      eventId: "event-1",
      event: "accept",
      fromState: "submitted",
      toState: "accepted",
      attemptNumber: 1,
      actorKind: "user",
      actorMembershipId: "abababab-abab-4bab-8bab-abababababab",
      detail: { outcomeSource: "operator", macAcceptedOn: "2026-10-05" },
      occurredAt: "2026-10-05T00:00:00.000Z",
    };
    const { api } = setup({
      detail: item({
        state: "accepted",
        submissionMode: "manual",
        macAcceptedOn: "2026-10-05",
        allowedActions: [],
      }),
      events: [manualOutcome],
    });
    mount(api);
    expect((await rail()).getByText("Outcome recorded by an operator")).toBeTruthy();
  });

  it("separates provider submission provenance from an operator-recorded outcome", async () => {
    const submission: DdeEvent = {
      eventId: "event-submit",
      event: "submit",
      fromState: "in_progress",
      toState: "submitted",
      attemptNumber: 1,
      actorKind: "user",
      actorMembershipId: "abababab-abab-4bab-8bab-abababababab",
      detail: { submissionMode: "provider", submissionSource: "provider" },
      occurredAt: "2026-10-02T10:00:00.000Z",
    };
    const outcome: DdeEvent = {
      eventId: "event-accept",
      event: "accept",
      fromState: "submitted",
      toState: "accepted",
      attemptNumber: 1,
      actorKind: "user",
      actorMembershipId: "abababab-abab-4bab-8bab-abababababab",
      detail: { outcomeSource: "operator", macAcceptedOn: "2026-10-05" },
      occurredAt: "2026-10-05T00:00:00.000Z",
    };
    const { api } = setup({
      detail: providerItem({ state: "accepted", macAcceptedOn: "2026-10-05", allowedActions: [] }),
      events: [submission, outcome],
    });
    mount(api);
    const r = await rail();
    expect(r.getByText("Submitted via provider")).toBeTruthy();
    expect(r.getByText("Recorded by staff")).toBeTruthy();
    expect(r.getByText("Outcome recorded by an operator")).toBeTruthy();
    expect(r.queryByText("Provider-reported")).toBeNull();
  });

  it("keeps a confirmed existing transaction's unknown channel visible in history", async () => {
    const submission: DdeEvent = {
      eventId: "event-submit",
      event: "submit",
      fromState: "in_progress",
      toState: "submitted",
      attemptNumber: 1,
      actorKind: "user",
      actorMembershipId: "abababab-abab-4bab-8bab-abababababab",
      detail: {
        submissionSource: "operator_verified_existing",
        resolvedProviderInDoubt: true,
      },
      occurredAt: "2026-10-02T10:00:00.000Z",
    };
    const outcome: DdeEvent = {
      eventId: "event-return",
      event: "return",
      fromState: "submitted",
      toState: "returned",
      attemptNumber: 1,
      actorKind: "user",
      actorMembershipId: "abababab-abab-4bab-8bab-abababababab",
      detail: { outcomeSource: "operator", submissionSource: "operator_verified_existing" },
      occurredAt: "2026-10-05T00:00:00.000Z",
    };
    const { api } = setup({
      detail: item({
        state: "returned",
        submittedAt: "2026-10-02T10:00:00.000Z",
        submissionMode: null,
        outcomeCode: "returned",
        allowedActions: [],
      }),
      events: [submission, outcome],
    });
    mount(api);
    const r = await rail();
    expect(r.getAllByText("Mode not recorded").length).toBeGreaterThan(0);
    expect(r.getAllByText("Operator confirmed existing transaction; channel unknown")).toHaveLength(
      2,
    );
    expect(r.getByText("Outcome recorded by an operator")).toBeTruthy();
  });

  it("badges a not-yet-sent row as Not sent, and an older keyed row without a mode as such", async () => {
    const queued = setup({ detail: item({ submissionMode: null }) });
    const first = mount(queued.api);
    expect(await within(await screen.findByRole("table")).findByText("Not sent")).toBeTruthy();
    first.unmount();
    const older = setup({ detail: providerItem({ submissionMode: null }) });
    mount(older.api);
    const row = within(await screen.findByRole("table"));
    expect(await row.findByText("Mode not recorded")).toBeTruthy();
    expect(row.queryByText("Not sent")).toBeNull();
  });

  it("badges each row with how it was keyed", async () => {
    const { api } = setup({ detail: providerItem() });
    mount(api);
    const row = within(await screen.findByRole("table"));
    expect(row.getByText("Provider receipt")).toBeTruthy();
  });
});

describe("DDE queue: platform provider status and hospice eligibility", () => {
  it("shows administrators the provider binding, read-only", async () => {
    const { api } = setup({ status: { provider: "manual", wired: false } });
    mount(api, ["billing.rule_config.platform_admin"]);
    const status = await screen.findByRole("status", { name: "DDE provider" });
    expect(status.textContent).toMatch(/Manual keying only/);
  });

  it("does not ask or show anything to anyone without the platform key", async () => {
    const { api, get } = setup({ status: { provider: "manual", wired: false } });
    mount(api, []);
    await rail();
    expect(screen.queryByRole("status", { name: "DDE provider" })).toBeNull();
    expect(get).not.toHaveBeenCalledWith("/api/v1/admin/billing/dde-provider", expect.anything());
  });

  it("shows the hospice section of the latest eligibility check for the item's patient", async () => {
    const { api, get } = setup();
    mount(api);
    const panel = within(await screen.findByRole("region", { name: "Hospice eligibility" }));
    expect(await panel.findByText(/election still open/i)).toBeTruthy();
    expect(get).toHaveBeenCalledWith(
      "/api/v1/billing/eligibility/hospice-periods",
      expect.objectContaining({ params: { query: { patientId: PATIENT } } }),
    );
  });

  it("says plainly when there is no check on file or access is missing", async () => {
    const { api } = setup({ hospice: { ...HOSPICE, status: "no_check_on_file" } });
    mount(api);
    const panel = within(await screen.findByRole("region", { name: "Hospice eligibility" }));
    expect(await panel.findByText(/No eligibility check on file/)).toBeTruthy();
  });

  it("states that hospice history comes only from the recorded HETS check, not Episode Alert", async () => {
    const { api } = setup();
    mount(api);
    const panel = within(await screen.findByRole("region", { name: "Hospice eligibility" }));
    expect(await panel.findByText(/Episode Alert answers are not recorded here/)).toBeTruthy();
  });

  it("shows the check result in words, not as an enum token", async () => {
    const { api } = setup({ hospice: { ...HOSPICE, outcome: "active_part_a" } });
    mount(api);
    const panel = within(await screen.findByRole("region", { name: "Hospice eligibility" }));
    expect(await panel.findByText("active part a")).toBeTruthy();
  });

  it("labels a sandbox answer synthetic", async () => {
    const { api } = setup({ hospice: { ...HOSPICE, synthetic: true } });
    mount(api);
    const panel = within(await screen.findByRole("region", { name: "Hospice eligibility" }));
    expect(await panel.findByText(/Sandbox data/)).toBeTruthy();
  });

  it("stays quiet when the eligibility read is forbidden", async () => {
    const { api } = setup({ hospice: "forbidden" });
    mount(api);
    const panel = within(await screen.findByRole("region", { name: "Hospice eligibility" }));
    expect(await panel.findByText(/not available to you/i)).toBeTruthy();
  });
});
