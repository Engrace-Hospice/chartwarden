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
  canSyncProvider,
  evidenceOf,
  providerBadge,
  providerRefusal,
  providerStatusText,
  syncMessage,
} from "../dde-provider-model";
import { DdeQueue } from "../dde-queue";
import type { DdeItem } from "../dde-queue-model";
import { clearAllDrafts } from "../write-workflow";

beforeEach(() => clearAllDrafts());

const ITEM = "c3d4e5f6-0000-4000-8000-000000000001";
const PATIENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

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
}

function setup(o: Setup = {}) {
  const detail = o.detail ?? item();
  const post = o.post ?? vi.fn(async () => ok({}));
  const get = vi.fn(async (path: string) => {
    if (path === "/api/v1/billing/dde-items")
      return ok({ items: [detail], hasMore: false, nextCursor: null });
    if (path === "/api/v1/billing/dde-items/{id}") return ok({ ...detail, events: [] });
    if (path === "/api/v1/admin/billing/dde-provider")
      return o.status === "forbidden" || !o.status ? fail(403, "FORBIDDEN") : ok(o.status);
    if (path === "/api/v1/billing/eligibility/hospice-periods")
      return o.hospice === "forbidden" ? fail(403, "FORBIDDEN") : ok(o.hospice ?? HOSPICE);
    return ok({ firstName: "Pat", lastName: "Patient" });
  });
  return { api: { GET: get, POST: post } as unknown as ApiClient, get, post };
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

function mount(api: ApiClient, permissions: string[] = []) {
  const session = {
    userId: "u",
    organizationId: "org",
    membershipId: "m",
    roles: [],
    permissions,
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
  it("badges who keyed it and says nothing before anything is recorded", () => {
    expect(providerBadge({ submissionMode: "provider" })?.label).toBe("Via provider");
    expect(providerBadge({ submissionMode: "manual" })?.label).toBe("Keyed by hand");
    expect(providerBadge({ submissionMode: null })).toBeNull();
    expect(providerBadge({})).toBeNull();
  });

  it("only calls an answer verified when the provider gave it", () => {
    const accepted = { state: "accepted", macAcceptedOn: "2026-10-05" } as const;
    expect(evidenceOf({ ...accepted, submissionMode: "provider" })).toMatchObject({
      verified: true,
    });
    expect(evidenceOf({ ...accepted, submissionMode: "manual" })).toMatchObject({
      verified: false,
    });
    expect(evidenceOf({ ...accepted, submissionMode: null })?.label).toMatch(/Attested/);
    expect(
      evidenceOf({ state: "submitted", macAcceptedOn: null, submissionMode: "provider" }),
    ).toMatchObject({ verified: false });
    expect(evidenceOf({ state: "queued", macAcceptedOn: null, submissionMode: null })).toBeNull();
  });

  it("offers sync only for provider-submitted items the server allows", () => {
    expect(canSyncProvider({ submissionMode: "provider", allowedActions: ["sync_provider"] })).toBe(
      true,
    );
    expect(canSyncProvider({ submissionMode: "manual", allowedActions: ["sync_provider"] })).toBe(
      false,
    );
    expect(canSyncProvider({ submissionMode: "provider", allowedActions: [] })).toBe(false);
  });

  it.each([
    ["DDE_NOT_WIRED", /manual keying/i, false, false],
    ["DDE_NOT_PROVISIONED", /not set up/i, false, false],
    ["DDE_UNAVAILABLE", /try again/i, true, false],
    ["DDE_OPERATOR_NOT_ENROLLED", /DDE ID/, false, false],
    ["DDE_IN_DOUBT", /Do not send it again/, false, true],
    ["DDE_PROVIDER_ERROR", /returned an error/, true, false],
    ["DDE_PROVIDER_ANSWER_INVALID", /could not be trusted/, false, false],
    ["DDE_IDEMPOTENCY_CONFLICT", /earlier attempt/, false, false],
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
    const gate = Promise.withResolvers<unknown>();
    const post = vi.fn(() => gate.promise);
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

  it("says the provider is not configured, announces it, and keeps manual keying usable", async () => {
    const post = vi.fn(async () => fail(503, "DDE_NOT_WIRED"));
    const { api } = setup({ post });
    mount(api);
    const r = await rail();
    fireEvent.click(r.getByRole("button", SEND));
    const alert = await r.findByRole("alert");
    expect(alert.textContent).toMatch(/No DDE provider is configured/);
    expect(alert.textContent).toMatch(/manual keying/i);
    expect(r.getByRole("button", { name: "Record as keyed in DDE" })).toBeTruthy();
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
    const post = vi.fn(async () => fail(409, "DDE_IN_DOUBT"));
    const { api } = setup({ post });
    mount(api);
    const r = await rail();
    fireEvent.click(r.getByRole("button", SEND));
    expect((await r.findByRole("alert")).textContent).toMatch(/Do not send it again/);
    expect(r.queryByRole("button", SEND)).toBeNull();
    expect(r.getByRole("button", { name: "Record as keyed in DDE" })).toBeTruthy();
  });

  it("reloads on a version conflict instead of retrying", async () => {
    const post = vi.fn(async () => fail(412, "VERSION_CONFLICT"));
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
    expect(r.getByRole("button", { name: "Record as keyed in DDE" })).toBeTruthy();
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
    const { api } = setup({
      detail: providerItem({ state: "accepted", macAcceptedOn: "2026-10-05", allowedActions: [] }),
    });
    mount(api);
    const r = await rail();
    expect(r.getByText("Verified by the DDE provider")).toBeTruthy();
    expect(r.getByText("EA-12345")).toBeTruthy();
  });

  it("labels a hand-recorded acceptance as attested", async () => {
    const { api } = setup({
      detail: item({
        state: "accepted",
        submissionMode: "manual",
        macAcceptedOn: "2026-10-05",
        allowedActions: [],
      }),
    });
    mount(api);
    expect((await rail()).getByText(/Attested by the operator/)).toBeTruthy();
  });

  it("badges each row with how it was keyed", async () => {
    const { api } = setup({ detail: providerItem() });
    mount(api);
    const row = within(await screen.findByRole("table"));
    expect(row.getByText("Via provider")).toBeTruthy();
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
