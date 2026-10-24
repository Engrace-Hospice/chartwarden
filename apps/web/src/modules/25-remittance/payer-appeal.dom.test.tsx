// apps/web/src/modules/25-remittance — milestone 12a-1 payer appeal UI. The panel and the path screen invent nothing: a
// payer with no recorded path reads "No appeal path recorded", a level with no due date says so, a draft path reads
// "awaiting verification", a Medicare denial shows no payer section, a draft path cannot be verified by its author, and a
// path cannot be saved without its source. Reads are race-safe (an older response never wins), a failed refresh keeps the
// last good data with a Retry, a conflict reloads and keeps what was typed, and a disabled submit says why.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { CaseViewPanel } from "./case-view-panel";
import { PayerAppealPanel } from "./payer-appeal-panel";
import { PayerAppealPaths } from "./payer-appeal-paths";

const DENIAL = "dddddddd-4444-4444-8444-dddddddddddd";
const DENIAL_B = "eeeeeeee-4444-4444-8444-eeeeeeeeeeee";
const ME = "mmmmmmmm-4444-4444-8444-mmmmmmmmmmmm";
const OTHER = "oooooooo-4444-4444-8444-oooooooooooo";
const NO_PATH =
  "No appeal path recorded for this payer - add it from your contract or the payer's denial notice";

const caseRow = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  denialCaseId: DENIAL,
  claimId: null,
  payerId: "p1",
  program: "commercial",
  pathId: null,
  pathRevision: null,
  levelOrdinal: null,
  levelKind: "internal",
  levelLabel: "Provider dispute",
  priorLevelCaseId: null,
  state: "draft",
  noticeDatedOn: null,
  deadlineAt: null,
  deadlineZone: null,
  deadlineSource: "none",
  deadlineState: "none",
  windowVerified: false,
  derivation: null,
  prompt: "No due date - enter it from the notice",
  pathAwaitingVerification: false,
  patientId: null,
  patientAttribution: "unattributed",
  payerReference: null,
  externalReviewerName: null,
  decisionOutcome: null,
  dispositionKind: null,
  dispositionNote: null,
  needsManualReview: false,
  decisionOverdue: false,
  submittedAt: null,
  decidedAt: null,
  closedAt: null,
  version: 3,
  deadlines: [],
  ...over,
});

const denialView = (over: Record<string, unknown> = {}) => ({
  denialCaseId: DENIAL,
  payerId: "p1",
  payerName: "Payer One",
  payerKind: "commercial",
  adviceKind: "commercial",
  refusal: null,
  maHint: false,
  payerUnresolved: false,
  patientId: null,
  patientAttribution: "unattributed",
  path: null,
  pathPrompt: NO_PATH,
  cases: [],
  ...over,
});

interface Req {
  readonly key: string;
  readonly ifMatch: string | null;
  readonly body: unknown;
}
type Handler = (req: Req) => Response | Promise<Response>;

let handlers: Record<string, Handler>;
let log: Req[];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const gets = (path: string): number => log.filter((r) => r.key === `GET ${path}`).length;

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const path = new URL(req ? req.url : String(input), "http://localhost").pathname;
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  const text = req && method !== "GET" ? await req.clone().text() : "";
  const entry: Req = {
    key: `${method} ${path}`,
    ifMatch: req?.headers.get("if-match") ?? null,
    body: text ? JSON.parse(text) : undefined,
  };
  log.push(entry);
  const handler = handlers[entry.key];
  return handler ? handler(entry) : json(404, {});
}

function Harness(props: {
  readonly element: (refresh: number, bump: () => void) => JSX.Element;
}): JSX.Element {
  const [refresh, setRefresh] = useState(0);
  return props.element(refresh, () => setRefresh((n) => n + 1));
}

