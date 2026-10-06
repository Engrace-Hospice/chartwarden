// apps/web/src/modules/16-bereavement — the "unreachable proposed" banner. The nightly detector only
// PROPOSES; the counselor confirms through the existing mark-unreachable route.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, createApiClient } from "@wardenx/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { BereavedContactDetail } from "./contact-detail";

const PLAN_ID = "8f14e45f-ceea-467a-9c1f-1b0c2d3e4f50";
const CONTACT_ID = "3c4d5e6f-7081-4a92-a3b4-c5d6e7f80910";
const BANNER = /Contact may be unreachable: 3 consecutive no-response attempts/;

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
  currentRiskTier: "moderate",
  version: 4,
};

const planWith = (contact: Record<string, unknown>) => ({
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

function mount(contact: Record<string, unknown>): { posts: { path: string; body: unknown }[] } {
  const calls: { posts: { path: string; body: unknown }[] } = { posts: [] };
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : null;
    const method = (req?.method ?? init?.method ?? "GET").toUpperCase();
    const path = new URL(req ? req.url : String(input), "http://localhost").pathname;
    const reply = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (method === "POST") {
      const text = req ? await req.text() : String(init?.body ?? "");
      calls.posts.push({ path, body: text ? JSON.parse(text) : null });
      return reply({ ...CONTACT, status: "unreachable" });
    }
    return reply(planWith(contact));
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
  return calls;
}

beforeEach(() => {
  window.history.pushState({}, "", "/");
});

describe("bereavement contact — unreachable proposed banner", () => {
  it("hides the banner when the detector has not proposed", async () => {
    mount(CONTACT);
    await screen.findByText("Robin Vale");
    expect(screen.queryByText(BANNER)).toBeNull();
  });

  it("shows the banner when the contact is proposed unreachable", async () => {
    mount({
      ...CONTACT,
      unreachableProposed: true,
      unreachableProposedAt: "2026-09-30T10:00:00.000Z",
    });
    expect(await screen.findByText(BANNER)).toBeTruthy();
  });

  it("confirming from the banner posts mark-unreachable for the contact", async () => {
    const calls = mount({
      ...CONTACT,
      unreachableProposed: true,
      unreachableProposedAt: "2026-09-30T10:00:00.000Z",
    });
    await screen.findByText(BANNER);
    // The banner action is the first "Mark unreachable" button; the Actions card carries the second.
    fireEvent.click(screen.getAllByRole("button", { name: "Mark unreachable" })[0]!);
    expect(await screen.findByText("Mark survivor unreachable")).toBeTruthy();
    const confirm = screen.getAllByRole("button", { name: "Mark unreachable" }).at(-1)!;
    fireEvent.click(confirm);
    await waitFor(() => expect(calls.posts).toHaveLength(1));
    expect(calls.posts[0]?.path).toBe(
      `/api/v1/bereavement/contacts/${CONTACT_ID}/mark-unreachable`,
    );
  });

  it("Keep trying posts dismiss-unreachable-proposal with the contact version, without a modal", async () => {
    const calls = mount({
      ...CONTACT,
      unreachableProposed: true,
      unreachableProposedAt: "2026-09-30T10:00:00.000Z",
    });
    await screen.findByText(BANNER);
    fireEvent.click(screen.getByRole("button", { name: "Keep trying" }));
    await waitFor(() => expect(calls.posts).toHaveLength(1));
    expect(calls.posts[0]?.path).toBe(
      `/api/v1/bereavement/contacts/${CONTACT_ID}/dismiss-unreachable-proposal`,
    );
    expect(screen.queryByText("Mark survivor unreachable")).toBeNull();
  });
});
