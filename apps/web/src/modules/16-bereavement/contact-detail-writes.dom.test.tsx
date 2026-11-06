// apps/web/src/modules/16-bereavement — the contact page's inline writes and reloads: a refused write (412/409/404) reloads the
// page and says the contact moved; a lost response is retried under the same Idempotency-Key; a reload never unmounts the page or
// eats what the reader typed into the care goals; an unreadable schedule is said (403) or flagged (anything else) with a retry.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { BereavedContactDetail } from "./contact-detail";

const PLAN_ID = "8f14e45f-ceea-467a-9c1f-1b0c2d3e4f50";
const CONTACT_ID = "3c4d5e6f-7081-4a92-a3b4-c5d6e7f80910";

const contact = (over: Record<string, unknown> = {}) => ({
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
  mailingsAllowed: false,
  careGoals: ["Get back to the garden"],
  currentRiskTier: "moderate",
  version: 4,
  ...over,
});

const plan = (c: Record<string, unknown>) => ({
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
  contacts: [c],
  stats: { contactsActiveCount: 1, contactsOptedOutCount: 0, completedCount: 0, missedCount: 0 },
  version: 3,
  updatedAt: "2026-08-01T00:00:00.000Z",
  redactedCategories: [],
});

interface Opts {
  /** What a write answers (default 200 with the contact). */
  write?: { status: number; body: unknown };
  /** The first write fails like a dropped connection (the fetch rejects). */
  writeRejectsOnce?: boolean;
  /** The contact the plan GET returns once a write has been attempted (the server's state after it). */
  afterWrite?: Record<string, unknown>;
  outreachStatus?: number;
}

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
}

function mount(opts: Opts = {}): { sent: Sent[]; planGets: () => number } {
  const sent: Sent[] = [];
  let planGets = 0;
  let rejected = false;
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : null;
    const method = (req?.method ?? init?.method ?? "GET").toUpperCase();
    const url = new URL(req ? req.url : String(input), "http://localhost");
    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method !== "GET") {
      sent.push({
        method,
        path: url.pathname,
        headers: req?.headers ?? new Headers(init?.headers),
      });
      if (opts.writeRejectsOnce && !rejected) {
        rejected = true;
        throw new TypeError("network down");
      }
      const w = opts.write ?? { status: 200, body: contact({ version: 5 }) };
      return reply(w.body, w.status);
    }
    if (url.pathname.endsWith("/outreach")) {
      return opts.outreachStatus && opts.outreachStatus !== 200
        ? reply({ error: { code: "FORBIDDEN", message: "forbidden" } }, opts.outreachStatus)
        : reply({ data: [], next_cursor: null, has_more: false });
    }
    // The page's "Program activity" card reads the contact's timeline once; it is not a plan read.
    if (url.pathname.endsWith("/timeline"))
      return reply({ data: [], next_cursor: null, has_more: false, redactedCategories: [] });
    planGets += 1;
    return reply(plan(sent.length > 0 && opts.afterWrite ? opts.afterWrite : contact()));
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
  return { sent, planGets: () => planGets };
}

beforeEach(() => {
  window.history.pushState({}, "", "/");
});

const STALE = {
  status: 412,
  body: { error: { code: "STALE_VERSION", message: "the contact moved" } },
};

describe("contact page — refused and lost writes", () => {
  it("a stale Resume mailings (412) says the contact changed, and reloads the page", async () => {
    const { planGets } = mount({
      write: STALE,
      afterWrite: contact({ version: 5, mailingsAllowed: true }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Resume mailings" }));
    expect(
      await screen.findByText(/This contact changed while you were working on it/),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/refreshed/);
    // the reload found mailings already allowed, so the action is gone
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Resume mailings" })).toBeNull(),
    );
    expect(planGets()).toBe(2);
  });

  it("a lost Resume response is reported and the retry reuses the Idempotency-Key", async () => {
    const { sent } = mount({ writeRejectsOnce: true });
    const resume = await screen.findByRole("button", { name: "Resume mailings" });
    fireEvent.click(resume);
    expect(await screen.findByText(/connection dropped/i)).toBeTruthy();
    expect((resume as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(resume);
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]?.headers.get("idempotency-key")).toBeTruthy();
    expect(sent[1]?.headers.get("idempotency-key")).toBe(sent[0]?.headers.get("idempotency-key"));
  });

  it("a successful Resume reloads in place and moves focus to the status line", async () => {
    mount({ afterWrite: contact({ version: 5, mailingsAllowed: true }) });
    const heading = await screen.findByRole("heading", { name: "Care plan" });
    fireEvent.click(await screen.findByRole("button", { name: "Resume mailings" }));
    const status = await screen.findByText("Mailings resumed.");
    await waitFor(() => expect(document.activeElement).toBe(status));
    expect(screen.getByRole("heading", { name: "Care plan" })).toBe(heading);
  });
});

describe("contact page — the care goals survive a reload", () => {
  it("keeps what was typed when an unrelated action reloads the page", async () => {
    mount({ afterWrite: contact({ version: 5, mailingsAllowed: true }) });
    const goal = (await screen.findByLabelText("Care goal 1")) as HTMLInputElement;
    fireEvent.change(goal, { target: { value: "Sleep through the night" } });
    fireEvent.click(screen.getByRole("button", { name: "Resume mailings" }));
    await screen.findByText("Mailings resumed.");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Resume mailings" })).toBeNull(),
    );
    expect((screen.getByLabelText("Care goal 1") as HTMLInputElement).value).toBe(
      "Sleep through the night",
    );
  });

  it("re-seeds an untouched editor from the new server version", async () => {
    mount({
      afterWrite: contact({ version: 5, mailingsAllowed: true, careGoals: ["Plant the roses"] }),
    });
    await screen.findByLabelText("Care goal 1");
    fireEvent.click(screen.getByRole("button", { name: "Resume mailings" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Care goal 1") as HTMLInputElement).value).toBe(
        "Plant the roses",
      ),
    );
  });

  it("a stale save keeps the typed goals, says the contact changed and reloads", async () => {
    const { planGets } = mount({ write: STALE, afterWrite: contact({ version: 5 }) });
    const goal = (await screen.findByLabelText("Care goal 1")) as HTMLInputElement;
    fireEvent.change(goal, { target: { value: "Sleep through the night" } });
    fireEvent.click(screen.getByRole("button", { name: "Save care goals" }));
    expect(
      await screen.findByText(/This contact changed while you were working on it/),
    ).toBeTruthy();
    await waitFor(() => expect(planGets()).toBe(2));
    expect((screen.getByLabelText("Care goal 1") as HTMLInputElement).value).toBe(
      "Sleep through the night",
    );
    // the next save carries the version now current
    expect(
      (screen.getByRole("button", { name: "Save care goals" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("contact page — the schedule", () => {
  it("a 403 on the schedule says the role does not include it (it is not silently blank)", async () => {
    mount({ outreachStatus: 403 });
    expect(await screen.findByText(/does not include the touchpoint schedule/)).toBeTruthy();
    expect(screen.queryByText(/No touchpoints are scheduled/)).toBeNull();
  });

  it("any other schedule failure is an alert with Try again", async () => {
    mount({ outreachStatus: 500 });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/schedule could not be loaded/);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
