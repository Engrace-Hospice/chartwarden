// apps/web/src/modules/25-remittance — milestone 7a-1 resilience: a version conflict reloads and keeps what was typed,
// a failed reload never wipes the screen, a deadline change never resets unsaved later-tier edits, a disabled submit
// says why, the later-tier PUT is always the full form, and the case timeline reads again after a change.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { AuditDetailPanel } from "./audit-detail-panel";
import { CaseViewPanel } from "./case-view-panel";
import { LaterTierPanel } from "./later-tier-panel";
import { formatDay } from "./remittance-status";

const AUDIT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const CLAIM = "dddddddd-4444-4444-8444-dddddddddddd";
const APPEAL = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const APPEAL_B = "cccccccc-3333-4333-8333-cccccccccccc";

type Call = { method: string; path: string; ifMatch: string | null; body: Record<string, unknown> };
let calls: Call[] = [];
let gets: string[] = [];
/** Per-path status for the NEXT responses; a list is consumed front to back. */
let failGet: Record<string, number> = {};
let failWrite: number | null = null;
let tierVersion = 5;
let auditVersion = 3;
let deadlineVersion = 2;
let auditState = "received";

const detail = (version: number, over: Record<string, unknown> = {}) => ({
  id: "x",
  authorityReference: "OMHA-1",
  amountInControversyCents: 100,
  hearingOn: "2026-05-01",
  hearingFormatNote: "phone",
  dispositionKind: null,
  dispositionNote: "note",
  filedByCounselOn: null,
  docketReference: null,
  version,
  ...over,
});
const tierView = (appealId: string) => ({
  appealCaseId: appealId,
  claimId: CLAIM,
  tier: "alj",
  state: "draft",
  filedByEscalation: false,
  windowUnconfirmed: false,
  canPacketRender: true,
  needsManualReview: false,
  detail: detail(tierVersion, appealId === APPEAL_B ? { authorityReference: "OTHER-B" } : {}),
  deadlines: [],
});
const auditDetail = () => ({
  id: AUDIT,
  authorityKind: "rac",
  authorityName: null,
  requestReference: "RAC-1",
  receivedOn: "2026-02-01",
  state: auditState,
  claimCount: 1,
  dueState: "no_deadline_recorded",
  nextDueAt: null,
  version: auditVersion,
  createdAt: "2026-02-01T00:00:00.000Z",
  requestDatedOn: "2026-01-31",
  scopeNote: null,
  providerEntityId: "eeeeeeee-5555-4555-8555-eeeeeeeeeeee",
  adrCaseId: null,
  denialCaseId: null,
  respondedAt: null,
  closedAt: null,
  claims: [{ id: "l1", claimId: CLAIM, claimControlNumber: "CCN-100", dateOfServiceNote: null }],
  deadlines: [
    {
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
      version: deadlineVersion,
    },
  ],
  events: [{ id: "e1", eventKind: "received", occurredAt: "2026-02-01T00:00:00.000Z" }],
  response: {
    items: [],
    documents: [],
    sentToReviewByMembershipId: null,
    reviewedByMembershipId: null,
    reviewedAt: null,
    deadlineNoneStatedAt: null,
    filing: null,
  },
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const path = new URL(req ? req.url : String(input), "http://localhost").pathname;
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    const raw = req ? await req.clone().text() : "";
    calls.push({
      method,
      path,
      ifMatch: req?.headers.get("if-match") ?? null,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    });
    if (failWrite !== null) {
      const status = failWrite;
      failWrite = null;
      // The record moved: the next read carries the newer versions.
      tierVersion += 1;
      auditVersion += 1;
      deadlineVersion += 1;
      return json(status, { error: { code: "VERSION_CONFLICT", message: "version moved" } });
    }
    return json(200, { id: AUDIT, version: 9 });
  }
  gets.push(path);
  const status = failGet[path];
  if (status) {
    delete failGet[path];
    return json(status, { error: { code: "X", message: "read failed" } });
  }
  if (path === `/api/v1/appeals/${APPEAL}/later-tier`) return json(200, tierView(APPEAL));
  if (path === `/api/v1/appeals/${APPEAL_B}/later-tier`) return json(200, tierView(APPEAL_B));
  if (path === `/api/v1/audit-requests/${AUDIT}`) return json(200, auditDetail());
  if (path === `/api/v1/claims/${CLAIM}/case-view`) {
    return json(200, {
      claimId: CLAIM,
      generatedAt: "2026-02-02T00:00:00.000Z",
      nextDeadline: null,
      items: [],
      truncated: false,
    });
  }
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

const CLIENT = createApiClient({ baseUrl: "http://localhost", fetch: stubFetch });
const wrap = (ui: JSX.Element): JSX.Element => (
  <ApiClientProvider client={CLIENT}>
    <SessionProvider session={SESSION}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </SessionProvider>
  </ApiClientProvider>
);
const mount = (ui: JSX.Element) => render(wrap(ui));

const tier = (appealId = APPEAL): JSX.Element => (
  <LaterTierPanel appealId={appealId} appealState="draft" onChanged={() => undefined} />
);
const count = (path: string): number => gets.filter((p) => p === path).length;

beforeEach(() => {
  calls = [];
  gets = [];
  failGet = {};
  failWrite = null;
  tierVersion = 5;
  auditVersion = 3;
  deadlineVersion = 2;
  auditState = "received";
});
afterEach(() => cleanup());

describe("M25 later-tier panel resilience", () => {
  it("always PUTs the full form: saving after editing one field still sends the unchanged ones", async () => {
    mount(tier());
    fireEvent.change(await screen.findByLabelText("Hearing format note"), {
      target: { value: "video" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "PUT",
      ifMatch: "5",
      body: {
        authorityReference: "OMHA-1",
        amountInControversyCents: 100,
        hearingOn: "2026-05-01",
        hearingFormatNote: "video",
        dispositionKind: null,
        dispositionNote: "note",
      },
    });
  });

  it("on a 409 reloads the new version and keeps the typed values for the retry", async () => {
    mount(tier());
    const field = await screen.findByLabelText("Hearing format note");
    fireEvent.change(field, { target: { value: "video" } });
    failWrite = 409;
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(count(`/api/v1/appeals/${APPEAL}/later-tier`)).toBe(2));
    expect(await screen.findByText("version moved")).toBeTruthy();
    expect((screen.getByLabelText("Hearing format note") as HTMLInputElement).value).toBe("video");
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.ifMatch).toBe("6");
    expect(calls[1]?.body).toMatchObject({ hearingFormatNote: "video" });
  });

  it("keeps the data and shows an inline error when the reload after a write fails", async () => {
    mount(tier());
    await screen.findByLabelText("Hearing format note");
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    failGet[`/api/v1/appeals/${APPEAL}/later-tier`] = 500;
    expect(await screen.findByText("read failed")).toBeTruthy();
    expect(screen.getByLabelText("Hearing format note")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers Retry only when nothing has loaded yet", async () => {
    failGet[`/api/v1/appeals/${APPEAL}/later-tier`] = 500;
    mount(tier());
    expect(await screen.findByText("read failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByLabelText("Hearing format note")).toBeTruthy();
  });

  it("does not reset unsaved edits when a recorded deadline changes", async () => {
    mount(tier());
    const field = await screen.findByLabelText("Authority reference (from the notice)");
    fireEvent.change(field, { target: { value: "UNSAVED" } });
    fireEvent.click(screen.getByRole("button", { name: "Record a deadline" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("What is due"), { target: { value: "Brief" } });
    fireEvent.change(within(dialog).getByLabelText("Due date (from the notice)"), {
      target: { value: "2099-04-01" },
    });
    fireEvent.change(within(dialog).getByLabelText(/Source note/), { target: { value: "Notice" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Record deadline" }));
    await waitFor(() => expect(count(`/api/v1/appeals/${APPEAL}/later-tier`)).toBe(2));
    expect(
      (screen.getByLabelText("Authority reference (from the notice)") as HTMLInputElement).value,
    ).toBe("UNSAVED");
  });

  it("resets the form when the panel is pointed at another appeal", async () => {
    const { rerender } = mount(tier());
    const field = await screen.findByLabelText("Authority reference (from the notice)");
    fireEvent.change(field, { target: { value: "UNSAVED" } });
    rerender(wrap(tier(APPEAL_B)));
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Authority reference (from the notice)") as HTMLInputElement).value,
      ).toBe("OTHER-B"),
    );
  });

  it("says why the deadline form cannot be submitted and ties the reason to the button", async () => {
    mount(tier());
    fireEvent.click(await screen.findByRole("button", { name: "Record a deadline" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("What is due"), { target: { value: "Brief" } });
    fireEvent.change(within(dialog).getByLabelText("Due date (from the notice)"), {
      target: { value: "2099-04-01" },
    });
    const submit = within(dialog).getByRole("button", { name: "Record deadline" });
    const reason = within(dialog).getByText(
      /Say which notice this date came from \(source note\)\./,
    );
    expect(submit.getAttribute("aria-describedby")).toBe(reason.id);
    expect(within(dialog).getByText(/Do not enter patient names/)).toBeTruthy();
  });
});

describe("M25 audit detail resilience", () => {
  const mountAudit = () =>
    mount(
      <AuditDetailPanel auditId={AUDIT} onClose={() => undefined} onChanged={() => undefined} />,
    );

  it("shows the claim control number, not a short id, and the events heading", async () => {
    mountAudit();
    expect(await screen.findByText("CCN-100")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Events" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeTruthy();
  });

  it("reloads on a state-move 409 and keeps the chosen move", async () => {
    mountAudit();
    fireEvent.click(await screen.findByRole("button", { name: "Move to In Assembly" }));
    failWrite = 409;
    fireEvent.click(screen.getByRole("button", { name: "Move to In Assembly" }));
    await waitFor(() => expect(count(`/api/v1/audit-requests/${AUDIT}`)).toBe(2));
    expect(await screen.findByText("version moved")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move to In Assembly" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.ifMatch).toBe("4");
  });

  it("reloads on a deadline-satisfy 409 and retries with the new deadline version", async () => {
    mountAudit();
    const satisfy = await screen.findByRole("button", { name: "Mark Records due satisfied" });
    failWrite = 409;
    fireEvent.click(satisfy);
    await waitFor(() => expect(count(`/api/v1/audit-requests/${AUDIT}`)).toBe(2));
    expect(await screen.findByText("version moved")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mark Records due satisfied" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map((c) => c.ifMatch)).toEqual(["2", "3"]);
  });

  it("keeps the request on screen with an inline error when a reload fails", async () => {
    mountAudit();
    await screen.findByText("CCN-100");
    failGet[`/api/v1/audit-requests/${AUDIT}`] = 500;
    fireEvent.click(screen.getByRole("button", { name: "Mark Records due satisfied" }));
    expect(await screen.findByText("read failed")).toBeTruthy();
    expect(screen.getByText("CCN-100")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("unlinks a claim with the request's version as If-Match and disables Unlink while in flight", async () => {
    mountAudit();
    const unlink = await screen.findByRole("button", { name: "Unlink claim CCN-100" });
    fireEvent.click(unlink);
    expect((unlink as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "DELETE",
      path: `/api/v1/audit-requests/${AUDIT}/claims/${CLAIM}`,
      ifMatch: "3",
    });
  });

  it("refreshes the case timeline after a change", async () => {
    mountAudit();
    await screen.findByText("CCN-100");
    expect(count(`/api/v1/claims/${CLAIM}/case-view`)).toBe(1);
    deadlineVersion = 3;
    fireEvent.click(screen.getByRole("button", { name: "Mark Records due satisfied" }));
    await waitFor(() => expect(count(`/api/v1/claims/${CLAIM}/case-view`)).toBe(2));
  });
});

describe("M25 case view panel resilience", () => {
  it("reads again when refreshKey changes, and offers Retry on a failed first load", async () => {
    failGet[`/api/v1/claims/${CLAIM}/case-view`] = 500;
    const { rerender } = mount(<CaseViewPanel claimId={CLAIM} refreshKey={1} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Case timeline")).toBeTruthy();
    rerender(wrap(<CaseViewPanel claimId={CLAIM} refreshKey={2} />));
    await waitFor(() => expect(count(`/api/v1/claims/${CLAIM}/case-view`)).toBe(3));
    expect(screen.getByText("Case timeline")).toBeTruthy();
  });

  it("formats a date-only string as that calendar day, never the previous one", () => {
    const expected = new Date(Date.UTC(2026, 1, 1)).toLocaleDateString(undefined, {
      timeZone: "UTC",
    });
    expect(formatDay("2026-02-01")).toBe(expected);
    expect(formatDay(null)).toBe("—");
  });
});
