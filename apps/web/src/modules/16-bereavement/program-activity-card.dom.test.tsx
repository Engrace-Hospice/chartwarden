import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// apps/web/src/modules/16-bereavement — ADR-0109 D10: the "Program activity" card of the contact detail (route 52).
// Touchpoints and program activities (mailings, sessions) are labelled apart; a bereavement volunteer's response has no `outcome` on a
// touchpoint and that is said ("Not shown to you"), never guessed; "Load more" appends; a 403 renders nothing; other failures are
// announced and keep the entries on screen.
import axe from "axe-core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { BereavedContactDetail } from "./contact-detail";
import { ProgramActivityCard } from "./program-activity-card";

const CONTACT_ID = "3c4d5e6f-7081-4a92-a3b4-c5d6e7f80910";
const TIMELINE_PATH = `/api/v1/bereavement/contacts/${CONTACT_ID}/timeline`;

const entry = (over: Record<string, unknown> = {}) => ({
  entryId: crypto.randomUUID(),
  at: "2026-09-14T15:30:00.000Z",
  source: "outreach",
  kind: "phone_call",
  activityKind: null,
  outcome: "engaged",
  ...over,
});
const activity = (over: Record<string, unknown> = {}) =>
  entry({
    source: "program_activity",
    kind: null,
    activityKind: "newsletter_mailing",
    outcome: "mailed",
    at: "2026-10-15T09:00:00.000Z",
    ...over,
  });

type Reply = { status: number; body?: unknown } | "reject";
const page = (data: unknown[], next: string | null = null, redactedCategories: string[] = []) => ({
  status: 200,
  body: { data, next_cursor: next, has_more: next !== null, redactedCategories },
});
const refused = (status: number, code: string, message = "refused"): Reply => ({
  status,
  body: { error: { code, message } },
});

function mount(answer: (query: URLSearchParams) => Reply | Promise<Reply>) {
  const queries: URLSearchParams[] = [];
  const stub = async (input: RequestInfo | URL): Promise<Response> => {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input), "http://localhost");
    expect(url.pathname).toBe(TIMELINE_PATH);
    queries.push(url.searchParams);
    const reply = await answer(url.searchParams);
    if (reply === "reject") throw new TypeError("network down");
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createApiClient({ baseUrl: "http://localhost", fetch: stub });
  const ui = (refreshKey: number) => (
    <ApiClientProvider client={client}>
      <MemoryRouter>
        <ProgramActivityCard contactId={CONTACT_ID} refreshKey={refreshKey} />
      </MemoryRouter>
    </ApiClientProvider>
  );
  const view = render(ui(0));
  return { queries, ...view, refresh: (key: number) => view.rerender(ui(key)) };
}

describe("program activity card — what it shows", () => {
  it("shows touchpoints and program activities side by side, labelled apart in words", async () => {
    mount(() => page([activity(), entry()]));
    const table = await screen.findByRole("table", { name: "Program activity timeline" });
    const rows = within(table).getAllByRole("row");
    const mailing = rows[1] as HTMLElement;
    const call = rows[2] as HTMLElement;
    expect(within(mailing).getByText("Program activity")).toBeTruthy();
    expect(within(mailing).getByText("Newsletter mailing")).toBeTruthy();
    expect(within(mailing).getByText("Mailed")).toBeTruthy();
    expect(within(call).getByText("Touchpoint")).toBeTruthy();
    expect(within(call).getByText("Phone call")).toBeTruthy();
    expect(within(call).getByText("Engaged")).toBeTruthy();
    expect(screen.getByText(/does not count toward the outreach schedule/)).toBeTruthy();
  });

  it("names each kind of program activity", async () => {
    mount(() =>
      page([
        activity({ activityKind: "holiday_mailing" }),
        activity({ activityKind: "memorial_invitation_mailing" }),
        activity({ activityKind: "support_group_session", outcome: "attended" }),
        activity({ activityKind: "memorial_service_attendance", outcome: "attended" }),
      ]),
    );
    for (const text of [
      "Holiday mailing",
      "Memorial invitation mailing",
      "Support group session",
      "Memorial service attendance",
    ])
      expect(await screen.findByText(text)).toBeTruthy();
  });

  it("shows no card chrome before the first answer", async () => {
    let answer: (r: Reply) => void = () => {};
    const { queries } = mount(
      () =>
        new Promise<Reply>((resolve) => {
          answer = resolve;
        }),
    );
    await waitFor(() => expect(queries).toHaveLength(1));
    expect(screen.queryByRole("heading", { name: "Program activity" })).toBeNull();
    answer(page([]));
    expect(await screen.findByRole("heading", { name: "Program activity" })).toBeTruthy();
  });

  it("reads again when the page says an entry was added, keeping the rows on screen", async () => {
    let reads = 0;
    const { queries, refresh } = mount(() => {
      reads += 1;
      return page(reads === 1 ? [entry()] : [activity(), entry()]);
    });
    await screen.findByText("Phone call");
    refresh(0); // an unrelated re-render reads nothing
    expect(queries).toHaveLength(1);
    refresh(1);
    expect(await screen.findByText("Newsletter mailing")).toBeTruthy();
    expect(queries).toHaveLength(2);
  });

  it("says nothing has been recorded when the timeline is empty", async () => {
    mount(() => page([]));
    expect(
      await screen.findByText("Nothing has been recorded for this survivor yet."),
    ).toBeTruthy();
  });

  it("a volunteer's touchpoints carry no outcome: it says 'Not shown to you', and activities keep theirs", async () => {
    mount(() =>
      page(
        [
          entry({ outcome: undefined }),
          entry({ kind: "in_person_visit", outcome: undefined }),
          activity(),
        ],
        null,
        ["clinical_risk"],
      ),
    );
    await screen.findByRole("table", { name: "Program activity timeline" });
    expect(screen.getAllByText("Not shown to you")).toHaveLength(2);
    expect(screen.getByText("Mailed")).toBeTruthy();
    // an absent outcome is never turned into a guess
    expect(screen.queryByText("Engaged")).toBeNull();
    expect(screen.getByText(/clinical risk content is withheld from this view/)).toBeTruthy();
  });
});

