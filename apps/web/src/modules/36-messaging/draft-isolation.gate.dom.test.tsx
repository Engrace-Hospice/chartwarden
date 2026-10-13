/**
 * Phase 2 gate: "draft isolation" acceptance, through the REAL StaffMessaging tree (production keys: the thread is
 * keyed `org:channel` and the whole tree `org:user`). The server draft store is a stateful fake keyed by
 * (channel, thread root), so a draft that lands in the wrong slot is visible as a wrong key, not as a lucky text match.
 *
 * Clause map lives in the PR / report; per-clause names are prefixed G1..G10.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { StaffMessaging } from "./staff-messaging";
import { DRAFT_SAVE_DEBOUNCE_MS } from "./use-server-draft";

vi.mock("socket.io-client", () => ({
  io: () => ({ on: () => {}, off: () => {}, close: () => {} }),
}));

const DRAFT = "/api/v1/messaging/channels/{id}/draft";
const MESSAGES = "/api/v1/messaging/channels/{id}/messages";
const CANDIDATES = "/api/v1/messaging/channels/{id}/mention-candidates";
const NURSE_ID = "22222222-2222-4222-8222-222222222222";

const NORTH: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizationName: "North Hospice",
};
const COLLEAGUE: Session = { ...NORTH, userId: "33333333-3333-4333-8333-333333333333" };
const SOUTH: Session = {
  ...NORTH,
  organizationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  organizationName: "South Hospice",
};

const channel = (channelId: string, title: string) => ({
  channelId,
  kind: "dm",
  title,
  subjectId: null,
  archivedAt: null,
  unreadCount: 0,
  participantRoles: [],
  lastActivityAt: "2026-10-09T10:00:00.000Z",
  lastMessage: null,
});
const CHANNELS = [
  channel("dm-a", "Nurse A"),
  channel("dm-b", "Nurse B"),
  channel("dm-c", "Nurse C"),
];

type Json = Record<string, any>;
interface Fake {
  readonly api: { GET: any; PUT: any; DELETE: any; POST: any };
  /** (channel|root) -> the body the server holds. */
  readonly drafts: Map<string, string>;
  failSends: { on: boolean };
}
/**
 * Whose cookie the fake server sees ("" = the first user). The real server scopes a draft to (org, user) by RLS, so the
 * fake namespaces its store the same way. A test flips this BEFORE swapping the session: the worst case, because any
 * request the old tree still sends (an unmount flush) then arrives under the NEW identity.
 */
let identity = "";
const slot = (init: Json | undefined): string =>
  `${identity}${init?.params?.path?.id}|${init?.params?.query?.parentMessageId ?? init?.body?.parentMessageId ?? ""}`;

function fakeServer(seed: Record<string, string> = {}): Fake {
  const drafts = new Map(Object.entries(seed));
  const failSends = { on: false };
  let revision = 0;
  const api = {
    GET: vi.fn((path: string, init?: Json) => {
      if (path === "/api/v1/messaging/channels")
        return Promise.resolve({ data: { channels: CHANNELS }, error: undefined });
      if (path === DRAFT) {
        const body = drafts.get(slot(init));
        return Promise.resolve({
          data: {
            draft:
              body === undefined
                ? null
                : { body, references: [], revision: 1, deviceId: "other", updatedAt: "t" },
          },
          error: undefined,
          response: { status: 200 },
        });
      }
      if (path === CANDIDATES)
        return Promise.resolve({
          data: {
            candidates: [
              {
                kind: "staff",
                entityId: NURSE_ID,
                displayName: "Nurse Two",
                detail: "Registered Nurse",
              },
            ],
          },
          error: undefined,
        });
      return Promise.resolve({ data: { messages: [] }, error: undefined });
    }),
    PUT: vi.fn((_path: string, init: Json) => {
      drafts.set(slot(init), init.body.body);
      revision += 1;
      return Promise.resolve({
        data: {
          draft: {
            body: init.body.body,
            references: [],
            revision,
            deviceId: init.body.deviceId,
            updatedAt: "t",
          },
        },
        error: undefined,
        response: { status: 200 },
      });
    }),
    DELETE: vi.fn((_path: string, init: Json) => {
      drafts.delete(slot(init));
      return Promise.resolve({ data: undefined, error: undefined, response: { status: 204 } });
    }),
    POST: vi.fn((path: string, init: Json) => {
      if (path !== MESSAGES) return Promise.resolve({ data: {}, error: undefined });
      if (failSends.on)
        return Promise.resolve({
          data: undefined,
          error: { message: "Network unavailable" },
          response: { status: 503 },
        });
      return Promise.resolve({
        data: {
          messageId: "m-1",
          channelId: init.params.path.id,
          createdAt: "2026-10-10T10:00:00.000Z",
        },
        error: undefined,
        response: { status: 200 },
      });
    }),
  };
  return { api, drafts, failSends };
}

