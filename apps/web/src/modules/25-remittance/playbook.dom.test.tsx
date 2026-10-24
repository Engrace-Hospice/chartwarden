// apps/web/src/modules/25-remittance — milestone 9a-1 denial playbooks (organization-authored guidance). Asserts on RECORDED
// FETCH CALLS like the other M25 write tests. The properties that matter: with no playbook the panel says "not written yet"
// and never invents advice; authoring controls appear only with the author key; a playbook always carries the "not legal
// advice" banner, its source and reviewer; a tick is one PUT and says it gates nothing; a source note is required; an empty
// library says the organization has not written any; the author's publish is refused with the server's message.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { PlaybookLibrary } from "./playbook-library";
import { PlaybookPanel } from "./playbook-panel";

const DENIAL = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PB = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const VER = "cccccccc-3333-4333-8333-cccccccccccc";

type Call = { method: string; path: string; body: Record<string, unknown>; ifMatch: string | null };
let calls: Call[] = [];
let denialStatus = 200;
let denialView: Record<string, unknown> = {};
let listItems: Record<string, unknown>[] = [];
let detail: Record<string, unknown> = {};
let postFailure: { status: number; code: string; message: string } | null = null;

const emptyView = {
  denialCaseId: DENIAL,
  codeKind: "carc",
  code: "50",
  macName: null,
  playbook: null,
};
const withPlaybook = (status = "open") => ({
  ...emptyView,
  playbook: {
    playbookId: PB,
    title: "Our CARC 50 playbook",
    codeKind: "carc",
    code: "50",
    macName: null,
    versionId: VER,
    versionNo: 2,
    summary: "Summary written by the organization.",
    sourceNote: "Billing lead memo, March",
    sourceDocumentId: null,
    authoredByMembershipId: "author-membership",
    reviewedByMembershipId: "reviewer-membership",
    publishedAt: "2026-03-04T10:00:00.000Z",
    effectiveFrom: "2026-03-04",
    steps: [
      {
        key: "first",
        text: "Pull the certification",
        status,
        markedAt: null,
        markedByMembershipId: null,
      },
      {
        key: "second",
        text: "Call the MAC",
        status: "open",
        markedAt: null,
        markedByMembershipId: null,
      },
    ],
  },
});
const draftVersion = {
  id: VER,
  versionNo: 1,
  status: "draft",
  summary: "Draft summary",
  steps: [{ key: "a", text: "Step a" }],
  sourceNote: "Source",
  sourceDocumentId: null,
  authoredByMembershipId: "m1",
  reviewedByMembershipId: null,
  publishedAt: null,
  retiredAt: null,
  effectiveFrom: null,
  rowVersion: 3,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  const path = new URL(req ? req.url : String(input), "http://localhost").pathname;
  if (method !== "GET") {
    const raw = req ? await req.clone().text() : typeof init?.body === "string" ? init.body : "";
    const headers = req ? req.headers : new Headers(init?.headers);
    calls.push({
      method,
      path,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      ifMatch: headers.get("if-match"),
    });
    if (postFailure) {
      return json(postFailure.status, {
        error: { code: postFailure.code, message: postFailure.message },
      });
    }
    if (path.includes("/playbook-steps/")) return json(200, { stepKey: "first", status: "done" });
    if (path.endsWith("/publish"))
      return json(200, { id: VER, rowVersion: 4, effectiveFrom: "2026-03-05" });
    if (path.endsWith("/playbooks")) return json(201, { id: PB, versionId: VER });
    return json(200, { id: VER, rowVersion: 4 });
  }
  if (path.endsWith("/playbook")) {
    return denialStatus === 200
      ? json(200, denialView)
      : json(denialStatus, { error: { code: "X", message: "not for you" } });
  }
  if (path.endsWith("/playbooks")) return json(200, { items: listItems });
  return json(200, detail);
}

const SESSION = (permissions: string[]) => ({
  userId: "u1",
  organizationId: "o1",
  membershipId: "m1",
  permissions,
});

function mount(ui: JSX.Element, permissions: string[], route = "/"): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION(permissions)}>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

beforeEach(() => {
  calls = [];
  denialStatus = 200;
  denialView = emptyView;
  listItems = [];
  detail = {};
  postFailure = null;
});
afterEach(() => cleanup());

