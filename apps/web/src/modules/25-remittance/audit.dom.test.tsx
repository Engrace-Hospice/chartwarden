// apps/web/src/modules/25-remittance — milestone 7a-1 audit requests and later-tier records. Asserts on RECORDED FETCH
// CALLS (method, path, If-Match, body). Rules under test: the authority is a label, claims are picked (never pasted),
// every date and its source note are typed by the user, a request/case with no recorded date is loud, federal court is
// record-only, and a remand/dismissal reads "needs manual review" with nothing spawned.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { AuditWorklist } from "./audit-worklist";
import { LaterTierPanel } from "./later-tier-panel";

const AUDIT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const CLAIM = "dddddddd-4444-4444-8444-dddddddddddd";
const APPEAL = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const DAY = 86_400_000;

type Call = { method: string; path: string; ifMatch: string | null; body: Record<string, unknown> };
let calls: Call[] = [];
let auditRows: Record<string, unknown>[] = [];
let auditDeadlines: Record<string, unknown>[] = [];
let laterTier: Record<string, unknown> = {};

const row = (over: Record<string, unknown>) => ({
  id: AUDIT,
  authorityKind: "rac",
  authorityName: null,
  requestReference: "RAC-1",
  receivedOn: "2026-02-01",
  state: "received",
  claimCount: 1,
  dueState: "no_deadline_recorded",
  nextDueAt: null,
  version: 3,
  createdAt: "2026-02-01T00:00:00.000Z",
  ...over,
});
const auditDetail = () => ({
  ...(auditRows[0] as Record<string, unknown>),
  requestDatedOn: null,
  scopeNote: null,
  providerEntityId: "eeeeeeee-5555-4555-8555-eeeeeeeeeeee",
  adrCaseId: null,
  denialCaseId: null,
  respondedAt: null,
  closedAt: null,
  claims: [{ id: "l1", claimId: CLAIM, dateOfServiceNote: null }],
  deadlines: auditDeadlines,
  events: [],
});
const deadline = (over: Record<string, unknown>) => ({
  id: "ffffffff-6666-4666-8666-ffffffffffff",
  subjectKind: "audit_request",
  subjectId: AUDIT,
  label: "Records due",
  dueOn: "2099-03-13",
  zone: "America/New_York",
  dueAt: "2099-03-13T12:00:00.000Z",
  sourceNote: "Letter p.2",
  noticeDocumentId: null,
  satisfiedOn: null,
  status: "open",
  version: 2,
  ...over,
});
const tierView = (over: Record<string, unknown>) => ({
  appealCaseId: APPEAL,
  claimId: CLAIM,
  tier: "alj",
  state: "draft",
  filedByEscalation: false,
  windowUnconfirmed: true,
  canPacketRender: true,
  needsManualReview: false,
  detail: null,
  deadlines: [],
  ...over,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const url = new URL(req ? req.url : String(input), "http://localhost");
  const path = url.pathname;
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    const raw = req ? await req.clone().text() : typeof init?.body === "string" ? init.body : "";
    calls.push({
      method,
      path,
      ifMatch: req?.headers.get("if-match") ?? null,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    });
    return json(method === "POST" && path.endsWith("/audit-requests") ? 201 : 200, {
      id: AUDIT,
      version: 4,
    });
  }
  if (path === "/api/v1/audit-requests") return json(200, { items: auditRows });
  if (path === `/api/v1/audit-requests/${AUDIT}`) return json(200, auditDetail());
  if (path === `/api/v1/appeals/${APPEAL}/later-tier`) return json(200, laterTier);
  if (path === `/api/v1/claims/${CLAIM}/case-view`) {
    return json(200, {
      claimId: CLAIM,
      generatedAt: "2026-02-02T00:00:00.000Z",
      nextDeadline: null,
      items: [],
      truncated: false,
    });
  }
  if (path === "/api/v1/billing/claims") {
    return json(200, {
      items: [
        {
          claimId: CLAIM,
          claimControlNumber: "CCN-100",
          state: "denied",
          serviceFrom: "2026-01-01",
          serviceTo: "2026-01-31",
        },
      ],
    });
  }
  if (path === "/api/v1/provider-entities") return json(200, { items: [], nextCursor: null });
  return json(200, {});
}

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "ffffffff-6666-4666-8666-ffffffffffff",
  roles: ["billing_specialist"],
  permissions: [],
  isAdmin: false,
};

