import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — milestone 3 denial routing and MAC reopenings. Asserts on RECORDED FETCH CALLS
// (method, path, If-Match, body) like the other M25 write tests, so a control wired to a handler that never fires
// still fails. The server owns every rule and its refusal is shown verbatim; the filing form survives step-up.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { DenialDetailPanel } from "./denial-detail-panel";

const DENIAL = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const CLAIM = "dddddddd-4444-4444-8444-dddddddddddd";
const REOPENING = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const ME = "ffffffff-6666-4666-8666-ffffffffffff";

type Call = { method: string; path: string; ifMatch: string | null; body: Record<string, unknown> };
let calls: Call[] = [];
let refusal: { status: number; body: unknown } | null = null;
let route: "appeal" | "reopening" | "undetermined" = "reopening";
let unverified = true;
let reopeningState: string | null = null;
let dueAt: string | null = null;
let routeFails = false;
let listFails = false;
let gets: string[] = [];

const denialBody = () => ({
  id: DENIAL,
  providerEntityId: "11111111-1111-4111-8111-111111111111",
  claimId: CLAIM,
  carcCode: "50",
  rarcCode: null,
  category: "denial",
  source: "remittance_adjustment",
  state: "escalated",
  assigneeMembershipId: null,
  openedAt: "2026-09-01T00:00:00.000Z",
  agingBucketDays: 3,
  agingBucketLabel: "0-7",
  dollarValue: "300.00",
  taxonomyStatus: "mapped",
  version: 7,
});
const routeBody = () => ({
  route,
  unverified: route === "reopening" && unverified,
  rule:
    route === "undetermined"
      ? null
      : {
          id: "platform:56900",
          origin: "platform",
          macName: null,
          codeKind: "mac_reason",
          code: "56900",
          route,
          verifiedOn: null,
          sourceNote: "CGS: an ADR non-response (56900) is reopened with the MAC, not appealed",
        },
  macReasonCode: route === "reopening" ? "56900" : null,
  macName: "CGS",
});
const reopeningSummary = () => ({
  id: REOPENING,
  claimId: CLAIM,
  denialCaseId: DENIAL,
  adrCaseId: null,
  macName: "CGS",
  state: reopeningState ?? "draft",
  formName: reopeningState && reopeningState !== "draft" ? "CGS reopening request" : null,
  filingChannel: reopeningState && reopeningState !== "draft" ? "mac_portal" : null,
  filedAt: reopeningState && reopeningState !== "draft" ? "2026-09-10T12:00:00.000Z" : null,
  dueAt,
  outcome: reopeningState === "decided" ? "granted" : null,
  decidedAt: reopeningState === "decided" ? "2026-09-20T12:00:00.000Z" : null,
  version: 4,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const url = req ? req.url : String(input);
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  const path = new URL(url, "http://localhost").pathname;
  if (method !== "GET") {
    const raw = req ? await req.clone().text() : typeof init?.body === "string" ? init.body : "";
    calls.push({
      method,
      path,
      ifMatch: req?.headers.get("if-match") ?? null,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    });
    if (refusal) return json(refusal.status, refusal.body);
    return json(200, { id: REOPENING, version: 5 });
  }
  gets.push(path);
  if (path === `/api/v1/denials/${DENIAL}`) return json(200, denialBody());
  if (path === `/api/v1/denials/${DENIAL}/route`)
    return routeFails
      ? json(500, { error: { code: "INTERNAL", message: "route read failed" } })
      : json(200, routeBody());
  if (path === "/api/v1/reopenings")
    return listFails
      ? json(500, { error: { code: "INTERNAL", message: "list read failed" } })
      : json(200, { items: reopeningState ? [reopeningSummary()] : [] });
  if (path === `/api/v1/reopenings/${REOPENING}`)
    return json(200, {
      ...reopeningSummary(),
      filingConfirmationRef: reopeningState && reopeningState !== "draft" ? "PRT-90210" : null,
      events: [],
    });
  return json(200, {});
}

const SESSION = {
  roles: ["billing_specialist"],
  permissions: [],
  isAdmin: false,
  userId: "user-1",
  organizationId: "org-1",
  membershipId: ME,
};

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{`${loc.pathname}${loc.search}`}</div>;
}