describe("program activity card — paging, and how it fails", () => {
  it("Load more sends the cursor and appends the next page", async () => {
    const { queries } = mount((q) =>
      q.get("cursor") === "next-1"
        ? page([activity({ activityKind: "holiday_mailing" })])
        : page([entry()], "next-1"),
    );
    await screen.findByRole("table", { name: "Program activity timeline" });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Holiday mailing")).toBeTruthy();
    expect(screen.getByText("Phone call")).toBeTruthy();
    expect(queries.some((q) => q.get("cursor") === "next-1")).toBe(true);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("a 403 renders nothing at all", async () => {
    const { container } = mount(() => refused(403, "FORBIDDEN"));
    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Program activity")).toBeNull();
  });

  it("a server error is announced with Try again, and the retry loads the entries", async () => {
    let reads = 0;
    mount(() => {
      reads += 1;
      return reads === 1 ? refused(500, "INTERNAL", "boom") : page([entry()]);
    });
    expect((await screen.findByRole("alert")).textContent).toContain("boom");
    expect(screen.getByRole("heading", { name: "Program activity" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Phone call")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a dropped connection is announced", async () => {
    mount(() => "reject");
    expect((await screen.findByRole("alert")).textContent).toMatch(/connection dropped/i);
  });

  it("a failed Load more is announced and the entries already shown stay", async () => {
    mount((q) =>
      q.get("cursor") === "next-1" ? refused(500, "INTERNAL", "boom") : page([entry()], "next-1"),
    );
    await screen.findByText("Phone call");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect((await screen.findByRole("alert")).textContent).toContain("boom");
    expect(screen.getByText("Phone call")).toBeTruthy();
  });

  it("keeps the entries on screen while a retry is read", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    mount(async (q) => {
      reads += 1;
      if (q.get("cursor") === "next-1") {
        if (reads === 2) return refused(500, "INTERNAL", "boom");
        await held;
        return page([activity({ activityKind: "holiday_mailing" })]);
      }
      return page([entry()], "next-1");
    });
    await screen.findByText("Phone call");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    // the second try is pending: nothing was unmounted
    expect(screen.getByText("Phone call")).toBeTruthy();
    release();
    expect(await screen.findByText("Holiday mailing")).toBeTruthy();
  });
});

describe("program activity card — on the contact detail", () => {
  const PLAN_ID = "8f14e45f-ceea-467a-9c1f-1b0c2d3e4f50";
  const contact = {
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
    careGoals: [],
    currentRiskTier: "moderate",
    version: 4,
  };
  const plan = {
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
  };

  function mountDetail(timeline: Reply) {
    const stub = async (input: RequestInfo | URL): Promise<Response> => {
      const req = input instanceof Request ? input : null;
      const url = new URL(req ? req.url : String(input), "http://localhost");
      const reply = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url.pathname === TIMELINE_PATH)
        return timeline === "reject"
          ? Promise.reject(new TypeError("network down"))
          : reply(timeline.status, timeline.body ?? {});
      if (url.pathname.endsWith("/outreach"))
        return reply(200, { data: [], next_cursor: null, has_more: false });
      return reply(200, plan);
    };
    return render(
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
  }

  it("is part of the contact page, between the care plan and the actions", async () => {
    mountDetail(page([activity()]));
    expect(await screen.findByRole("heading", { name: "Program activity" })).toBeTruthy();
    expect(await screen.findByText("Newsletter mailing")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Care plan" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Actions" })).toBeTruthy();
  });

  it("a 403 on the timeline removes only the card: the rest of the contact page is untouched", async () => {
    mountDetail(refused(403, "FORBIDDEN"));
    expect(await screen.findByRole("heading", { name: "Care plan" })).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Program activity" })).toBeNull(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a failing timeline is announced inside the card and the contact page stays up", async () => {
    mountDetail(refused(500, "INTERNAL", "boom"));
    expect((await screen.findByRole("alert")).textContent).toContain("boom");
    expect(screen.getByRole("heading", { name: "Care plan" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Robin Vale" })).toBeTruthy();
  });
});

describe("program activity card — accessibility", () => {
  it("has no axe violations", async () => {
    const { container } = mount(() => page([activity(), entry({ outcome: undefined })]));
    await screen.findByRole("table", { name: "Program activity timeline" });
    // The same rule set the e2e route walk gates on (WCAG 2.x A and AA).
    const results = await axe.run(container, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(" ")}`),
    ).toEqual([]);
  });
});
