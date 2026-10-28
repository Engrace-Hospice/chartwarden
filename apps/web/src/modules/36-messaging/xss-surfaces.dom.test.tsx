import { XSS_CORPUS } from "@chartwarden/types";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
// M36 Phase 2 gate (docs/messaging-hub/03-phases-0-to-3.md, "XSS corpus"): every checked-in corpus payload
// (`XSS_CORPUS`, packages/types/src/messaging-xss-corpus.ts) is fed to the places the staff web app renders
// server-supplied text, and the rendered DOM must stay inert: no element built from the payload, no on* attribute,
// no non-allowlisted URL, no page global set. rich-body-view.dom.test.tsx covers the rich renderer itself; this file
// covers the surrounding surfaces, each reached by a real render or interaction and awaited on a payload-independent
// marker (so an empty DOM can never pass): inbox rows, thread header, patient header (MRN chip), plain and rich
// bubbles, mention chips (message-row.tsx renders `references` of a plain body; rich-body-view.tsx renders a {type:"mention"} node), attachment names, the
// pinned bar, the in-conversation search result (Ctrl+F), the thread panel (opened from the reply count), the Members
// dialog, the Scheduled list, the notifications inbox and the channel-list error banner.
// NOT covered here (no case renders them with hostile data): saved replies, read receipts, the offline banner, the
// platform reply panel, the announcement tools. A markdown-kind body is sent as hostile TEXT only: it is shown as plain
// text, so no markdown rendering is claimed for it.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertInboxProvider } from "../../shell/alert-inbox";
import { type Session, SessionProvider } from "../../shell/session";
import { ChannelMembersDialog } from "./channel-members-dialog";
import { NotificationsInbox } from "./notifications-inbox";
import { ScheduledMessagesDialog } from "./scheduled-messages-dialog";
import { StaffMessaging } from "./staff-messaging";
import { controlCount, expectInert, resetXssFlag } from "./xss-assertions";

vi.mock("socket.io-client", () => ({
  io: () => ({ on: () => {}, off: () => {}, close: () => {} }),
}));

const originalScrollIntoView = Element.prototype.scrollIntoView;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  resetXssFlag();
  Element.prototype.scrollIntoView =
    originalScrollIntoView as typeof Element.prototype.scrollIntoView;
});

const SESSION: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizationName: "North Hospice",
};
const CH = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PATIENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ok = (data: unknown) => ({ data, error: undefined, response: { status: 200 } });
const asClient = (api: unknown) => api as ApiClient;
/** Code points a text node, the DOM or the sanitiser may legitimately drop or alter: controls, bidi, zero-width. */
const isAlterable = (code: number): boolean =>
  code <= 0x1f ||
  (code >= 0x7f && code <= 0x9f) ||
  (code >= 0x200b && code <= 0x200f) ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2060 && code <= 0x206f) ||
  code === 0xfeff;
/** Payloads a plain text node shows verbatim. */
const isPlainText = (payload: string): boolean =>
  payload.trim() === payload &&
  !Array.from(payload).some((ch) => isAlterable(ch.codePointAt(0) ?? 0));

describe("the corpus is the shared one", () => {
  it("is large enough to mean something", () => {
    expect(XSS_CORPUS.length).toBeGreaterThanOrEqual(50);
  });
});