function mount(): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/work"]}>
            <Routes>
              <Route
                path="/work"
                element={
                  <DenialDetailPanel
                    denialId={DENIAL}
                    onClose={() => undefined}
                    onChanged={() => undefined}
                  />
                }
              />
              <Route path="*" element={<Where />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

beforeEach(() => {
  calls = [];
  refusal = null;
  route = "reopening";
  unverified = true;
  reopeningState = null;
  dueAt = null;
  routeFails = false;
  listFails = false;
  gets = [];
  window.sessionStorage.clear();
});
afterEach(() => cleanup());

describe("M25 denial path", () => {
  it("shows the path, the rule that decided it, and says an unverified rule needs confirming", async () => {
    mount();
    expect(await screen.findByText("MAC reopening")).toBeTruthy();
    expect(screen.getByText(/Built-in rule: Mac Reason 56900/i)).toBeTruthy();
    expect(screen.getByText(/nobody has verified with your MAC/i)).toBeTruthy();
    expect(screen.getByText(/CGS: an ADR non-response/)).toBeTruthy();
  });

  it("does not claim the rule is unverified once it is verified", async () => {
    unverified = false;
    mount();
    await screen.findByText("MAC reopening");
    expect(screen.queryByText(/nobody has verified with your MAC/i)).toBeNull();
  });

  it("leaves an undetermined denial appealable with no reopening controls", async () => {
    route = "undetermined";
    mount();
    expect(await screen.findByText("Not determined")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open reopening" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Open appeal" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Open appeal" }).at(-1) as HTMLElement);
    await waitFor(() =>
      expect(calls).toEqual([
        {
          method: "POST",
          path: `/api/v1/denials/${DENIAL}/appeals`,
          ifMatch: null,
          body: { tier: "redetermination" },
        },
      ]),
    );
  });

  it("records the MAC reason code with the version the panel read", async () => {
    route = "undetermined";
    mount();
    await screen.findByText("Not determined");
    fireEvent.change(screen.getByLabelText(/MAC reason code/i), { target: { value: "56900" } });
    fireEvent.click(screen.getByRole("button", { name: "Save reason code" }));
    await waitFor(() =>
      expect(calls).toEqual([
        {
          method: "PUT",
          path: `/api/v1/denials/${DENIAL}/mac-reason-code`,
          ifMatch: "7",
          body: { code: "56900" },
        },
      ]),
    );
  });

  it("shows a refused reason code verbatim", async () => {
    route = "undetermined";
    refusal = {
      status: 422,
      body: {
        error: {
          code: "INVALID_MAC_REASON_CODE",
          message: "the MAC reason code is 1 to 16 letters or digits",
        },
      },
    };
    mount();
    await screen.findByText("Not determined");
    fireEvent.change(screen.getByLabelText(/MAC reason code/i), { target: { value: "bad code" } });
    fireEvent.click(screen.getByRole("button", { name: "Save reason code" }));
    expect(
      await screen.findByText("the MAC reason code is 1 to 16 letters or digits"),
    ).toBeTruthy();
    // the refused value stays in the field after the reload, so the person can correct it
    await waitFor(() =>
      expect((screen.getByLabelText(/MAC reason code/i) as HTMLInputElement).value).toBe(
        "bad code",
      ),
    );
  });

  it("offers Retry, keeps the form and disables the appeal when the path cannot be read", async () => {
    routeFails = true;
    mount();
    expect(await screen.findByText("route read failed")).toBeTruthy();
    // The case timeline (also unreadable in this stub) has its own Retry above the path section's.
    const retry = (): HTMLElement =>
      screen.getAllByRole("button", { name: "Retry" }).at(-1) as HTMLElement;
    expect(retry()).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Open appeal" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    routeFails = false;
    fireEvent.click(retry());
    expect(await screen.findByText("MAC reopening")).toBeTruthy();
  });

  it("does not offer Open reopening when the reopenings could not be read", async () => {
    listFails = true;
    mount();
    await screen.findByText("MAC reopening");
    expect(
      await screen.findByText(/could not be read, so a new one cannot be opened/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open reopening" })).toBeNull();
  });
});

describe("M25 appealing a reopening-route denial", () => {
  it("asks for a reason of at least 10 characters and sends it to the override route", async () => {
    mount();
    await screen.findByText("MAC reopening");
    fireEvent.click(await screen.findByRole("button", { name: "Appeal anyway" }));
    const submit = screen
      .getAllByRole("button", { name: "Open appeal" })
      .at(-1) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Why appeal this anyway?"), {
      target: { value: "The MAC said appeal" },
    });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() =>
      expect(calls).toEqual([
        {
          method: "POST",
          path: `/api/v1/denials/${DENIAL}/appeals/override`,
          ifMatch: null,
          body: { tier: "redetermination", overrideReason: "The MAC said appeal" },
        },
      ]),
    );
  });
});

describe("M25 reopening lifecycle", () => {
  it("opens a reopening for the MAC named", async () => {
    mount();
    await screen.findByText("MAC reopening");
    const mac = (await screen.findByLabelText(
      "MAC that is reopening this claim",
    )) as HTMLInputElement;
    await waitFor(() => expect(mac.value).toBe("CGS"));
    fireEvent.click(screen.getByRole("button", { name: "Open reopening" }));
    await waitFor(() =>
      expect(calls).toEqual([
        {
          method: "POST",
          path: "/api/v1/reopenings",
          ifMatch: null,
          body: { denialCaseId: DENIAL, macName: "CGS" },
        },
      ]),
    );
  });

  it("says no deadline is known rather than computing one, and records one on request", async () => {
    reopeningState = "draft";
    mount();
    expect(await screen.findByText(/No deadline known/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/MAC deadline \(if the MAC gave one\)/), {
      target: { value: "2099-01-01T10:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save deadline" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "PUT",
      path: `/api/v1/reopenings/${REOPENING}/due`,
      ifMatch: "4",
    });
    expect(typeof calls[0]?.body.dueAt).toBe("string");
  });

  it("keeps Record filing off until the form and confirmation are given, then files with the version read", async () => {
    reopeningState = "draft";
    mount();
    const file = (await screen.findByRole("button", {
      name: "Record filing",
    })) as HTMLButtonElement;
    expect(file.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Form or request used"), {
      target: { value: "CGS reopening request" },
    });
    fireEvent.change(screen.getByLabelText("Confirmation or tracking reference"), {
      target: { value: "PRT-90210" },
    });
    await waitFor(() => expect(file.disabled).toBe(false));
    fireEvent.click(file);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/reopenings/${REOPENING}/submit`,
      ifMatch: "4",
      body: {
        formName: "CGS reopening request",
        channel: "mac_portal",
        confirmationRef: "PRT-90210",
      },
    });
  });

  it("sends the person through step-up and keeps what they typed", async () => {
    reopeningState = "draft";
    refusal = {
      status: 403,
      body: { error: { code: "STEP_UP_REQUIRED", message: "recent verification required" } },
    };
    mount();
    fireEvent.change(await screen.findByLabelText("Form or request used"), {
      target: { value: "CGS reopening request" },
    });
    fireEvent.change(screen.getByLabelText("Confirmation or tracking reference"), {
      target: { value: "PRT-90210" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record filing" }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toContain("/step-up"));
    const stashed = Object.keys(window.sessionStorage).filter((k) => k.includes("m25-reopening"));
    expect(stashed.length).toBe(1);
    expect(window.sessionStorage.getItem(stashed[0] as string)).toContain("PRT-90210");
  });

  it("shows a stale-version refusal verbatim and reloads", async () => {
    reopeningState = "draft";
    refusal = {
      status: 409,
      body: {
        error: {
          code: "VERSION_CONFLICT",
          message: "This record changed before your action was applied.",
        },
      },
    };
    mount();
    fireEvent.change(await screen.findByLabelText("Form or request used"), {
      target: { value: "CGS reopening request" },
    });
    fireEvent.change(screen.getByLabelText("Confirmation or tracking reference"), {
      target: { value: "PRT-90210" },
    });
    const readsBefore = gets.filter((p) => p === `/api/v1/reopenings/${REOPENING}`).length;
    fireEvent.click(screen.getByRole("button", { name: "Record filing" }));
    expect(
      await screen.findByText("This record changed before your action was applied."),
    ).toBeTruthy();
    // the case was read again after the refusal, so the retry carries the version the server holds now
    await waitFor(() =>
      expect(gets.filter((p) => p === `/api/v1/reopenings/${REOPENING}`).length).toBeGreaterThan(
        readsBefore,
      ),
    );
    // the button comes back after the reload, so the person can retry on the fresh version
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Record filing" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it("records the MAC's decision once filed, then closes it", async () => {
    reopeningState = "submitted";
    mount();
    expect(await screen.findByText("PRT-90210")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Outcome"), { target: { value: "partial" } });
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/reopenings/${REOPENING}/decide`,
      ifMatch: "4",
      body: { outcome: "partial" },
    });
    cleanup();
    calls = [];
    reopeningState = "decided";
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Close reopening" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ path: `/api/v1/reopenings/${REOPENING}/close`, ifMatch: "4" });
  });

  it("withdraws a live reopening only after a second, confirming click", async () => {
    reopeningState = "submitted";
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw reopening" }));
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Keep reopening" }));
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Withdraw reopening" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdraw" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      path: `/api/v1/reopenings/${REOPENING}/withdraw`,
      ifMatch: "4",
    });
  });
});
