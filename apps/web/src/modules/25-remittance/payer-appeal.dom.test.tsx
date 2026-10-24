// apps/web/src/modules/25-remittance — milestone 12a-1 payer appeal UI. The panel and the path screen invent nothing: a
// payer with no recorded path reads "No appeal path recorded", a level with no due date says so, a deadline from an
// unverified path is badged, a Medicare denial shows no payer section, a draft path cannot be verified by its author, and
// a path cannot be saved without its source. The denial-keyed case view reads the denial route.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { CaseViewPanel } from "./case-view-panel";
import { PayerAppealPaths } from "./payer-appeal-paths";
import { PayerAppealPanel } from "./payer-appeal-panel";

const DENIAL = "dddddddd-4444-4444-8444-dddddddddddd";
const ME = "mmmmmmmm-4444-4444-8444-mmmmmmmmmmmm";
const OTHER = "oooooooo-4444-4444-8444-oooooooooooo";

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
  version: 1,
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
  path: null,
  pathPrompt: "No appeal path recorded for this payer - add it from your contract or the payer's denial notice",
  cases: [],
  ...over,
});

let payerView: Record<string, unknown>;
let paths: Record<string, unknown>;
let calls: string[] = [];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const path = new URL(req ? req.url : String(input), "http://localhost").pathname;
  calls.push(`${(init?.method ?? req?.method ?? "GET").toUpperCase()} ${path}`);
  if (path === `/api/v1/denials/${DENIAL}/payer-appeals`) return json(200, payerView);
  if (path === `/api/v1/denials/${DENIAL}/case-view`) {
    return json(200, {
      denialCaseId: DENIAL,
      claimId: null,
      patientId: null,
      generatedAt: "2026-02-02T00:00:00.000Z",
      nextDeadline: null,
      items: [],
      truncated: false,
    });
  }
  if (path === "/api/v1/payer-appeal-paths") return json(200, paths);
  return json(404, {});
}

function mount(element: JSX.Element, permissions: string[] = []): void {
  render(
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
          <MemoryRouter>{element}</MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

beforeEach(() => {
  calls = [];
  payerView = denialView();
  paths = { items: [] };
});
afterEach(() => cleanup());

describe("PayerAppealPanel", () => {
  it("with no recorded path shows the absence prompt and a link to add one (for a path manager)", async () => {
    mount(
      <PayerAppealPanel denialId={DENIAL} canManage canManagePaths />,
    );
    expect(await screen.findByText(/No appeal path recorded for this payer/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add a path" }).getAttribute("href")).toBe(
      "/remittance/payer-appeal-paths",
    );
  });

  it("does not offer the link without the path-manage key", async () => {
    mount(<PayerAppealPanel denialId={DENIAL} canManage canManagePaths={false} />);
    await screen.findByText(/No appeal path recorded for this payer/);
    expect(screen.queryByRole("link", { name: "Add a path" })).toBeNull();
  });

  it("a level with no due date says so, and nothing is defaulted", async () => {
    payerView = denialView({ cases: [caseRow()] });
    mount(<PayerAppealPanel denialId={DENIAL} canManage canManagePaths={false} />);
    expect(await screen.findByText("No due date - enter it from the notice")).toBeTruthy();
    expect(screen.queryByText(/Filing deadline/)).toBeNull();
  });

  it("badges a computed deadline whose path was not verified", async () => {
    payerView = denialView({
      cases: [
        caseRow({
          deadlineAt: "2026-03-13T03:59:59.999Z",
          deadlineSource: "path_rule",
          deadlineState: "computed",
          windowVerified: false,
          prompt: null,
          derivation: { presumedReceiptOn: null, calendarLastDay: "2026-03-12", lastFilingDay: "2026-03-12" },
        }),
      ],
    });
    mount(<PayerAppealPanel denialId={DENIAL} canManage canManagePaths={false} />);
    expect(await screen.findByText("Window not verified")).toBeTruthy();
    expect(screen.getByText(/computed from your path/)).toBeTruthy();
  });

  it("renders nothing for a Medicare denial (it takes the Medicare tiers)", async () => {
    payerView = denialView({ refusal: "MEDICARE_PAYER", pathPrompt: null });
    mount(<PayerAppealPanel denialId={DENIAL} canManage canManagePaths />);
    await waitFor(() => expect(calls).toContain(`GET /api/v1/denials/${DENIAL}/payer-appeals`));
    expect(screen.queryByText("Payer appeal")).toBeNull();
  });

  it("shows the Medicare Advantage hint, worded as not legal advice", async () => {
    payerView = denialView({ maHint: true, payerKind: "medicare_advantage" });
    mount(<PayerAppealPanel denialId={DENIAL} canManage canManagePaths={false} />);
    expect(await screen.findByText(/paid by Original Medicare through the MAC/)).toBeTruthy();
    expect(screen.getByText(/not legal advice/)).toBeTruthy();
  });

  it("asks the person to name the level when there is no path, and keeps Open disabled until they do", async () => {
    mount(<PayerAppealPanel denialId={DENIAL} canManage canManagePaths={false} />);
    const open = await screen.findByRole("button", { name: "Open level" });
    expect((open as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Level \(as the payer's notice names it\)/), {
      target: { value: "Appeal" },
    });
    expect((open as HTMLButtonElement).disabled).toBe(false);
  });

  it("hides every write control without the manage key", async () => {
    payerView = denialView({ cases: [caseRow()] });
    mount(<PayerAppealPanel denialId={DENIAL} canManage={false} canManagePaths={false} />);
    await screen.findByText("No due date - enter it from the notice");
    expect(screen.queryByRole("button", { name: "Record as submitted" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open level" })).toBeNull();
  });
});

describe("CaseViewPanel keyed on a denial", () => {
  it("reads the denial case view when the denial has no claim", async () => {
    mount(<CaseViewPanel denialId={DENIAL} />);
    expect(await screen.findByText("Case timeline")).toBeTruthy();
    expect(calls).toEqual([`GET /api/v1/denials/${DENIAL}/case-view`]);
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

describe("PayerAppealPaths", () => {
  it("with no paths says none are recorded and nothing is built in", async () => {
    mount(<PayerAppealPaths />, ["payer_appeal_path.read", "payer_appeal_path.manage"]);
    expect(await screen.findByText(/No appeal path recorded - add it from your contract/)).toBeTruthy();
    expect(screen.getByText(/Nothing is built in/)).toBeTruthy();
  });

  it("lets a second person verify a draft, but not its author", async () => {
    paths = { items: [pathRow()] };
    mount(<PayerAppealPaths />, ["payer_appeal_path.read", "payer_appeal_path.verify"]);
    expect(await screen.findByRole("button", { name: "Verify and activate" })).toBeTruthy();
    expect(screen.getByText(/no filing window recorded/)).toBeTruthy();
    cleanup();
    paths = { items: [pathRow({ authoredByMembershipId: ME })] };
    mount(<PayerAppealPaths />, ["payer_appeal_path.read", "payer_appeal_path.verify"]);
    expect(await screen.findByText(/You wrote this path; a second person must verify it/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Verify and activate" })).toBeNull();
  });

  it("will not save a path without its source note", async () => {
    mount(<PayerAppealPaths />, ["payer_appeal_path.read", "payer_appeal_path.manage"]);
    fireEvent.click((await screen.findAllByRole("button", { name: "Write a path" }))[0] as HTMLElement);
    const save = await screen.findByRole("button", { name: "Save draft path" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Choose the payer.")).toBeTruthy();
  });
});
