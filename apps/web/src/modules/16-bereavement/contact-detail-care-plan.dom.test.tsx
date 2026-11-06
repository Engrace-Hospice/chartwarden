import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
// apps/web/src/modules/16-bereavement — the contact's care plan (ADR-0109): up to three care goals, that contact's own
// schedule labelled by its Medicare-floor mark, and the `no_mailings` opt-out ("calls continue").
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { BereavedContactDetail } from "./contact-detail";

const PLAN_ID = "8f14e45f-ceea-467a-9c1f-1b0c2d3e4f50";
const CONTACT_ID = "3c4d5e6f-7081-4a92-a3b4-c5d6e7f80910";
const OTHER_CONTACT_ID = "4d5e6f70-8192-4ba3-b4c5-d6e7f8091021";

const CONTACT = {
  contactId: CONTACT_ID,
  planId: PLAN_ID,
  status: "active",
  displayName: "Robin Vale",
  relationshipCode: "friend",
  preferredLanguageIso639: "en",
  portalAccountId: null,
  consentRecordId: null,
  allowedOutreachKinds: ["phone_call"],
  volunteerVisibleOnly: false,
  confirmedAt: "2026-06-03T00:00:00.000Z",
  optedOutAt: null,
  unreachableAt: null,
  unreachableProposed: false,
  unreachableProposedAt: null,
  deceasedAt: null,
  mayRescindOptOut: false,
  mailingsAllowed: true,
  careGoals: ["Get back to the garden"],
  currentRiskTier: "moderate",
  version: 4,
};

const plan = (contact: Record<string, unknown>) => ({
  planId: PLAN_ID,
  patientId: "1a2b3c4d-5e6f-4708-8192-a3b4c5d6e7f8",
  admissionId: "2b3c4d5e-6f70-4819-92a3-b4c5d6e7f809",
  providerEntityId: null,
  status: "active",
  deathDate: "2026-06-01",
  deathTime: null,
  windowEndsAt: "2027-06-01T00:00:00.000Z",
  openedAt: "2026-06-02T00:00:00.000Z",
  currentRiskTier: "moderate",
  firstContactAllowed: true,
  contacts: [contact],
  stats: { contactsActiveCount: 1, contactsOptedOutCount: 0, completedCount: 0, missedCount: 0 },
  version: 3,
  updatedAt: "2026-08-01T00:00:00.000Z",
  redactedCategories: [],
});

const touchpoint = (over: Record<string, unknown>) => ({
  outreachId: crypto.randomUUID(),
  planId: PLAN_ID,
  contactId: CONTACT_ID,
  kind: "phone_call",
  status: "scheduled",
  anniversaryMark: null,
  cadenceMark: null,
  dueAt: "2026-06-29T00:00:00.000Z",
  lateGraceUntil: "2026-07-06T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  assigneeUserId: null,
  renderedDocumentId: null,
  sourceEncounterId: null,
  version: 0,
  ...over,
});

const SCHEDULE = [
  touchpoint({ cadenceMark: "initial_outreach", dueAt: "2026-06-29T00:00:00.000Z" }),
  touchpoint({ cadenceMark: "nine_month", dueAt: "2027-02-26T00:00:00.000Z" }),
  touchpoint({
    cadenceMark: "anniversary",
    kind: "anniversary_letter",
    anniversaryMark: "anniversary",
    dueAt: "2027-06-01T00:00:00.000Z",
  }),
  touchpoint({
    cadenceMark: "closeout_letter",
    kind: "sympathy_letter",
    dueAt: "2027-06-26T00:00:00.000Z",
  }),
  // another survivor's touchpoint must never show on this contact's schedule
  touchpoint({
    contactId: OTHER_CONTACT_ID,
    cadenceMark: "three_month",
    dueAt: "2026-08-30T00:00:00.000Z",
  }),
];

interface Sent {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
}

function mount(contact: Record<string, unknown> = CONTACT): {
  sent: Sent[];
  outreachQueries: string[];
} {
  const sent: Sent[] = [];
  const outreachQueries: string[] = [];
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : null;
    const method = (req?.method ?? init?.method ?? "GET").toUpperCase();
    const url = new URL(req ? req.url : String(input), "http://localhost");
    const reply = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (method !== "GET") {
      const text = req ? await req.text() : String(init?.body ?? "");
      sent.push({
        method,
        path: url.pathname,
        body: text ? JSON.parse(text) : null,
        headers: req?.headers ?? new Headers(init?.headers),
      });
      return reply({ ...contact, version: 5 });
    }
    if (url.pathname.endsWith("/outreach")) {
      outreachQueries.push(url.search);
      const wanted = url.searchParams.get("contactId");
      const rows = SCHEDULE.filter((r) => wanted === null || r.contactId === wanted);
      return reply({ data: rows, next_cursor: null, has_more: false });
    }
    return reply(plan(contact));
  };
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stub })}>
      <SessionProvider session={{ userId: "u-1", organizationId: "org-1" }}>
        <MemoryRouter initialEntries={[`/bereavement/plans/${PLAN_ID}/contacts/${CONTACT_ID}`]}>
          <Routes>
            <Route
              path="/bereavement/plans/:planId/contacts/:contactId"
              element={<BereavedContactDetail />}
            />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return { sent, outreachQueries };
}