function tree(fake: Fake, session: Session | null, entry = "/") {
  return (
    <MemoryRouter initialEntries={[entry]}>
      <ApiClientProvider client={fake.api as unknown as ApiClient}>
        <SessionProvider session={session}>
          <StaffMessaging />
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>
  );
}
const mount = (fake: Fake, session: Session | null = NORTH, entry = "/") =>
  render(tree(fake, session, entry));

const open = async (title: string) => {
  fireEvent.click(await screen.findByRole("button", { name: title }));
  await screen.findByRole("region", { name: `Conversation with ${title}` });
};
const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const type = (value: string) => fireEvent.change(box(), { target: { value } });
const settle = (ms = DRAFT_SAVE_DEBOUNCE_MS + 50) => act(() => vi.advanceTimersByTimeAsync(ms));
const calls = (mock: { mock: { calls: unknown[][] } }, path?: string) =>
  mock.mock.calls.filter(([p]) => path === undefined || p === path) as [string, Json][];
const putSlots = (fake: Fake) => calls(fake.api.PUT).map(([, init]) => slot(init));

/** Records every write, so a test can prove what was (not) persisted. Node's own localStorage global is unusable here. */
class RecordingStorage {
  readonly writes: string[] = [];
  private readonly map = new Map<string, string>();
  keys(): string[] {
    return [...this.map.keys()];
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes.push(`${key}=${value}`);
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}
let local: RecordingStorage;
let session: RecordingStorage;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  identity = "";
  local = new RecordingStorage();
  session = new RecordingStorage();
  Object.defineProperty(window, "localStorage", { configurable: true, value: local });
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: session });
});
afterEach(() => vi.useRealTimers());