function hostileMessages(payload: string) {
  const base = {
    channelId: CH,
    authorUserId: "22222222-2222-4222-8222-222222222222",
    authorDisplayName: payload,
    bodyKind: "plain",
    createdAt: "2026-10-10T09:00:00.000Z",
    parentMessageId: null,
    replyCount: 1,
    lastReplyAt: "2026-10-10T09:05:00.000Z",
    reactions: [],
    pinned: true,
    attachments: [],
  };
  return [
    {
      ...base,
      messageId: "m-plain",
      body: `plain ${payload}`,
      references: [],
      attachments: [
        {
          attachmentId: "a-1",
          fileName: `${payload}.pdf`,
          mimeType: "application/pdf",
          byteSize: 10,
          availability: "available",
        },
      ],
    },
    {
      ...base,
      messageId: "m-markdown",
      body: `**${payload}** [x](javascript:window.__xss=1) ![i](x)`,
      bodyKind: "markdown",
      references: [],
    },
    {
      ...base,
      messageId: "m-mention",
      body: `hi ${payload}`,
      references: [
        {
          kind: "patient",
          entityId: PATIENT,
          start: 3,
          end: 3 + payload.length,
          displayLabel: payload,
          navigable: true,
        },
        {
          kind: "staff",
          entityId: "33333333-3333-4333-8333-333333333333",
          start: 0,
          end: 2,
          displayLabel: payload,
          navigable: false,
        },
      ],
    },
    {
      ...base,
      messageId: "m-rich",
      bodyKind: "rich",
      body: payload,
      // The server's label wins over the frozen one; navigable patient references become real in-app links.
      references: [
        {
          kind: "patient",
          entityId: PATIENT,
          start: 0,
          end: 1,
          displayLabel: payload,
          navigable: true,
        },
      ],
      bodyDoc: {
        schemaVersion: 1,
        doc: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: payload },
                {
                  type: "mention",
                  kind: "patient",
                  entityId: PATIENT,
                  label: payload.slice(0, 100),
                },
              ],
            },
          ],
        },
      },
    },
  ];
}

const THREAD_MARKER = "THREAD-MARKER reply";

function world(payload: string) {
  const messages = hostileMessages(payload);
  const threadReply = {
    ...messages[0],
    messageId: "m-thread-reply",
    parentMessageId: "m-plain",
    body: THREAD_MARKER,
    replyCount: 0,
    pinned: false,
    references: [],
    attachments: [],
  };
  return {
    GET: vi.fn((path: string) => {
      if (path === "/api/v1/messaging/channels")
        return Promise.resolve(
          ok({
            channels: [
              {
                channelId: CH,
                kind: "care_team",
                title: payload,
                subjectId: PATIENT,
                archivedAt: null,
                unreadCount: 2,
                mentionCount: 1,
                participantRoles: [payload],
                lastActivityAt: "2026-10-10T09:00:00.000Z",
                lastMessage: {
                  messageId: "m-plain",
                  preview: payload,
                  createdAt: "2026-10-10T09:00:00.000Z",
                  authorDisplayName: payload,
                },
              },
            ],
          }),
        );
      if (path.endsWith("/pins")) return Promise.resolve(ok({ pins: messages, patientId: null }));
      if (path.endsWith("/search"))
        return Promise.resolve(
          ok({
            results: [
              {
                messageId: "m-plain",
                authorDisplayName: payload,
                createdAt: "2026-10-10T09:00:00.000Z",
                body: `plain ${payload}`,
                attachments: [],
              },
            ],
            scanned: 1,
            scanCapped: false,
            patientId: null,
          }),
        );
      if (path.endsWith("/thread"))
        return Promise.resolve(
          ok({ root: messages[0], replies: [threadReply, ...messages.slice(1)], patientId: null }),
        );
      if (path.endsWith("/messages")) return Promise.resolve(ok({ messages }));
      if (path === "/api/v1/patients/{id}")
        return Promise.resolve(
          ok({ id: PATIENT, firstName: payload, lastName: payload, mrn: payload }),
        );
      return Promise.resolve(ok({}));
    }),
    POST: vi.fn(() => Promise.resolve(ok({}))),
    PUT: vi.fn(() => Promise.resolve(ok({}))),
    DELETE: vi.fn(() => Promise.resolve(ok({}))),
  };
}

/**
 * Mounts the page, waits for every payload-independent marker (composer, a plain bubble, the MRN chip, the pinned bar),
 * then reaches the two interactive surfaces: the search result (Ctrl+F) and the thread panel (reply count).
 */
