// apps/web/src/modules/25-remittance — milestone 9a-1 denial playbooks (organization-authored guidance). Asserts on RECORDED
// FETCH CALLS like the other M25 write tests. The properties that matter: with no playbook the panel says "not written yet"
// and never invents advice; authoring controls appear only with the author key; a playbook always carries the "not legal
// advice" banner, its source and reviewer; a tick is one PUT bound to the version on screen and says it gates nothing; a
// source note is required (and the reason is wired to the disabled button); a 409 keeps the editor open with what was
// typed; a failed reload keeps the data and offers Retry; an older response never overwrites a newer one.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JSX } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { PlaybookLibrary } from "./playbook-library";
import { PlaybookPanel } from "./playbook-panel";

const DENIAL = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const DENIAL_2 = "aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb";
const PB = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const VER = "cccccccc-3333-4333-8333-cccccccccccc";
const VER_2 = "cccccccc-3333-4333-8333-dddddddddddd";

type Call = { method: string; path: string; body: Record<string, unknown>; ifMatch: string | null };
let calls: Call[] = [];
let denialStatus = 200;
let denialViews: Record<string, unknown> = {};
let denialGate: Promise<void>[] = [];
let denialFailAfter = Number.POSITIVE_INFINITY;
let denialGets = 0;
let listItems: Record<string, unknown>[] = [];
let detail: Record<string, unknown> = {};
let detailGets = 0;
let detailFailAfter = Number.POSITIVE_INFINITY;
let writeFailure: { status: number; code: string; message: string } | null = null;
let writeFailureOnce = false;

