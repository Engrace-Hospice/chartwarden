import { createHash } from "node:crypto";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, vi } from "vitest";
import { ConversationThread } from "./conversation-thread";
import type { ChannelSummary } from "./messaging-types";

export const ME = "11111111-1111-4111-8111-111111111111";
export const ATTACHMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const SIGNED_URL = "https://objects.example.test/secret-signed-url?sig=abc123";
export const PUT_URL = "https://objects.example.test/put?sig=zzz";
export const PUT_HEADERS = {
  "content-type": "application/pdf",
  "x-amz-checksum-sha256": "base64sum",
};
export const STORE_PATHS = {
  uploads: "/api/v1/messaging/attachments/uploads",
  complete: "/api/v1/messaging/attachments/{id}/complete",
  status: "/api/v1/messaging/attachments/{id}",
  access: "/api/v1/messaging/attachments/{id}/access",
  messages: "/api/v1/messaging/channels/{id}/messages",
};

export const channel = (channelId: string): ChannelSummary => ({
  channelId,
  kind: "dm",
  title: "Nurse Two",
  subjectId: null,
  archivedAt: null,
  unreadCount: 0,
  mentionCount: 0,
  participantRoles: [],
  lastActivityAt: "2026-10-09T10:00:00.000Z",
  lastMessage: null,
});

export function pdf(name = "report.pdf", body = "hello pdf") {
  const file = new File([body], name, { type: "application/pdf" });
  // jsdom's File has no arrayBuffer(); the hashing helper needs one.
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode(body).buffer,
  });
  return file;
}

export const sha = (body: string) => createHash("sha256").update(body).digest("hex");

export const status = (availability: string) => ({
  attachmentId: ATTACHMENT_ID,
  channelId: "dm-1",
  fileName: "report.pdf",
  mimeType: "application/pdf",
  byteSize: 9,
  scanState: availability === "available" ? "clean" : "pending",
  availability,
  attached: false,
});

export const authorizedWith = (attachmentId: string) => ({
  data: {
    attachmentId,
    upload: {
      method: "PUT",
      url: PUT_URL,
      headers: PUT_HEADERS,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    },
    status: status("uploading"),
  },
  error: undefined,
  response: { status: 201 },
});
export const authorized = authorizedWith(ATTACHMENT_ID);

/** The real backend error envelope (apps/backend/src/bootstrap/plugins/error-handler.ts). */
export const envelope = (code: string, message = "detail", httpStatus = 400) => ({
  data: undefined,
  error: { error: { code, message, details: null, correlationId: "c-1", documentationUrl: "" } },
  response: { status: httpStatus },
});

/** A stand-in for the tab window.open returns. */
export function fakeTab() {
  return { opener: "unset" as unknown, location: { replace: vi.fn() }, close: vi.fn() };
}
export const completed = (availability: string) => ({
  data: status(availability),
  error: undefined,
  response: { status: 200 },
});

export type Handler = (path: string, init: Record<string, unknown>) => unknown;

export function mountThread(handlers: { GET?: Handler; POST?: Handler } = {}, channelId = "dm-1") {
  const api = {
    GET: vi.fn((path: string, init: Record<string, unknown>) => {
      const custom = handlers.GET?.(path, init);
      if (custom !== undefined) return Promise.resolve(custom);
      return Promise.resolve({ data: { messages: [] }, error: undefined });
    }),
    POST: vi.fn((path: string, init: Record<string, unknown>) => {
      const custom = handlers.POST?.(path, init);
      if (custom !== undefined) return Promise.resolve(custom);
      if (path === STORE_PATHS.messages) {
        return Promise.resolve({
          data: { messageId: "m-1", channelId, createdAt: "2026-10-10T10:00:00.000Z" },
          error: undefined,
          response: { status: 200 },
        });
      }
      return Promise.resolve({ data: {}, error: undefined });
    }),
  };
  const tree = (id: string, extra: Partial<ComponentProps<typeof ConversationThread>> = {}) => (
    <MemoryRouter>
      <ApiClientProvider client={api as unknown as ApiClient}>
        <ConversationThread
          channel={channel(id)}
          meId={ME}
          meDisplayName="Me"
          onBack={() => {}}
          onReadConfirmed={() => {}}
          onMessageSent={() => {}}
          onAccessRevoked={() => {}}
          {...extra}
        />
      </ApiClientProvider>
    </MemoryRouter>
  );
  const view = render(tree(channelId));
  return { api, view, tree };
}

export const calls = (api: { POST: ReturnType<typeof vi.fn> }, path: string) =>
  api.POST.mock.calls.filter(([p]) => p === path) as [string, Record<string, any>][];

export async function attach(files: File[]) {
  const input = (await screen.findByTestId("attachment-input")) as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { files } });
  });
}

export const chipList = () => screen.queryByRole("list", { name: "Attached files" });
export const sendButton = () => screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;

export let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