function mount(ui: JSX.Element): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter>{ui}</MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

beforeEach(() => {
  calls = [];
  auditRows = [row({})];
  auditDeadlines = [];
  laterTier = tierView({});
});
afterEach(() => cleanup());

const kpi = (label: string): string => screen.getByText(label).parentElement?.textContent ?? "";

describe("M25 audit worklist", () => {
  it("counts open requests, requests with no due date, and those due within 7 days", async () => {
    auditRows = [
      row({ id: "a1" }),
      row({ id: "a2", dueState: "open", nextDueAt: new Date(Date.now() + 3 * DAY).toISOString() }),
      row({ id: "a3", dueState: "open", nextDueAt: new Date(Date.now() + 30 * DAY).toISOString() }),
      row({ id: "a4", state: "responded", dueState: "not_applicable" }),
    ];
    mount(<AuditWorklist />);
    await screen.findAllByText("No due date recorded - enter it from the notice");
    expect(kpi("Open Requests")).toContain("3");
    expect(kpi("No Due Date")).toContain("1");
    expect(kpi("Due ≤ 7 Days")).toContain("1");
  });

  it("shows the loud no-due-date prompt in the row and in the opened request", async () => {
    mount(<AuditWorklist />);
    expect(await screen.findByText("No due date recorded - enter it from the notice")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Open audit request from/ }));
    await waitFor(() =>
      expect(
        screen.getAllByText("No due date recorded - enter it from the notice").length,
      ).toBeGreaterThan(1),
    );
  });
});