describe("M25 denial playbook panel", () => {
  it("says no playbook has been written and offers nothing to a reader without the author key", async () => {
    mount(<PlaybookPanel denialId={DENIAL} />, ["playbook.read"]);
    expect(
      await screen.findByText(
        "No playbook for CARC 50 yet. Your organization has not written one.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Write one" })).toBeNull();
    expect(screen.queryByText(/not legal advice/i)).toBeNull();
  });

  it("offers 'Write one' pre-filled with the denial's reason to an author", async () => {
    denialView = { ...emptyView, codeKind: "mac_reason", code: "56900", macName: "CGS" };
    mount(<PlaybookPanel denialId={DENIAL} />, ["playbook.read", "playbook.author"]);
    const link = await screen.findByRole("link", { name: "Write one" });
    expect(link.getAttribute("href")).toBe(
      "/remittance/playbooks?new=1&kind=mac_reason&code=56900&mac=CGS",
    );
  });

  it("shows the banner, source, reviewer and version of the playbook in force", async () => {
    denialView = withPlaybook();
    mount(<PlaybookPanel denialId={DENIAL} />, ["playbook.read"]);
    expect(
      await screen.findByText(/It is not legal advice and it is not a CMS or MAC requirement/),
    ).toBeTruthy();
    expect(screen.getByText("Billing lead memo, March")).toBeTruthy();
    expect(screen.getByText("reviewer-membership")).toBeTruthy();
    expect(screen.getByText("Version 2, published 2026-03-04")).toBeTruthy();
    expect(screen.getByText("Summary written by the organization.")).toBeTruthy();
    expect(
      screen.getByRole("list", { name: "Playbook steps" }).querySelectorAll("li"),
    ).toHaveLength(2);
    expect(screen.getByText(/do not change this denial or block any action/i)).toBeTruthy();
  });

  it("ticks a step with one PUT and nothing else", async () => {
    denialView = withPlaybook();
    mount(<PlaybookPanel denialId={DENIAL} />, ["playbook.read"]);
    const select = await screen.findByLabelText("Status of step: Pull the certification");
    fireEvent.change(select, { target: { value: "done" } });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "PUT",
      path: `/api/v1/denials/${DENIAL}/playbook-steps/first`,
      body: { status: "done" },
    });
  });

  it("shows the server's refusal when a tick fails, and keeps the steps", async () => {
    denialView = withPlaybook();
    mount(<PlaybookPanel denialId={DENIAL} />, ["playbook.read"]);
    postFailure = { status: 404, code: "NOT_FOUND", message: "playbook step not found" };
    fireEvent.change(await screen.findByLabelText("Status of step: Call the MAC"), {
      target: { value: "not_applicable" },
    });
    expect(await screen.findByText(/playbook step not found/)).toBeTruthy();
    expect(screen.getByRole("list", { name: "Playbook steps" })).toBeTruthy();
  });

  it("renders nothing for a user the server refuses (403)", async () => {
    denialStatus = 403;
    mount(<PlaybookPanel denialId={DENIAL} />, []);
    await waitFor(() => expect(screen.queryByText("Loading playbook…")).toBeNull());
    expect(screen.queryByRole("region", { name: "Denial playbook" })).toBeNull();
  });
});

describe("M25 playbook library", () => {
  it("says the organization has not written any playbook, and offers the editor only to an author", async () => {
    mount(<PlaybookLibrary />, ["playbook.read"]);
    expect(await screen.findByText("No playbooks yet")).toBeTruthy();
    expect(screen.getByText(/Your organization has not written any/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Write a playbook" })).toBeNull();
    expect(screen.getByText(/Nothing is provided by ChartWarden/)).toBeTruthy();
    cleanup();
    mount(<PlaybookLibrary />, ["playbook.read", "playbook.author"]);
    expect(
      (await screen.findAllByRole("button", { name: "Write a playbook" })).length,
    ).toBeGreaterThan(0);
  });

  it("requires a source note before a draft can be saved, then posts the playbook", async () => {
    mount(<PlaybookLibrary />, ["playbook.read", "playbook.author"], "/?new=1&kind=carc&code=97");
    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "CARC 97" } });
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "A short summary" } });
    fireEvent.change(screen.getByLabelText("Step 1"), { target: { value: "Do the first thing" } });
    const save = screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByText(/a source note is required/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Source of this guidance/), {
      target: { value: "My own review of the denial letters" },
    });
    expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/playbooks",
      body: {
        codeKind: "carc",
        code: "97",
        title: "CARC 97",
        summary: "A short summary",
        sourceNote: "My own review of the denial letters",
        steps: [{ key: "step-1", text: "Do the first thing" }],
      },
    });
  });

  it("offers Publish only to a publisher, sends If-Match, and shows the server's refusal of the author", async () => {
    listItems = [
      {
        id: PB,
        codeKind: "carc",
        code: "97",
        macName: null,
        title: "CARC 97",
        publishedVersionNo: null,
        publishedAt: null,
        hasDraft: true,
      },
    ];
    detail = {
      id: PB,
      codeKind: "carc",
      code: "97",
      macName: null,
      title: "CARC 97",
      versions: [draftVersion],
    };
    mount(<PlaybookLibrary />, ["playbook.read", "playbook.author"]);
    fireEvent.click(await screen.findByRole("button", { name: "Open playbook CARC 97" }));
    expect(await screen.findByText("Draft summary")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit draft" })).toBeTruthy();
    cleanup();

    mount(<PlaybookLibrary />, ["playbook.read", "playbook.publish"]);
    fireEvent.click(await screen.findByRole("button", { name: "Open playbook CARC 97" }));
    postFailure = {
      status: 409,
      code: "PLAYBOOK_REVIEWER_IS_AUTHOR",
      message: "someone other than the author must review and publish this playbook",
    };
    fireEvent.click(await screen.findByRole("button", { name: "Publish" }));
    expect(await screen.findByText(/someone other than the author must review/)).toBeTruthy();
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/playbook-versions/${VER}/publish`,
      ifMatch: "3",
    });
  });
});