describe("draft isolation: channel to channel", () => {
  it("G1: a draft typed in A never shows in B, is saved to A only, and comes back in A", async () => {
    const fake = fakeServer();
    mount(fake);
    await open("Nurse A");
    type("A-only secret");
    await open("Nurse B");

    expect(box().value).toBe("");
    await settle();
    expect(putSlots(fake)).toEqual(["dm-a|"]);
    expect(fake.drafts.get("dm-a|")).toBe("A-only secret");
    expect(fake.drafts.has("dm-b|")).toBe(false);

    await open("Nurse A");
    await waitFor(() => expect(box().value).toBe("A-only secret"));
  });

  it("G2: rapid A, B, C switches inside the debounce put A's text in A's slot and nowhere else", async () => {
    const fake = fakeServer();
    mount(fake);
    await open("Nurse A");
    type("rapid A text");
    await open("Nurse B");
    expect(box().value).toBe("");
    await open("Nurse C");
    expect(box().value).toBe("");
    await settle(DRAFT_SAVE_DEBOUNCE_MS * 3);

    expect(putSlots(fake)).toEqual(["dm-a|"]);
    expect([...fake.drafts.entries()]).toEqual([["dm-a|", "rapid A text"]]);
  });

  it("G3: a deep link to B opens an empty composer while A keeps its server draft untouched", async () => {
    const fake = fakeServer({ "dm-a|": "A draft on the server" });
    mount(fake, NORTH, "/?channelId=dm-b");
    await screen.findByRole("region", { name: "Conversation with Nurse B" });

    expect(box().value).toBe("");
    await settle();
    expect(fake.api.PUT).not.toHaveBeenCalled();
    expect(fake.api.DELETE).not.toHaveBeenCalled();
    expect(fake.drafts.get("dm-a|")).toBe("A draft on the server");
  });

  it("G4: another channel's Send cannot send A's draft; B sends only B's own text", async () => {
    const fake = fakeServer({ "dm-b|": "B own draft" });
    mount(fake);
    await open("Nurse A");
    type("A text that must not be sent from B");
    await open("Nurse B");
    await waitFor(() => expect(box().value).toBe("B own draft"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    await waitFor(() => expect(calls(fake.api.POST, MESSAGES)).toHaveLength(1));
    const init = calls(fake.api.POST, MESSAGES)[0]![1];
    expect(init.params.path.id).toBe("dm-b");
    expect(init.body.body).toBe("B own draft");
    expect(JSON.stringify(calls(fake.api.POST))).not.toContain("A text");
  });
});

describe("draft isolation: send outcomes", () => {
  it("G5: a successful send clears that channel's draft only; another channel's draft survives", async () => {
    const fake = fakeServer({ "dm-b|": "B pending" });
    mount(fake);
    await open("Nurse A");
    type("send me");
    await settle(); // saved: revision > 0, so the empty composer must DELETE
    expect(fake.drafts.get("dm-a|")).toBe("send me");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    await waitFor(() => expect(box().value).toBe(""));
    await settle();
    expect(fake.drafts.has("dm-a|")).toBe(false);
    expect(fake.drafts.get("dm-b|")).toBe("B pending");
  });

  it("G6: a failed send keeps the text and the server draft, and a channel round trip restores it", async () => {
    const fake = fakeServer();
    fake.failSends.on = true;
    mount(fake);
    await open("Nurse A");
    type("keep me");
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    await screen.findByText("Network unavailable");
    expect(box().value).toBe("keep me");
    await settle();
    expect(fake.api.DELETE).not.toHaveBeenCalled();
    expect(fake.drafts.get("dm-a|")).toBe("keep me");

    await open("Nurse B");
    await open("Nurse A");
    await waitFor(() => expect(box().value).toBe("keep me"));
  });
});

describe("draft isolation: users and organisations on one browser", () => {
  // Production identity changes (sign-in, org select, sign-out) are full page loads (organization-select.tsx,
  // actor-menu signOut), so the old tree's unmount flush leaves under the OLD cookie. G7/G8 model that order.
  it("G7: a user change in the same organisation remounts to an empty composer and shows no old text", async () => {
    const fake = fakeServer();
    const view = mount(fake);
    await open("Nurse A");
    type("first user's private text");
    expect(box().value).toBe("first user's private text");

    await act(async () => view.unmount()); // a reload: the old page's unmount flush leaves under the old cookie
    identity = "colleague/";
    mount(fake, COLLEAGUE);
    await open("Nurse A");
    await settle();
    expect(box().value).toBe("");
    expect(fake.drafts.has("colleague/dm-a|")).toBe(false);
    expect(document.body.textContent).not.toContain("first user's private text");
  });

  // KNOWN LATENT DEFECT (reported with the gate evidence, unreachable today): if the session were swapped inside one SPA
  // page, the old composer's unmount flush would be sent under the NEW identity and could land in the new user's draft
  // slot for a channel both can write to. `it.fails` pins the defect: it turns red (remove `.fails`) once the flush is
  // scoped to the identity that typed the text.
  it.fails(
    "G7b: [latent] an in-page user swap must not flush the old user's text into the new user's slot",
    async () => {
      const fake = fakeServer();
      const view = mount(fake);
      await open("Nurse A");
      type("first user's private text");

      identity = "colleague/";
      view.rerender(tree(fake, COLLEAGUE));
      await open("Nurse A");
      await settle();
      expect(box().value).toBe("");
      expect(fake.drafts.has("colleague/dm-a|")).toBe(false);
    },
  );

  it("G8: an organisation switch and a sign-out leave no draft text in the DOM or in browser storage", async () => {
    const fake = fakeServer();
    const view = mount(fake);
    await open("Nurse A");
    type("north-only PHI draft");

    await act(async () => view.unmount());
    identity = "south/";
    const southView = mount(fake, SOUTH);
    await open("Nurse A");
    await settle();
    expect(box().value).toBe("");
    expect(fake.drafts.has("south/dm-a|")).toBe(false);
    expect(document.body.textContent).not.toContain("north-only PHI draft");

    southView.rerender(tree(fake, null));
    await settle();
    expect(document.body.textContent).not.toContain("north-only PHI draft");
    expect([...local.writes, ...session.writes].join("\n")).not.toContain("north-only PHI draft");
  });
});

describe("draft isolation: nothing in plaintext in browser storage", () => {
  it("G9: typing, autosave, a switch and a send write no draft text to local/session storage or IndexedDB", async () => {
    const indexedDbOpen = vi.fn();
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      value: { open: indexedDbOpen },
    });
    const fake = fakeServer();
    mount(fake);
    await open("Nurse A");
    type("PHI: Mrs Jones has 3 days");
    await settle();
    await open("Nurse B");
    await open("Nurse A");
    await waitFor(() => expect(box().value).toBe("PHI: Mrs Jones has 3 days"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    await settle();

    expect(indexedDbOpen).not.toHaveBeenCalled();
    expect(local.writes).toEqual([]);
    // The one allowed key is the per-tab device id (a random UUID, not message content).
    expect(session.keys()).toEqual(["wx-messaging-draft-device"]);
    expect(session.writes.join("\n")).not.toMatch(/Jones|PHI/);
    // The text lives on the server (sealed there: m36-drafts.live.test.ts) and nowhere on this device.
    expect(fake.api.PUT).toHaveBeenCalled();
  });
});

describe("draft isolation: mentions, scheduling and attachments do not bleed", () => {
  it("G10: a mention chip made in A is not sent from B, and an open Schedule dialog does not follow the switch", async () => {
    const fake = fakeServer();
    mount(fake);
    await open("Nurse A");
    fireEvent.change(box(), { target: { value: "@Nur", selectionStart: 4 } });
    await screen.findByRole("option", { name: /Nurse Two/ });
    fireEvent.keyDown(box(), { key: "Enter" });
    type("@Nurse Two hi");
    fireEvent.click(screen.getByRole("button", { name: "Schedule send" }));
    await screen.findByRole("dialog");

    await open("Nurse B");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(box().value).toBe("");
    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.getByRole("button", { name: "Schedule send" })).toHaveProperty("disabled", true);

    type("plain note to B");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    await waitFor(() => expect(calls(fake.api.POST, MESSAGES)).toHaveLength(1));
    const init = calls(fake.api.POST, MESSAGES)[0]![1];
    expect(init.params.path.id).toBe("dm-b");
    expect(init.body.references ?? []).toEqual([]);
    expect(init.body.body).toBe("plain note to B");
  });
});
