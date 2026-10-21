// apps/web/src/modules/25-remittance — typed text must survive the STEP_UP_REQUIRED round trip. The M25 write
// panels redirect to /step-up?returnTo=…; the reason / narrative / claim id the user had typed used to be lost
// on the way. The draft is stashed in sessionStorage (org+user+action+record scoped, short TTL), restored when
// the same panel reopens, cleared on success, and never offered to another user or org.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { AppealTracker } from "./appeal-tracker";
import { DenialWorklist } from "./denial-worklist";
import { RemittanceWorklist } from "./remittance-worklist";

const DENIAL = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const APPEAL = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const LINE = "cccccccc-3333-4333-8333-cccccccccccc";
const CLAIM = "dddddddd-4444-4444-8444-dddddddddddd";
const DOC = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
const LONG = "r".repeat(45);
const NARRATIVE = "n".repeat(100);

let refusal: { status: number; body: unknown } | null = null;
let writes = 0;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const denial = {
  id: DENIAL,
  providerEntityId: "11111111-1111-4111-8111-111111111111",
  claimId: CLAIM,
  carcCode: "CO-16",
  rarcCode: null,
  category: "denial",
  source: "835",
  state: "in_progress",
  assigneeMembershipId: null,
  openedAt: "2026-09-01T00:00:00.000Z",
  agingBucketDays: 3,
  agingBucketLabel: "0-7",
  dollarValue: "300.00",
  taxonomyStatus: "mapped",
  version: 7,
};
const appeal = {
  id: APPEAL,
  denialCaseId: DENIAL,
  claimId: CLAIM,
  tier: "redetermination",
  state: "draft",
  decisionOutcome: null,
  tierDeadlineAt: "2099-01-01T00:00:00.000Z",
  version: 3,
  appealPacketDocumentId: null,
  submittedAt: null,
  decidedAt: null,
  events: [],
};

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const url = req ? req.url : String(input);
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  const path = new URL(url, "http://localhost").pathname;
  if (method !== "GET") {
    writes += 1;
    if (refusal) return json(refusal.status, refusal.body);
    return json(200, { id: DENIAL, version: 8 });
  }
  if (path === "/api/v1/denials") return json(200, { items: [denial], nextCursor: null });
  if (path === `/api/v1/denials/${DENIAL}`) return json(200, denial);
  if (path === "/api/v1/appeals")
    return json(200, { items: [{ ...appeal, events: undefined }], nextCursor: null });
  if (path === `/api/v1/appeals/${APPEAL}`) return json(200, appeal);
  if (path === "/api/v1/remittance/unmatched")
    return json(200, {
      items: [
        {
          id: LINE,
          remittanceAdviceId: "99999999-9999-4999-8999-999999999999",
          claimId: null,
          clp02StatusCode: 1,
          clp03TotalChargeAmount: "500.00",
          clp04TotalPaymentAmount: "450.00",
          clp05PatientResponsibilityAmount: "50.00",
          matchState: "unmatched",
          receivedAt: "2026-09-02T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
  return json(200, { items: [], nextCursor: null });
}

const base = { membershipId: "m", roles: [], permissions: [], isAdmin: false };
const SESSION = { ...base, userId: "user-1", organizationId: "org-1" };

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{`${loc.pathname}${loc.search}`}</div>;
}

function mount(element: JSX.Element, session = SESSION) {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={session}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/work"]}>
            <Routes>
              <Route path="/work" element={element} />
              <Route path="*" element={<Where />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const last = (name: string) => screen.getAllByRole("button", { name }).pop() as HTMLElement;

interface Flow {
  readonly name: string;
  readonly element: () => JSX.Element;
  /** Open the panel, type the draft and press submit. */
  readonly fill: () => Promise<void>;
  /** Assert the typed values are back (the panel reopened by itself). */
  readonly restored: () => Promise<void>;
  /** Press submit on the restored panel. */
  readonly submit: () => void;
  readonly closed: () => Promise<void>;
  /** Dismiss the restored panel without submitting (Close panel / Cancel). */
  readonly dismiss: () => void;
}

const FLOWS: readonly Flow[] = [
  {
    name: "denial resolve (reason)",
    element: () => <DenialWorklist />,
    fill: async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Work denial CO-16" }));
      fireEvent.click(await screen.findByRole("button", { name: "Mark resolved" }));
      fireEvent.change(screen.getByLabelText("Reason"), { target: { value: LONG } });
      fireEvent.click(last("Mark resolved"));
    },
    restored: async () => {
      const box = (await screen.findByLabelText("Reason")) as HTMLTextAreaElement;
      expect(box.value).toBe(LONG);
    },
    submit: () => fireEvent.click(last("Mark resolved")),
    closed: async () => {
      await screen.findByRole("button", { name: "Work denial CO-16" });
      expect(screen.queryByLabelText("Reason")).toBeNull();
    },
    dismiss: () => fireEvent.click(screen.getByRole("button", { name: "Close panel" })),
  },
  {
    name: "appeal submit (narrative + document ids)",
    element: () => <AppealTracker />,
    fill: async () => {
      fireEvent.click(await screen.findByRole("button", { name: /Open appeal Redetermination/ }));
      fireEvent.click(await screen.findByRole("button", { name: "Submit appeal" }));
      fireEvent.change(screen.getByLabelText("Appeal narrative"), { target: { value: NARRATIVE } });
      fireEvent.change(screen.getByLabelText("Attached document IDs"), { target: { value: DOC } });
      fireEvent.click(last("Submit appeal"));
    },
    restored: async () => {
      const narrative = (await screen.findByLabelText("Appeal narrative")) as HTMLTextAreaElement;
      expect(narrative.value).toBe(NARRATIVE);
      expect((screen.getByLabelText("Attached document IDs") as HTMLTextAreaElement).value).toBe(
        DOC,
      );
    },
    submit: () => fireEvent.click(last("Submit appeal")),
    closed: async () => {
      await screen.findByRole("button", { name: /Open appeal Redetermination/ });
      expect(screen.queryByLabelText("Appeal narrative")).toBeNull();
    },
    dismiss: () => fireEvent.click(screen.getByRole("button", { name: "Close panel" })),
  },
  {
    name: "manual match (claim id + reason)",
    element: () => <RemittanceWorklist />,
    fill: async () => {
      fireEvent.click(await screen.findByRole("button", { name: /Match line/ }));
      fireEvent.change(await screen.findByLabelText("Claim ID"), { target: { value: CLAIM } });
      fireEvent.change(screen.getByLabelText("Match rationale"), { target: { value: LONG } });
      fireEvent.click(screen.getByRole("button", { name: "Match claim" }));
    },
    restored: async () => {
      expect(((await screen.findByLabelText("Claim ID")) as HTMLInputElement).value).toBe(CLAIM);
      expect((screen.getByLabelText("Match rationale") as HTMLTextAreaElement).value).toBe(LONG);
    },
    submit: () => fireEvent.click(screen.getByRole("button", { name: "Match claim" })),
    closed: async () => {
      await screen.findByRole("button", { name: /Match line/ });
      expect(screen.queryByLabelText("Claim ID")).toBeNull();
    },
    dismiss: () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })),
  },
];