const emptyView = {
  denialCaseId: DENIAL,
  codeKind: "carc",
  code: "50",
  macName: null,
  playbook: null,
};
const withPlaybook = (status = "open", versionId = VER, versionNo = 2) => ({
  ...emptyView,
  playbook: {
    playbookId: PB,
    title: "Our CARC 50 playbook",
    codeKind: "carc",
    code: "50",
    macName: null,
    versionId,
    versionNo,
    summary: `Summary of version ${versionNo}.`,
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
const draftVersion = (rowVersion = 3) => ({
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
  rowVersion,
});
const detailOf = (versions: unknown[]) => ({
  id: PB,
  codeKind: "carc",
  code: "97",
  macName: null,
  title: "CARC 97",
  versions,
});
const listRow = {
  id: PB,
  codeKind: "carc",
  code: "97",
  macName: null,
  title: "CARC 97",
  publishedVersionNo: null,
  publishedAt: null,
  hasDraft: true,
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
    if (writeFailure) {
      const failure = writeFailure;
      if (writeFailureOnce) writeFailure = null;
      return json(failure.status, { error: { code: failure.code, message: failure.message } });
    }
    if (path.includes("/playbook-steps/")) return json(200, { stepKey: "first", status: "done" });
    if (path.endsWith("/publish"))
      return json(200, { id: VER, rowVersion: 4, effectiveFrom: "2026-03-05" });
    if (path.endsWith("/playbooks")) return json(201, { id: PB, versionId: VER });
    return json(200, { id: VER, rowVersion: 4 });
  }
  if (path.endsWith("/playbook")) {
    denialGets += 1;
    const gate = denialGate.shift();
    if (gate) await gate;
    if (denialStatus !== 200)
      return json(denialStatus, { error: { code: "X", message: "not for you" } });
    if (denialGets > denialFailAfter)
      return json(500, { error: { code: "X", message: "temporarily unavailable" } });
    const id = path.split("/").at(-2) ?? DENIAL;
    return json(200, denialViews[id] ?? denialViews.default);
  }
  if (path.endsWith("/playbooks")) return json(200, { items: listItems });
  detailGets += 1;
  if (detailGets > detailFailAfter)
    return json(500, { error: { code: "X", message: "detail unavailable" } });
  return json(200, detail);
}

const SESSION = (permissions: string[]) => ({
  userId: "u1",
  organizationId: "o1",
  membershipId: "m1",
  permissions,
});

function ui(node: JSX.Element, permissions: string[], route = "/") {
  return (
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION(permissions)}>
        <MemoryRouter initialEntries={[route]}>{node}</MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>
  );
}
const mount = (node: JSX.Element, permissions: string[], route = "/") =>
  render(ui(node, permissions, route));

beforeEach(() => {
  calls = [];
  denialStatus = 200;
  denialViews = { default: emptyView };
  denialGate = [];
  denialFailAfter = Number.POSITIVE_INFINITY;
  denialGets = 0;
  listItems = [];
  detail = {};
  detailGets = 0;
  detailFailAfter = Number.POSITIVE_INFINITY;
  writeFailure = null;
  writeFailureOnce = false;
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
    denialViews = {
      default: { ...emptyView, codeKind: "mac_reason", code: "56900", macName: "CGS" },
    };
    mount(<PlaybookPanel denialId={DENIAL} />, ["playbook.read", "playbook.author"]);
    const link = await screen.findByRole("link", { name: "Write one" });
    expect(link.getAttribute("href")).toBe(
      "/remittance/playbooks?new=1&kind=mac_reason&code=56900&mac=CGS",
    );
  });

  it("shows the banner, source, reviewer ids and version of the playbook in force", async () => {
    denialViews = { default: withPlaybook() };
    mount(<PlaybookPanel denialId={DENIAL} />, ["playbook.read"]);
    expect(
      await screen.findByText(/It is not legal advice and it is not a CMS or MAC requirement/),
    ).toBeTruthy();
    expect(screen.getByText("Billing lead memo, March")).toBeTruthy();
    expect(screen.getByText("Reviewed by (member ID)")).toBeTruthy();
    expect(screen.getByText("reviewer-membership")).toBeTruthy();
    expect(screen.getByText("Version 2, published 2026-03-04")).toBeTruthy();
    expect(screen.getByText("Summary of version 2.")).toBeTruthy();
    expect(
      screen.getByRole("list", { name: "Playbook steps" }).querySelectorAll("li"),
    ).toHaveLength(2);
    expect(screen.getByText(/do not change this denial or block any action/i)).toBeTruthy();
  });

  it("shows step status as text with the reason, not a control, to someone who cannot mark steps", async () => {
    denialViews = { default: withPlaybook("done") };
    mount(<PlaybookPanel denialId={DENIAL} />, ["playbook.read"]);
    expect(await screen.findByText("(Done)")).toBeTruthy();
    expect(screen.queryByLabelText("Status of step: Pull the certification")).toBeNull();
    expect(screen.getByText(/You do not have permission to mark steps/)).toBeTruthy();
  });

  it("ticks a step with one PUT bound to the version on screen", async () => {
    const user = userEvent.setup();
    denialViews = { default: withPlaybook() };
    mount(<PlaybookPanel denialId={DENIAL} />, ["playbook.read", "playbook.step.mark"]);
    await user.selectOptions(
      await screen.findByLabelText("Status of step: Pull the certification"),
      "done",
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "PUT",
      path: `/api/v1/denials/${DENIAL}/playbook-steps/first`,
      body: { status: "done", versionId: VER },
    });
  });

  it("on a 409 (the version changed) shows the message and reloads to what is now in force", async () => {
    const user = userEvent.setup();
    denialViews = { default: withPlaybook("open", VER, 2) };
    mount(<PlaybookPanel denialId={DENIAL} />, ["playbook.read", "playbook.step.mark"]);
    const select = await screen.findByLabelText("Status of step: Pull the certification");
    denialViews = { default: withPlaybook("open", VER_2, 3) };
    writeFailure = {
      status: 409,
      code: "PLAYBOOK_VERSION_CHANGED",
      message: "the playbook for this denial changed",
    };
    await user.selectOptions(select, "done");
    expect(await screen.findByText(/the playbook for this denial changed/)).toBeTruthy();
    expect(await screen.findByText("Summary of version 3.")).toBeTruthy();
  });

  it("shows the server's refusal when a tick fails, and keeps the steps", async () => {
    const user = userEvent.setup();
    denialViews = { default: withPlaybook() };
    mount(<PlaybookPanel denialId={DENIAL} />, ["playbook.read", "playbook.step.mark"]);
    const select = await screen.findByLabelText("Status of step: Call the MAC");
    writeFailure = { status: 404, code: "NOT_FOUND", message: "playbook step not found" };
    await user.selectOptions(select, "not_applicable");
    expect(await screen.findByText(/playbook step not found/)).toBeTruthy();
    expect(screen.getByRole("list", { name: "Playbook steps" })).toBeTruthy();
  });

  it("keeps the playbook on screen and offers Retry when a reload fails", async () => {
    const user = userEvent.setup();
    denialViews = { default: withPlaybook() };
    denialFailAfter = 1;
    mount(<PlaybookPanel denialId={DENIAL} />, ["playbook.read", "playbook.step.mark"]);
    await user.selectOptions(await screen.findByLabelText("Status of step: Call the MAC"), "done");
    expect(await screen.findByText("temporarily unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByText("Summary of version 2.")).toBeTruthy();
    denialFailAfter = Number.POSITIVE_INFINITY;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText("temporarily unavailable")).toBeNull());
  });

  it("never lets an older response overwrite a newer one", async () => {
    let releaseFirst: () => void = () => {};
    denialGate = [
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
    ];
    denialViews = { default: withPlaybook("open", VER, 2) };
    const view = (token: number) =>
      ui(<PlaybookPanel denialId={DENIAL} refreshToken={token} />, ["playbook.read"]);
    const { rerender } = render(view(0));
    // The first request is held; a refresh starts a second one that is answered with the newer version.
    await waitFor(() => expect(denialGets).toBe(1));
    denialViews = { default: withPlaybook("open", VER_2, 3) };
    rerender(view(1));
    expect(await screen.findByText("Summary of version 3.")).toBeTruthy();
    releaseFirst();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText("Summary of version 3.")).toBeTruthy();
    expect(screen.queryByText("Summary of version 2.")).toBeNull();
  });

  it("remounts for another denial when the parent keys it by denial id", async () => {
    denialViews = {
      [DENIAL]: withPlaybook("open", VER, 2),
      [DENIAL_2]: { ...emptyView, denialCaseId: DENIAL_2, code: "97" },
      default: emptyView,
    };
    const view = (id: string) => ui(<PlaybookPanel key={id} denialId={id} />, ["playbook.read"]);
    const { rerender } = render(view(DENIAL));
    expect(await screen.findByText("Summary of version 2.")).toBeTruthy();
    rerender(view(DENIAL_2));
    expect(await screen.findByText(/No playbook for CARC 97 yet/)).toBeTruthy();
    expect(screen.queryByText("Summary of version 2.")).toBeNull();
  });

  it("renders nothing for a user the server refuses (403)", async () => {
    denialStatus = 403;
    mount(<PlaybookPanel denialId={DENIAL} />, []);
    await waitFor(() => expect(screen.queryByText("Loading playbook…")).toBeNull());
    expect(screen.queryByRole("region", { name: "Denial playbook" })).toBeNull();
  });
});