async function renderAndExercisePage(payload: string) {
  const api = world(payload);
  const view = render(
    <MemoryRouter>
      <ApiClientProvider client={asClient(api)}>
        <SessionProvider session={SESSION}>
          <StaffMessaging />
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  const { container } = view;
  await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => expect(container.textContent).toContain("plain "));
  await waitFor(() => expect(container.textContent).toContain("MRN "));
  await screen.findByRole("navigation", { name: "Pinned messages" });

  // Search snippet: Ctrl+F, a fixed query, the result list is the marker.
  fireEvent.keyDown(document, { key: "f", ctrlKey: true });
  const searchBox = await screen.findByRole("searchbox", { name: "Search this conversation" });
  fireEvent.change(searchBox, { target: { value: "plain" } });
  const results = await screen.findByRole("list", { name: "Search results" }, { timeout: 3000 });
  expect(within(results).getByText("plain").tagName).toBe("MARK");

  // Thread panel: the first reply count opens it; the fixed reply text is the marker.
  const [openThread] = await screen.findAllByRole("button", { name: /^Open thread, / });
  fireEvent.click(openThread as HTMLElement);
  const panel = await screen.findByRole("complementary", { name: "Thread" });
  await within(panel).findByText(THREAD_MARKER);
  return { api, view, container };
}

describe("M36 staff messaging page under the XSS corpus", () => {
  // The app's own buttons/inputs are on this page, so the element ban skips controls and their COUNT is compared with
  // a benign render of the same flow instead: a payload that made a control would change the count.
  let benignControls = -1;
  beforeAll(async () => {
    Element.prototype.scrollIntoView = vi.fn();
    await renderAndExercisePage("benign");
    benignControls = controlCount(document.body);
    cleanup();
  }, 20_000);

  it.each(XSS_CORPUS.map((entry) => [entry.id, entry.payload] as const))(
    "%s renders inert in inbox, header, patient header, bubbles, chips, attachments, pins, search and thread panel",
    async (_id, payload) => {
      const { container } = await renderAndExercisePage(payload);
      expectInert(document.body, { appControls: true });
      expect(benignControls).toBeGreaterThan(0);
      expect(controlCount(document.body)).toBe(benignControls);
      // Mention chips: each is an in-app link to the patient, with the payload only as its text.
      const chips = Array.from(document.querySelectorAll("a.wx-message-reference"));
      expect(chips.length).toBeGreaterThan(0);
      // The rich-body chip specifically (a {type:"mention"} node), not only the plain-body reference chips.
      expect(
        document.querySelectorAll(".wx-rich-body a.wx-message-reference").length,
      ).toBeGreaterThan(0);
      for (const chip of chips) {
        expect(chip.getAttribute("href")).toBe(`/patients/${PATIENT}`);
        expect(chip.children).toHaveLength(0);
      }
      expect(screen.getAllByRole("list", { name: "Search results" })).toHaveLength(1);
      // The rich bubble shows its payload as text, never as markup.
      if (isPlainText(payload)) expect(container.textContent).toContain(payload.slice(0, 12));
    },
    15_000,
  );
});

// Guards against a vacuous pass: the hostile text must actually reach each surface, as TEXT.
const MARK = "<img src=x onerror=window.__xss=1>";
describe("the payload reaches every surface as literal text", () => {
  it("page: inbox row, thread header, patient header, bubbles, pins, attachments", async () => {
    const { container } = await renderAndExercisePage(MARK);
    await waitFor(() => {
      const occurrences = (container.textContent ?? "").split(MARK).length - 1;
      expect(occurrences).toBeGreaterThanOrEqual(12);
    });
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expectInert(document.body, { appControls: true });
  });

  it("search result and thread panel show the payload as text too", async () => {
    await renderAndExercisePage(MARK);
    const results = screen.getByRole("list", { name: "Search results" });
    expect(results.textContent).toContain(MARK);
    const panel = screen.getByRole("complementary", { name: "Thread" });
    expect(panel.textContent).toContain(MARK);
  });
});