const stepUp = () => {
  refusal = { status: 403, body: { error: { code: "STEP_UP_REQUIRED", message: "step up" } } };
};
const redirected = () =>
  waitFor(() => expect(screen.getByTestId("where").textContent).toContain("/step-up?returnTo="));

beforeEach(() => {
  refusal = null;
  writes = 0;
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe.each(FLOWS)("M25 step-up draft: $name", (flow) => {
  it("restores the typed text after the step-up round trip", async () => {
    stepUp();
    mount(flow.element());
    await flow.fill();
    await redirected();
    cleanup();

    mount(flow.element());
    await flow.restored();
  });

  it("clears the draft after a successful submit", async () => {
    stepUp();
    mount(flow.element());
    await flow.fill();
    await redirected();
    cleanup();

    refusal = null;
    mount(flow.element());
    await flow.restored();
    flow.submit();
    await waitFor(() => expect(writes).toBe(2));
    cleanup();

    mount(flow.element());
    await flow.closed();
  });

  it("discards the draft when the restored panel is dismissed without submitting", async () => {
    stepUp();
    mount(flow.element());
    await flow.fill();
    await redirected();
    cleanup();

    mount(flow.element());
    await flow.restored();
    flow.dismiss();
    cleanup();

    mount(flow.element());
    await flow.closed();
  });

  it("does not restore the draft for a different user or org", async () => {
    stepUp();
    mount(flow.element());
    await flow.fill();
    await redirected();
    cleanup();

    mount(flow.element(), { ...SESSION, userId: "user-2" });
    await flow.closed();
    cleanup();
    mount(flow.element(), { ...SESSION, organizationId: "org-2" });
    await flow.closed();
  });

  it("still redirects, and the form still works, when storage throws", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    stepUp();
    mount(flow.element());
    await flow.fill();
    await redirected();
  });
});
