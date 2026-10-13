// M36 Phase 2 gate (docs/messaging-hub/03-phases-0-to-3.md, "XSS corpus"): every checked-in corpus payload
// (`XSS_CORPUS`, packages/types/src/messaging-xss-corpus.ts) is fed to EVERY place the staff web app renders
// server-supplied text, and the rendered DOM must stay inert: no element built from the payload, no on* attribute,
// no non-allowlisted URL, no page global set. rich-body-view.dom.test.tsx covers the rich renderer itself; this file
// covers the surrounding surfaces: inbox rows, thread header, patient header, plain/markdown/rich bubbles, mention
// chips, attachment names, pinned bar, search snippet, Members dialog, Scheduled list, notifications and banners.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { XSS_CORPUS } from "@wardenx/types";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertInboxProvider } from "../../shell/alert-inbox";
import { type Session, SessionProvider } from "../../shell/session";
import { ChannelMembersDialog } from "./channel-members-dialog";
import { NotificationsInbox } from "./notifications-inbox";
import { ScheduledMessagesDialog } from "./scheduled-messages-dialog";
import { StaffMessaging } from "./staff-messaging";
import { expectInert, resetXssFlag } from "./xss-assertions";

vi.mock("socket.io-client", () => ({
  io: () => ({ on: () => {}, off: () => {}, close: () => {} }),
}));

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  resetXssFlag();
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
      references: [],
      bodyDoc: {
        schemaVersion: 1,
        doc: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: payload }] }],
        },
      },
    },
  ];
}

function world(payload: string) {
  const messages = hostileMessages(payload);
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
      if (path.endsWith("/messages") || path.endsWith("/thread"))
        return Promise.resolve(ok({ messages }));
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

describe("M36 staff messaging page under the XSS corpus", () => {
  it.each(XSS_CORPUS.map((entry) => [entry.id, entry.payload] as const))(
    "%s renders inert in inbox, header, patient header, bubbles, chips, attachments and pins",
    async (_id, payload) => {
      const api = world(payload);
      const { container } = render(
        <MemoryRouter>
          <ApiClientProvider client={asClient(api)}>
            <SessionProvider session={SESSION}>
              <StaffMessaging />
            </SessionProvider>
          </ApiClientProvider>
        </MemoryRouter>,
      );
      await screen.findByRole("textbox", { name: "Message" });
      await waitFor(() => expect(container.textContent).toContain("plain"));
      await waitFor(() =>
        expect(api.GET.mock.calls.some(([path]) => path === "/api/v1/patients/{id}")).toBe(true),
      );
      expectInert(document.body);
      // The rich bubble shows its payload as text, never as markup.
      if (isPlainText(payload)) expect(container.textContent).toContain(payload.slice(0, 12));
    },
  );
});

// Guards against a vacuous pass: the hostile text must actually reach each surface, as TEXT.
const MARK = "<img src=x onerror=window.__xss=1>";
describe("the payload reaches every surface as literal text", () => {
  it("page: inbox row, thread header, patient header, bubbles, pins, attachments", async () => {
    const { container } = render(
      <MemoryRouter>
        <ApiClientProvider client={asClient(world(MARK))}>
          <SessionProvider session={SESSION}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    await screen.findByRole("textbox", { name: "Message" });
    await waitFor(() => expect(container.textContent).toContain(`plain ${MARK}`));
    const occurrences = (container.textContent ?? "").split(MARK).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(12);
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expectInert(document.body);
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
              members: [{ userId: "u-1", displayName: payload, role: payload, source: "manual" }],
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
      await waitFor(() => expect(api.GET).toHaveBeenCalled());
      await screen.findByRole("heading", { name: "Members" });
      expectInert(document.body);
      if (isPlainText(payload)) expect(document.body.textContent).toContain(payload);
    },
  );

  it.each(XSS_CORPUS.map((entry) => [entry.id, entry.payload] as const))(
    "%s renders inert in the Scheduled list",
    async (_id, payload) => {
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
                  body: payload,
                  scheduledFor: when,
                  timeZone: "America/Chicago",
                  status: "blocked",
                  blockedReason: payload,
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
          <ScheduledMessagesDialog open onClose={() => {}} channelName={() => payload} />
        </ApiClientProvider>,
      );
      await waitFor(() => expect(api.GET).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expectInert(document.body);
      if (isPlainText(payload)) expect(document.body.textContent).toContain(payload);
    },
  );

  it.each(XSS_CORPUS.map((entry) => [entry.id, entry.payload] as const))(
    "%s renders inert in the notifications inbox, and never becomes a link target",
    async (_id, payload) => {
      const alert = {
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
      const api = {
        GET: vi.fn(() => Promise.resolve(ok({ alerts: [alert, { ...alert, alertId: "a2" }] }))),
        POST: vi.fn(),
      };
      render(
        <MemoryRouter>
          <ApiClientProvider client={asClient(api)}>
            <SessionProvider session={SESSION}>
              <AlertInboxProvider>
                <NotificationsInbox />
              </AlertInboxProvider>
            </SessionProvider>
          </ApiClientProvider>
        </MemoryRouter>,
      );
      await waitFor(() => expect(api.GET).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expectInert(document.body);
      if (isPlainText(payload)) expect(document.body.textContent).toContain(payload);
      // A hostile deepLink must not turn the row into a navigable link.
      for (const row of Array.from(document.querySelectorAll("tr[role=link]")))
        fireEvent.click(row);
      expect(window.location.href).not.toMatch(/^javascript:|^data:/i);
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
      await waitFor(() => expect(api.GET).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expectInert(document.body);
    },
  );
});