describe("M36 secondary surfaces under the XSS corpus", () => {
  it.each(XSS_CORPUS.map((entry) => [entry.id, entry.payload] as const))(
    "%s renders inert in the Members dialog",
    async (_id, payload) => {
      const api = {
        GET: vi.fn(() =>
          Promise.resolve(
            ok({
              members: [
                { userId: "u-0", displayName: "Marker Member", role: "member", source: "manual" },
                { userId: "u-1", displayName: payload, role: payload, source: "manual" },
              ],
              staff: [{ userId: "u-2", displayName: payload, roles: [payload] }],
            }),
          ),
        ),
        POST: vi.fn(() => Promise.resolve(ok({}))),
        DELETE: vi.fn(() => Promise.resolve(ok({}))),
      };
      render(
        <MemoryRouter>
          <ApiClientProvider client={asClient(api)}>
            <ChannelMembersDialog channelId="ch-1" channelTitle={payload} open onClose={() => {}} />
          </ApiClientProvider>
        </MemoryRouter>,
      );
      await screen.findByRole("heading", { name: "Members" });
      await screen.findByText("Marker Member"); // the list loaded, so the hostile rows are in the DOM too
      const rows = within(screen.getByRole("list", { name: "Channel members" })).getAllByRole(
        "listitem",
      );
      expect(rows).toHaveLength(2);
      expectInert(document.body, { appControls: true });
      // Scoped to the hostile member's own row: the dialog title is the payload too and must not satisfy this.
      if (isPlainText(payload)) expect(rows[1]?.textContent).toContain(payload);
    },
  );

  it.each(XSS_CORPUS.map((entry) => [entry.id, entry.payload] as const))(
    "%s renders inert in the Scheduled list",
    async (_id, payload) => {
      const when = new Date(Date.now() + 5 * 86_400_000).toISOString();
      const row = {
        id: "s-1",
        channelId: CH,
        parentMessageId: null,
        body: payload,
        scheduledFor: when,
        timeZone: "America/Chicago",
        status: "blocked",
        blockedReason: payload,
        createdAt: when,
        updatedAt: when,
      };
      const api = {
        GET: vi.fn(() =>
          Promise.resolve(
            ok({
              scheduledMessages: [
                row,
                {
                  ...row,
                  id: "s-2",
                  body: "Marker scheduled",
                  blockedReason: null,
                  status: "pending",
                },
              ],
            }),
          ),
        ),
        POST: vi.fn(),
        PATCH: vi.fn(),
        DELETE: vi.fn(),
      };
      render(
        <ApiClientProvider client={asClient(api)}>
          <ScheduledMessagesDialog open onClose={() => {}} channelName={() => payload} />
        </ApiClientProvider>,
      );
      const list = await screen.findByRole("list", { name: "Scheduled messages" });
      await within(list).findByText("Marker scheduled");
      const rows = within(list).getAllByRole("listitem");
      expect(rows).toHaveLength(2);
      expectInert(document.body, { appControls: true });
      // Scoped to the hostile row's own body: the channel label is the payload too and must not satisfy this.
      const blockedRow = rows.find((row) => row.getAttribute("data-status") === "blocked");
      const body = blockedRow?.querySelector(".wx-scheduled-body");
      expect(body).toBeTruthy();
      if (isPlainText(payload)) expect(body?.textContent).toContain(payload.slice(0, 12));
    },
  );

  it("an unknown blockedReason renders the row without echoing the raw value", async () => {
    const when = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const api = {
      GET: vi.fn(() =>
        Promise.resolve(
          ok({
            scheduledMessages: [
              {
                id: "s-1",
                channelId: CH,
                parentMessageId: null,
                body: "Row with a reason this client does not know",
                scheduledFor: when,
                timeZone: "America/Chicago",
                status: "blocked",
                blockedReason: "RAW_UNKNOWN_REASON_CODE",
                createdAt: when,
                updatedAt: when,
              },
            ],
          }),
        ),
      ),
      POST: vi.fn(),
      PATCH: vi.fn(),
      DELETE: vi.fn(),
    };
    render(
      <ApiClientProvider client={asClient(api)}>
        <ScheduledMessagesDialog open onClose={() => {}} channelName={() => "Care team"} />
      </ApiClientProvider>,
    );
    await screen.findByText("Row with a reason this client does not know");
    expect(document.body.textContent).not.toContain("RAW_UNKNOWN_REASON_CODE");
    // ...and the row still says something: a generic note, never an empty status.
    expect(document.querySelector(".wx-scheduled-blocked")?.textContent).toBe(
      "This message could not be sent. Reschedule it to try again.",
    );
  });
});