function mount(element: JSX.Element, permissions: string[] = []) {
  const ui = (el: JSX.Element) => (
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider
        session={{
          userId: "u1",
          organizationId: "org-1",
          membershipId: ME,
          roles: ["billing_specialist"],
          permissions,
          isAdmin: false,
        }}
      >
        <ToastProvider>
          <MemoryRouter>{el}</MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>
  );
  const view = render(ui(element));
  return { ...view, rerenderWith: (el: JSX.Element) => view.rerender(ui(el)) };
}

const panelAt = (denialId = DENIAL, over: Record<string, unknown> = {}) => (
  <PayerAppealPanel denialId={denialId} canManage canManagePaths={false} {...over} />
);
const viewPath = (id = DENIAL) => `/api/v1/denials/${id}/payer-appeals`;

beforeEach(() => {
  log = [];
  handlers = { [`GET ${viewPath()}`]: () => json(200, denialView()) };
});
afterEach(() => cleanup());

describe("PayerAppealPanel reads", () => {
  it("with no recorded path shows the absence prompt and a link to add one (for a path manager)", async () => {
    mount(panelAt(DENIAL, { canManagePaths: true }));
    expect(await screen.findByText(/No appeal path recorded for this payer/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add a path" }).getAttribute("href")).toBe(
      "/remittance/payer-appeal-paths",
    );
  });

  it("does not offer the link without the path-manage key", async () => {
    mount(panelAt());
    await screen.findByText(/No appeal path recorded for this payer/);
    expect(screen.queryByRole("link", { name: "Add a path" })).toBeNull();
  });

  it("a level with no due date says so, and nothing is defaulted", async () => {
    handlers[`GET ${viewPath()}`] = () => json(200, denialView({ cases: [caseRow()] }));
    mount(panelAt());
    expect(await screen.findByText("No due date - enter it from the notice")).toBeTruthy();
    expect(screen.queryByText(/Filing deadline/)).toBeNull();
  });

  it("badges a computed deadline whose window is not verified", async () => {
    handlers[`GET ${viewPath()}`] = () =>
      json(
        200,
        denialView({
          cases: [
            caseRow({
              deadlineAt: "2026-03-13T03:59:59.999Z",
              deadlineSource: "path_rule",
              deadlineState: "computed",
              windowVerified: false,
              prompt: null,
              derivation: {
                presumedReceiptOn: null,
                calendarLastDay: "2026-03-12",
                lastFilingDay: "2026-03-12",
              },
            }),
          ],
        }),
      );
    mount(panelAt());
    expect(await screen.findByText("Window not verified")).toBeTruthy();
    expect(screen.getByText(/computed from your path/)).toBeTruthy();
  });

  it("reads a draft path as awaiting verification and computes nothing from it", async () => {
    const awaiting =
      "Appeal path awaiting verification - no due date is computed from it; enter the date from the notice, or ask a second person to verify the path";
    handlers[`GET ${viewPath()}`] = () =>
      json(
        200,
        denialView({
          pathPrompt: awaiting,
          path: {
            id: "pp1",
            status: "draft",
            verified: false,
            revision: 1,
            program: "commercial",
            levels: [
              {
                ordinal: 1,
                levelKind: "internal",
                levelLabel: "First level",
                whoFiles: "provider",
                windowComplete: true,
              },
            ],
          },
          cases: [caseRow({ pathAwaitingVerification: true, prompt: awaiting })],
        }),
      );
    mount(panelAt());
    expect((await screen.findAllByText(/awaiting verification/)).length).toBeGreaterThan(0);
    expect(screen.getByText("Draft - not verified")).toBeTruthy();
    expect(screen.queryByText(/Filing deadline/)).toBeNull();
  });

  it("renders nothing for a Medicare denial once the read has finished", async () => {
    handlers[`GET ${viewPath()}`] = () =>
      json(200, denialView({ refusal: "MEDICARE_PAYER", pathPrompt: null }));
    const { container } = mount(panelAt());
    await waitFor(() => expect(gets(viewPath())).toBe(1));
    await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
    expect(screen.queryByText("Payer appeal")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("shows the Medicare Advantage hint, worded as not legal advice", async () => {
    handlers[`GET ${viewPath()}`] = () =>
      json(200, denialView({ maHint: true, payerKind: "medicare_advantage" }));
    mount(panelAt());
    expect(await screen.findByText(/paid by Original Medicare through the MAC/)).toBeTruthy();
    expect(screen.getByText(/not legal advice/)).toBeTruthy();
  });

  it("shows a payer that could not be resolved, with no path prompt to act on and no open form", async () => {
    handlers[`GET ${viewPath()}`] = () =>
      json(
        200,
        denialView({
          payerUnresolved: true,
          payerName: null,
          payerKind: null,
          pathPrompt:
            "Payer not resolved from the payer directory - the appeal path cannot be looked up",
        }),
      );
    mount(panelAt(DENIAL, { canManagePaths: true }));
    expect(await screen.findByText(/Payer not resolved from the payer directory/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Add a path" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open level" })).toBeNull();
  });

  it("hides every write control without the manage key", async () => {
    handlers[`GET ${viewPath()}`] = () => json(200, denialView({ cases: [caseRow()] }));
    mount(panelAt(DENIAL, { canManage: false }));
    await screen.findByText("No due date - enter it from the notice");
    expect(screen.queryByRole("button", { name: "Record as submitted" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open level" })).toBeNull();
  });
});

describe("PayerAppealPanel failures and races", () => {
  it("an initial load failure shows a Retry that reads again", async () => {
    let ok = false;
    handlers[`GET ${viewPath()}`] = () => (ok ? json(200, denialView()) : json(500, {}));
    mount(panelAt());
    expect(await screen.findByText(/Payer appeals unavailable/)).toBeTruthy();
    ok = true;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Payer One")).toBeTruthy();
    expect(screen.queryByText(/unavailable/)).toBeNull();
  });

  it("a failed refresh keeps the last good data on screen with a Retry", async () => {
    let reads = 0;
    handlers[`GET ${viewPath()}`] = () =>
      ++reads === 2 ? json(500, {}) : json(200, denialView({ cases: [caseRow()] }));
    handlers["POST /api/v1/payer-appeals/c1/state"] = () => json(200, { id: "c1", version: 4 });
    mount(panelAt());
    await userEvent.click(await screen.findByRole("button", { name: "Record as submitted" }));
    expect(await screen.findByText(/Payer appeals could not be refreshed/)).toBeTruthy();
    expect(screen.getByText("Provider dispute")).toBeTruthy(); // the last good data stays
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText(/could not be refreshed/)).toBeNull());
    expect(screen.getByText("Provider dispute")).toBeTruthy();
  });

  it("an older response never replaces a newer one, and nothing carries over to another denial", async () => {
    let releaseA: (r: Response) => void = () => {};
    handlers[`GET ${viewPath(DENIAL)}`] = () =>
      new Promise<Response>((resolve) => {
        releaseA = resolve;
      });
    handlers[`GET ${viewPath(DENIAL_B)}`] = () =>
      json(200, denialView({ denialCaseId: DENIAL_B, payerName: "Payer Beta" }));
    const { rerenderWith } = mount(panelAt(DENIAL));
    rerenderWith(panelAt(DENIAL_B));
    expect(await screen.findByText("Payer Beta")).toBeTruthy();
    releaseA(json(200, denialView({ payerName: "Payer Alpha" })));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Payer Alpha")).toBeNull();
    expect(screen.getByText("Payer Beta")).toBeTruthy();
  });

  it("typed values do not carry over when the denial changes", async () => {
    handlers[`GET ${viewPath(DENIAL_B)}`] = () => json(200, denialView({ denialCaseId: DENIAL_B }));
    const { rerenderWith } = mount(panelAt(DENIAL));
    const input = await screen.findByLabelText(/Level \(as the payer's notice names it\)/);
    await userEvent.type(input, "Typed for A");
    rerenderWith(panelAt(DENIAL_B));
    const next = await screen.findByLabelText(/Level \(as the payer's notice names it\)/);
    expect((next as HTMLInputElement).value).toBe("");
  });
});

describe("PayerAppealPanel writes", () => {
  it("Open level is disabled with its reason until the level is named, then posts the typed body and shows the notice", async () => {
    let opened = false;
    handlers[`GET ${viewPath()}`] = () =>
      json(200, denialView(opened ? { cases: [caseRow({ id: "c9" })] } : {}));
    handlers[`POST ${viewPath()}`] = () => {
      opened = true;
      return json(201, { id: "c9", version: 1, deadlineSource: "none" });
    };
    mount(panelAt());
    const open = await screen.findByRole("button", { name: "Open level" });
    expect((open as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Name the level you are filing.")).toBeTruthy();
    await userEvent.type(
      screen.getByLabelText(/Level \(as the payer's notice names it\)/),
      "Appeal",
    );
    expect(screen.queryByText("Name the level you are filing.")).toBeNull();
    await userEvent.click(open);
    expect(await screen.findByText("Payer appeal level opened.")).toBeTruthy();
    const post = log.find((r) => r.key === `POST ${viewPath()}`);
    expect(post?.body).toEqual({ levelLabel: "Appeal", levelKind: "internal" });
    expect(gets(viewPath())).toBe(2); // the first read and exactly one re-read
  });

  it("a 409 reloads and keeps what was typed, with the server's message", async () => {
    handlers[`POST ${viewPath()}`] = () =>
      json(409, {
        error: { code: "PAYER_APPEAL_IN_FLIGHT", message: "a level is already in progress" },
      });
    mount(panelAt());
    const input = await screen.findByLabelText(/Level \(as the payer's notice names it\)/);
    await userEvent.type(input, "Keep me");
    await userEvent.click(screen.getByRole("button", { name: "Open level" }));
    expect(await screen.findByText("a level is already in progress")).toBeTruthy();
    expect(gets(viewPath())).toBe(2);
    expect(
      (screen.getByLabelText(/Level \(as the payer's notice names it\)/) as HTMLInputElement).value,
    ).toBe("Keep me");
  });

  it("recording as submitted sends If-Match with the case version and the move body, and re-reads once", async () => {
    handlers[`GET ${viewPath()}`] = () => json(200, denialView({ cases: [caseRow()] }));
    handlers["POST /api/v1/payer-appeals/c1/state"] = () => json(200, { id: "c1", version: 4 });
    mount(panelAt());
    await userEvent.click(await screen.findByRole("button", { name: "Record as submitted" }));
    await waitFor(() => expect(gets(viewPath())).toBe(2));
    const post = log.find((r) => r.key === "POST /api/v1/payer-appeals/c1/state");
    expect(post?.ifMatch).toBe("3");
    expect(post?.body).toEqual({ move: "submit" });
  });

  it("saving the notice date sends If-Match and the typed date, disabled with its reason until entered", async () => {
    handlers[`GET ${viewPath()}`] = () => json(200, denialView({ cases: [caseRow()] }));
    handlers["PUT /api/v1/payer-appeals/c1/notice"] = () =>
      json(200, { id: "c1", version: 4, deadlineSource: "none" });
    mount(panelAt());
    const save = await screen.findByRole("button", { name: "Save notice date" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Enter the date printed on the notice.")).toBeTruthy();
    await userEvent.type(
      screen.getByLabelText(/Notice date \(printed on the notice\)/),
      "2026-03-02",
    );
    await userEvent.click(save);
    await waitFor(() =>
      expect(log.some((r) => r.key === "PUT /api/v1/payer-appeals/c1/notice")).toBe(true),
    );
    const put = log.find((r) => r.key === "PUT /api/v1/payer-appeals/c1/notice");
    expect(put?.ifMatch).toBe("3");
    expect(put?.body).toEqual({ noticeDate: "2026-03-02" });
  });

  it("the decision form says why it is disabled, and resets when the case moves", async () => {
    let version = 3;
    handlers[`GET ${viewPath()}`] = () =>
      json(200, denialView({ cases: [caseRow({ state: "under_review", version, prompt: null })] }));
    handlers["POST /api/v1/payer-appeals/c1/state"] = () => {
      version = 4;
      return json(409, { error: { code: "VERSION_CONFLICT", message: "changed" } });
    };
    mount(panelAt());
    await userEvent.click(await screen.findByRole("button", { name: "Record decision" }));
    const form = screen.getByRole("form", { name: "Record the decision" });
    expect(
      (within(form).getByRole("button", { name: "Record decision" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(within(form).getByText("Choose the outcome.")).toBeTruthy();
    await userEvent.selectOptions(within(form).getByLabelText(/Outcome/), "unfavorable");
    await userEvent.click(within(form).getByRole("button", { name: "Record decision" }));
    // the conflict reloaded a newer version: the half-filled form was dropped
    await waitFor(() =>
      expect(screen.queryByRole("form", { name: "Record the decision" })).toBeNull(),
    );
    expect(log.find((r) => r.key === "POST /api/v1/payer-appeals/c1/state")?.body).toMatchObject({
      move: "decide",
      outcome: "unfavorable",
    });
  });

  it("does not re-read twice when the parent bumps its refresh key after this panel's own write", async () => {
    handlers[`GET ${viewPath()}`] = () => json(200, denialView({ cases: [caseRow()] }));
    handlers["POST /api/v1/payer-appeals/c1/state"] = () => json(200, { id: "c1", version: 4 });
    mount(
      <Harness
        element={(refresh, bump) => panelAt(DENIAL, { refreshKey: refresh, onChanged: bump })}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Record as submitted" }));
    await waitFor(() => expect(gets(viewPath())).toBe(2));
    await new Promise((r) => setTimeout(r, 30));
    expect(gets(viewPath())).toBe(2);
  });
});

describe("CaseViewPanel keyed on a denial", () => {
  it("reads the denial case view when the denial has no claim", async () => {
    handlers[`GET /api/v1/denials/${DENIAL}/case-view`] = () =>
      json(200, {
        denialCaseId: DENIAL,
        claimId: null,
        patientId: null,
        patientAttribution: "unattributed",
        generatedAt: "2026-02-02T00:00:00.000Z",
        nextDeadline: null,
        items: [],
        truncated: false,
      });
    mount(<CaseViewPanel denialId={DENIAL} />);
    expect(await screen.findByText("Case timeline")).toBeTruthy();
    expect(screen.getByText("Nothing has been recorded for this case yet.")).toBeTruthy();
    expect(log.map((r) => r.key)).toEqual([`GET /api/v1/denials/${DENIAL}/case-view`]);
  });
});

const pathRow = (over: Record<string, unknown> = {}) => ({
  id: "path1",
  payerId: "p1",
  payerName: "Payer One",
  program: "commercial",
  contractLabel: null,
  status: "draft",
  effectiveFrom: "2026-01-01",
  sourceNote: "contract p.4",
  sourceDocumentId: null,
  authoredByMembershipId: OTHER,
  verifiedOn: null,
  verifiedByMembershipId: null,
  supersedesPathId: null,
  revision: 1,
  version: 1,
  levels: [
    {
      id: "l1",
      ordinal: 1,
      levelKind: "internal",
      levelLabel: "First level",
      whoFiles: "provider",
      filingWindowDays: null,
      anchorKind: null,
      receiptPresumptionDays: null,
      dayBasis: null,
      roll: null,
      decisionDays: null,
      formLabel: null,
      channelNote: null,
      sourceNote: "contract p.4",
    },
  ],
  ...over,
});

const PATHS = "/api/v1/payer-appeal-paths";

describe("PayerAppealPaths", () => {
  it("with no paths says none are recorded and nothing is built in", async () => {
    handlers[`GET ${PATHS}`] = () => json(200, { items: [] });
    mount(<PayerAppealPaths />, ["payer_appeal_path.read", "payer_appeal_path.manage"]);
    expect(
      await screen.findByText(/No appeal path recorded - add it from your contract/),
    ).toBeTruthy();
    expect(screen.getByText(/Nothing is built in/)).toBeTruthy();
  });

  it("lets a second person verify a draft, but not its author", async () => {
    handlers[`GET ${PATHS}`] = () => json(200, { items: [pathRow()] });
    mount(<PayerAppealPaths />, ["payer_appeal_path.read", "payer_appeal_path.verify"]);
    expect(await screen.findByRole("button", { name: "Verify and activate" })).toBeTruthy();
    expect(screen.getByText(/no filing window recorded/)).toBeTruthy();
    cleanup();
    handlers[`GET ${PATHS}`] = () =>
      json(200, { items: [pathRow({ authoredByMembershipId: ME })] });
    mount(<PayerAppealPaths />, ["payer_appeal_path.read", "payer_appeal_path.verify"]);
    expect(
      await screen.findByText(/You wrote this path; a second person must verify it/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Verify and activate" })).toBeNull();
  });

  it("keeps the list on screen when a reload fails, with a Retry", async () => {
    let reads = 0;
    handlers[`GET ${PATHS}`] = () =>
      ++reads === 2 ? json(500, {}) : json(200, { items: [pathRow()] });
    handlers[`POST ${PATHS}/path1/verify`] = () => json(200, { id: "path1", version: 2 });
    mount(<PayerAppealPaths />, ["payer_appeal_path.read", "payer_appeal_path.verify"]);
    await userEvent.click(await screen.findByRole("button", { name: "Verify and activate" }));
    expect(await screen.findByText(/Payer appeal paths could not be refreshed/)).toBeTruthy();
    expect(screen.getByText(/Payer One/)).toBeTruthy();
    expect(log.find((r) => r.key === `POST ${PATHS}/path1/verify`)?.ifMatch).toBe("1");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText(/could not be refreshed/)).toBeNull());
  });

  it("shows an initial failure as unavailable with a Retry", async () => {
    handlers[`GET ${PATHS}`] = () => json(500, {});
    mount(<PayerAppealPaths />, ["payer_appeal_path.read"]);
    expect(await screen.findByText(/Payer appeal paths unavailable/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("keeps Verify disabled until the list has been read again, so an old version cannot be reused", async () => {
    let release: (r: Response) => void = () => {};
    let reads = 0;
    handlers[`GET ${PATHS}`] = () =>
      ++reads === 2
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : json(200, { items: [pathRow()] });
    handlers[`POST ${PATHS}/path1/verify`] = () => json(200, { id: "path1", version: 2 });
    mount(<PayerAppealPaths />, ["payer_appeal_path.read", "payer_appeal_path.verify"]);
    const verify = await screen.findByRole("button", { name: "Verify and activate" });
    await userEvent.click(verify);
    await waitFor(() => expect(reads).toBe(2));
    expect(
      (screen.getByRole("button", { name: "Verify and activate" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    release(
      json(200, { items: [pathRow({ status: "active", version: 2, verifiedOn: "2026-03-01" })] }),
    );
    expect(await screen.findByText("Verified")).toBeTruthy();
  });

  it("will not save a path without its source note, and shows 'Required.' only after the field was left", async () => {
    handlers[`GET ${PATHS}`] = () => json(200, { items: [] });
    mount(<PayerAppealPaths />, ["payer_appeal_path.read", "payer_appeal_path.manage"]);
    await userEvent.click(
      (await screen.findAllByRole("button", { name: "Write a path" }))[0] as HTMLElement,
    );
    const save = await screen.findByRole("button", { name: "Save draft path" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Choose the payer.")).toBeTruthy();
    expect(screen.queryByText("Required.")).toBeNull(); // a fresh form shows no error
    const note = screen.getByLabelText(/Where this path came from \(contract/);
    await userEvent.click(note);
    await userEvent.tab();
    expect((await screen.findAllByText("Required.")).length).toBeGreaterThan(0);
  });
});