describe("M25 audit intake", () => {
  it("picks a claim through the lookup (no pasted id) and posts the label-only authority", async () => {
    mount(<AuditWorklist />);
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Log an audit request" }))[0] as HTMLElement,
    );
    const submit = (): HTMLButtonElement => screen.getByRole("button", { name: "Log request" });
    expect(screen.queryByLabelText(/Claim ID/)).toBeNull();
    expect(submit().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Date received"), { target: { value: "2026-02-01" } });
    const box = screen.getByRole("combobox", { name: /Add a claim/ });
    fireEvent.focus(box);
    fireEvent.click(await screen.findByRole("option", { name: /CCN-100/ }));
    await waitFor(() => expect(submit().disabled).toBe(false));
    fireEvent.click(submit());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/audit-requests",
      body: { authorityKind: "rac", receivedOn: "2026-02-01", claimIds: [CLAIM] },
    });
    expect(calls[0]?.body).not.toHaveProperty("dueOn");
  });

  it("requires a name when the authority is 'other'", async () => {
    mount(<AuditWorklist />);
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Log an audit request" }))[0] as HTMLElement,
    );
    fireEvent.change(screen.getByLabelText("Date received"), { target: { value: "2026-02-01" } });
    fireEvent.change(screen.getByLabelText(/Authority \(a label only\)/), {
      target: { value: "other" },
    });
    fireEvent.focus(screen.getByRole("combobox", { name: /Add a claim/ }));
    fireEvent.click(await screen.findByRole("option", { name: /CCN-100/ }));
    expect(
      (screen.getByRole("button", { name: "Log request" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Authority name"), {
      target: { value: "Acme Audit Co" },
    });
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Log request" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });
});

describe("M25 audit recorded deadlines", () => {
  async function openRecordModal(): Promise<void> {
    mount(<AuditWorklist />);
    fireEvent.click(await screen.findByRole("button", { name: /Open audit request from/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Record a deadline" }));
  }

  it("will not record a date without the source note, then posts what was typed", async () => {
    await openRecordModal();
    const dialog = await screen.findByRole("dialog");
    const submit = (): HTMLButtonElement =>
      within(dialog).getByRole("button", { name: "Record deadline" });
    fireEvent.change(within(dialog).getByLabelText("What is due"), {
      target: { value: "Records due" },
    });
    fireEvent.change(within(dialog).getByLabelText("Due date (from the notice)"), {
      target: { value: "2099-03-13" },
    });
    expect(submit().disabled).toBe(true);
    expect(within(dialog).queryByLabelText(/Notice document/)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(/Source note/), {
      target: { value: "Letter p.2" },
    });
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/audit-requests/${AUDIT}/recorded-deadlines`,
      body: { label: "Records due", dueOn: "2099-03-13", sourceNote: "Letter p.2" },
    });
  });

  it("satisfies a deadline with its own version as If-Match", async () => {
    auditDeadlines = [deadline({})];
    mount(<AuditWorklist />);
    fireEvent.click(await screen.findByRole("button", { name: /Open audit request from/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Mark Records due satisfied" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/audit-requests/${AUDIT}/recorded-deadlines/${String(deadline({}).id)}/satisfy`,
      ifMatch: "2",
    });
  });
});

describe("M25 later-tier panel", () => {
  const mountTier = () =>
    mount(<LaterTierPanel appealId={APPEAL} appealState="draft" onChanged={() => undefined} />);

  it("badges an ALJ window the API says is unconfirmed and loudly prompts for the missing date", async () => {
    mountTier();
    expect(await screen.findByText("Window not SME-confirmed")).toBeTruthy();
    expect(screen.getByText("No due date recorded - enter it from the notice")).toBeTruthy();
    expect(screen.getByText(/never compared to anything/)).toBeTruthy();
  });

  it("creates the ALJ detail with If-Match 0 and sends no counsel or docket field", async () => {
    mountTier();
    fireEvent.change(await screen.findByLabelText(/Authority reference/), {
      target: { value: "OMHA-9" },
    });
    fireEvent.change(screen.getByLabelText("Amount in controversy (cents)"), {
      target: { value: "12345" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record details" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "PUT",
      path: `/api/v1/appeals/${APPEAL}/later-tier/detail`,
      ifMatch: "0",
      body: { authorityReference: "OMHA-9", amountInControversyCents: 12345 },
    });
    expect(calls[0]?.body).not.toHaveProperty("docketReference");
    expect(calls[0]?.body).not.toHaveProperty("filedByCounselOn");
  });

  it("makes federal court record-only: counsel and docket fields, no packet, no submit, no hearing fields", async () => {
    laterTier = tierView({
      tier: "federal_court",
      canPacketRender: false,
      detail: {
        id: "x",
        authorityReference: null,
        amountInControversyCents: null,
        hearingOn: null,
        hearingFormatNote: null,
        dispositionKind: null,
        dispositionNote: null,
        filedByCounselOn: null,
        docketReference: null,
        version: 6,
      },
    });
    mountTier();
    fireEvent.change(await screen.findByLabelText("Docket reference"), {
      target: { value: "1:26-cv-100" },
    });
    expect(screen.queryByLabelText("Hearing date")).toBeNull();
    expect(screen.queryByRole("button", { name: /packet|submit/i })).toBeNull();
    expect(screen.getByText(/filed by counsel outside ChartWarden/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "PUT",
      ifMatch: "6",
      body: { docketReference: "1:26-cv-100", filedByCounselOn: null },
    });
    expect(calls[0]?.body).not.toHaveProperty("hearingOn");
  });

  it("labels a remand as needing manual review and creates nothing", async () => {
    laterTier = tierView({ needsManualReview: true });
    mountTier();
    expect(await screen.findByText(/Needs manual review/)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("sends a notice document id only for an appeal deadline, with the mandatory source note", async () => {
    mountTier();
    fireEvent.click(await screen.findByRole("button", { name: "Record a deadline" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("What is due"), {
      target: { value: "File brief" },
    });
    fireEvent.change(within(dialog).getByLabelText("Due date (from the notice)"), {
      target: { value: "2099-04-01" },
    });
    expect(within(dialog).getByLabelText(/Notice document/)).toBeTruthy();
    const submit = within(dialog).getByRole("button", {
      name: "Record deadline",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Source note/), {
      target: { value: "Hearing notice" },
    });
    fireEvent.click(submit);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      path: `/api/v1/appeals/${APPEAL}/recorded-deadlines`,
      body: { label: "File brief", dueOn: "2099-04-01", sourceNote: "Hearing notice" },
    });
  });
});