/** Shows where the router is, so a click on a row can be asserted by what it did rather than by a global. */
function LocationProbe() {
  const location = useLocation();
  return <output aria-label="router location">{location.pathname}</output>;
}
const SAFE_SUMMARY = "SAFE-ALERT-SUMMARY";
const SAFE_LINK = "/patients/safe-target";

describe("M36 notifications under the XSS corpus", () => {
  it.each(XSS_CORPUS.map((entry) => [entry.id, entry.payload] as const))(
    "%s renders inert in the notifications inbox, and a hostile deepLink never becomes a link target",
    async (_id, payload) => {
      const hostile = {
        alertId: payload,
        eventType: "m36.message.mentioned",
        category: payload,
        severity: "info",
        summary: payload,
        deepLink: payload,
        createdAt: "2026-10-10T08:00:00.000Z",
        deliveryStatus: "delivered",
        readAt: null,
      };
      const safe = { ...hostile, alertId: "a-safe", summary: SAFE_SUMMARY, deepLink: SAFE_LINK };
      const api = {
        GET: vi.fn(() => Promise.resolve(ok({ alerts: [hostile, safe] }))),
        POST: vi.fn(() => Promise.resolve(ok({}))),
      };
      render(
        <MemoryRouter initialEntries={["/start"]}>
          <ApiClientProvider client={asClient(api)}>
            <SessionProvider session={SESSION}>
              <AlertInboxProvider>
                <NotificationsInbox />
                <LocationProbe />
              </AlertInboxProvider>
            </SessionProvider>
          </ApiClientProvider>
        </MemoryRouter>,
      );
      await screen.findByText(SAFE_SUMMARY); // the table rendered, so the hostile row is in the DOM too
      expect(document.querySelectorAll("tbody tr")).toHaveLength(2);
      expectInert(document.body, { appControls: true });
      if (isPlainText(payload)) expect(document.body.textContent).toContain(payload);

      // Independent of production code: no corpus payload is a same-origin path, so a hostile deepLink must never
      // yield a link row; the only one is the safe alert's.
      const links = Array.from(document.querySelectorAll("tr[role=link]"));
      expect(links).toHaveLength(1);
      expect(links[0]?.textContent).toContain(SAFE_SUMMARY);

      // The safe alert is a real link: clicking it navigates the router to its path.
      const safeRow = screen.getByText(SAFE_SUMMARY).closest("tr") as HTMLElement;
      expect(safeRow.getAttribute("role")).toBe("link");
      fireEvent.click(safeRow);
      await waitFor(() =>
        expect(screen.getByLabelText("router location").textContent).toBe(SAFE_LINK),
      );
    },
  );
});

describe("M36 banners and error text under the XSS corpus", () => {
  it.each(XSS_CORPUS.map((entry) => [entry.id, entry.payload] as const))(
    "%s in a failed channel-list error renders as text",
    async (_id, payload) => {
      const api = {
        GET: vi.fn(() =>
          Promise.resolve({
            data: undefined,
            error: { error: { message: payload, correlationId: payload } },
            response: { status: 500 },
          }),
        ),
        POST: vi.fn(),
      };
      render(
        <MemoryRouter>
          <ApiClientProvider client={asClient(api)}>
            <SessionProvider session={SESSION}>
              <StaffMessaging />
            </SessionProvider>
          </ApiClientProvider>
        </MemoryRouter>,
      );
      const banner = await screen.findByRole("alert"); // the error banner rendered
      expect(banner.textContent?.length).toBeGreaterThan(0);
      expectInert(document.body, { appControls: true });
      if (isPlainText(payload)) expect(banner.textContent).toContain(payload.slice(0, 12));
    },
  );
});