beforeEach(() => {
  window.history.pushState({}, "", "/");
});

describe("contact care plan — goals", () => {
  it("shows the recorded goals in an editor of at most three, each capped at 280 characters", async () => {
    mount();
    const panel = (await screen.findByRole("heading", { name: "Care plan" })).closest(
      "section, div",
    ) as HTMLElement;
    expect(panel).toBeTruthy();
    const goal = screen.getByLabelText("Care goal 1") as HTMLInputElement;
    expect(goal.value).toBe("Get back to the garden");
    expect(goal.maxLength).toBe(280);
    fireEvent.click(screen.getByRole("button", { name: "Add goal" }));
    fireEvent.click(screen.getByRole("button", { name: "Add goal" }));
    expect(screen.getByLabelText("Care goal 3")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add goal" })).toBeNull();
  });

  it("saves the goals with PUT care-plan and the contact version read (If-Match)", async () => {
    const { sent } = mount();
    const goal = (await screen.findByLabelText("Care goal 1")) as HTMLInputElement;
    fireEvent.change(goal, { target: { value: "  Sleep through the night " } });
    fireEvent.click(screen.getByRole("button", { name: "Add goal" }));
    fireEvent.change(screen.getByLabelText("Care goal 2"), { target: { value: "Call my sister" } });
    fireEvent.click(screen.getByRole("button", { name: "Save care goals" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      method: "PUT",
      path: `/api/v1/bereavement/contacts/${CONTACT_ID}/care-plan`,
      body: { goals: ["Sleep through the night", "Call my sister"] },
    });
    expect(sent[0]?.headers.get("if-match")).toBe("4");
    expect(sent[0]?.headers.get("idempotency-key")).toBeTruthy();
  });

  it("removing every goal and saving clears them", async () => {
    const { sent } = mount();
    await screen.findByLabelText("Care goal 1");
    fireEvent.click(screen.getByRole("button", { name: "Remove care goal 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Save care goals" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toEqual({ goals: [] });
  });

  it("never saves a blank goal", async () => {
    const { sent } = mount();
    const goal = (await screen.findByLabelText("Care goal 1")) as HTMLInputElement;
    fireEvent.change(goal, { target: { value: "   " } });
    expect(
      (screen.getByRole("button", { name: "Save care goals" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("with the goals redacted (a volunteer scope) it explains and offers no editor", async () => {
    const { careGoals: _omit, ...redacted } = CONTACT;
    mount(redacted);
    expect(await screen.findByText(/Care goals are not shown in your scope/)).toBeTruthy();
    expect(screen.queryByLabelText("Care goal 1")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save care goals" })).toBeNull();
  });
});

describe("contact care plan — this contact's schedule", () => {
  it("lists only this survivor's touchpoints, named by their Medicare-floor mark", async () => {
    const { outreachQueries } = mount();
    expect(await screen.findByText("1–4 week call")).toBeTruthy();
    expect(screen.getByText("Month 9")).toBeTruthy();
    expect(screen.getByText("12-month card")).toBeTruthy();
    expect(screen.getByText("Closeout letter")).toBeTruthy();
    // the other survivor's three-month call is not on this contact's schedule
    expect(screen.queryByText("3-month call")).toBeNull();
    expect(outreachQueries.some((q) => q.includes(`contactId=${CONTACT_ID}`))).toBe(true);
  });
});

describe("contact opt-out — no mailings", () => {
  const openModal = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Record opt-out" }));
    return screen.findByRole("dialog");
  };

  it("offers 'No mailings (calls continue)' and posts it without channels", async () => {
    const { sent } = mount();
    const dialog = await openModal();
    fireEvent.change(within(dialog).getByLabelText("Scope"), { target: { value: "no_mailings" } });
    expect(within(dialog).getByText(/calls and visits continue/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Record opt-out" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.path).toBe(`/api/v1/bereavement/contacts/${CONTACT_ID}/opt-out`);
    expect(sent[0]?.body).toEqual({ optOutKind: "no_mailings", sourceKind: "counselor_recorded" });
    expect(sent[0]?.headers.get("if-match")).toBe("4");
  });

  it("a contact who stopped mailings is still ACTIVE: a badge, a resume action, no opted-out banner", async () => {
    const { sent } = mount({ ...CONTACT, mailingsAllowed: false });
    expect(await screen.findByText("Mailings stopped")).toBeTruthy();
    expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Opted out \d{4}/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume mailings" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.path).toBe(`/api/v1/bereavement/contacts/${CONTACT_ID}/rescind-opt-out`);
  });

  it("with mailings allowed there is no badge and no resume action", async () => {
    mount();
    await screen.findByText("Robin Vale");
    expect(screen.queryByText("Mailings stopped")).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume mailings" })).toBeNull();
  });
});