describe("M25 playbook library", () => {
  it("says the organization has not written any playbook and offers no editor without the author key", async () => {
    mount(<PlaybookLibrary />, ["playbook.read"]);
    expect(await screen.findByText("No playbooks yet")).toBeTruthy();
    expect(screen.getByText(/Your organization has not written any/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Write a playbook" })).toBeNull();
    expect(screen.getByText(/Nothing is provided by ChartWarden/)).toBeTruthy();
  });

  it("offers the editor to an author", async () => {
    mount(<PlaybookLibrary />, ["playbook.read", "playbook.author"]);
    expect(
      (await screen.findAllByRole("button", { name: "Write a playbook" })).length,
    ).toBeGreaterThan(0);
  });

  it("opens the pre-filled editor from a link even when the session arrives with the author key", async () => {
    mount(<PlaybookLibrary />, ["playbook.read", "playbook.author"], "/?new=1&kind=carc&code=97");
    expect(await screen.findByRole("dialog", { name: "Write a playbook" })).toBeTruthy();
    expect((screen.getByLabelText("Code") as HTMLInputElement).value).toBe("97");
  });

  it("requires a source note (the reason is wired to the disabled button), then posts the playbook", async () => {
    const user = userEvent.setup();
    mount(<PlaybookLibrary />, ["playbook.read", "playbook.author"], "/?new=1&kind=carc&code=97");
    await user.type(await screen.findByLabelText("Title"), "CARC 97");
    await user.type(screen.getByLabelText("Summary"), "A short summary");
    await user.type(screen.getByLabelText("Step 1"), "Do the first thing");
    const save = screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const reasonId = save.getAttribute("aria-describedby") as string;
    expect(document.getElementById(reasonId)?.textContent).toMatch(/a source note is required/i);
    await user.type(
      screen.getByLabelText(/Source of this guidance/),
      "My own review of the denial letters",
    );
    expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    await user.click(screen.getByRole("button", { name: "Save draft" }));
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

  it("submits the editor with Enter (it is a real form)", async () => {
    const user = userEvent.setup();
    mount(<PlaybookLibrary />, ["playbook.read", "playbook.author"], "/?new=1&kind=carc&code=97");
    await user.type(await screen.findByLabelText("Title"), "CARC 97");
    await user.type(screen.getByLabelText("Summary"), "S");
    await user.type(screen.getByLabelText(/Source of this guidance/), "src");
    await user.type(screen.getByLabelText("Step 1"), "Do it{Enter}");
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.path).toBe("/api/v1/playbooks");
  });

  it("keeps the editor open with what was typed when a create is refused", async () => {
    const user = userEvent.setup();
    writeFailure = {
      status: 409,
      code: "PLAYBOOK_EXISTS",
      message: "a playbook for that code already exists",
    };
    mount(<PlaybookLibrary />, ["playbook.read", "playbook.author"], "/?new=1&kind=carc&code=97");
    await user.type(await screen.findByLabelText("Title"), "CARC 97");
    await user.type(screen.getByLabelText("Summary"), "My summary");
    await user.type(screen.getByLabelText(/Source of this guidance/), "src");
    await user.type(screen.getByLabelText("Step 1"), "Do it");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    const dialog = await screen.findByRole("dialog", { name: "Write a playbook" });
    expect(await within(dialog).findByText(/already exists/)).toBeTruthy();
    expect((within(dialog).getByLabelText("Summary") as HTMLTextAreaElement).value).toBe(
      "My summary",
    );
  });
});

describe("M25 playbook work rail", () => {
  const open = async (permissions: string[]) => {
    listItems = [listRow];
    detail = detailOf([draftVersion()]);
    mount(<PlaybookLibrary />, permissions);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Open playbook CARC 97" }));
    return user;
  };

  it("offers Edit only to an author, and Publish only to a publisher", async () => {
    await open(["playbook.read", "playbook.author"]);
    expect(await screen.findByText("Draft summary")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit draft" })).toBeTruthy();
  });

  it("sends If-Match on publish and shows the server's refusal of the author", async () => {
    const user = await open(["playbook.read", "playbook.publish"]);
    writeFailure = {
      status: 409,
      code: "PLAYBOOK_REVIEWER_IS_AUTHOR",
      message: "someone other than the author must review and publish this playbook",
    };
    await user.click(await screen.findByRole("button", { name: "Publish" }));
    expect(await screen.findByText(/someone other than the author must review/)).toBeTruthy();
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/playbook-versions/${VER}/publish`,
      ifMatch: "3",
    });
  });

  it("keeps the editor open with what was typed on a 409, shows the message inside it, and saves with the rebased version", async () => {
    const user = await open(["playbook.read", "playbook.author"]);
    await user.click(await screen.findByRole("button", { name: "Edit draft" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit draft" });
    const summary = within(dialog).getByLabelText("Summary") as HTMLTextAreaElement;
    await user.clear(summary);
    await user.type(summary, "My newer wording");
    // Someone else saved first: the next read carries row version 4.
    detail = detailOf([{ ...draftVersion(4), summary: "Someone else's wording" }]);
    writeFailure = { status: 409, code: "VERSION_CONFLICT", message: "modified by another writer" };
    writeFailureOnce = true;
    await user.click(within(dialog).getByRole("button", { name: "Save draft" }));
    expect(await within(dialog).findByText(/modified by another writer/)).toBeTruthy();
    expect((within(dialog).getByLabelText("Summary") as HTMLTextAreaElement).value).toBe(
      "My newer wording",
    );
    await waitFor(() => expect(detailGets).toBeGreaterThan(1)); // reloaded in the background
    await user.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2));
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.ifMatch)).toEqual(["3", "4"]);
  });

  it("keeps the detail on screen with a Retry above it when a reload fails", async () => {
    const user = await open(["playbook.read", "playbook.publish"]);
    await screen.findByText("Draft summary");
    detailFailAfter = detailGets; // every later read fails
    writeFailure = { status: 409, code: "PLAYBOOK_REVIEWER_IS_AUTHOR", message: "refused" };
    await user.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByText("detail unavailable")).toBeTruthy();
    expect(screen.getByText("Draft summary")).toBeTruthy();
    detailFailAfter = Number.POSITIVE_INFINITY;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText("detail unavailable")).toBeNull());
  });

  it("does not nest the editor inside the rail", async () => {
    const user = await open(["playbook.read", "playbook.author"]);
    await user.click(await screen.findByRole("button", { name: "Edit draft" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit draft" });
    expect(dialog.closest("aside")).toBeNull();
  });
});
