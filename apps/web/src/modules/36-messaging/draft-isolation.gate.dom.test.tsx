/**
 * Phase 2 gate: "draft isolation" acceptance, through the REAL StaffMessaging tree (production keys: the thread is
 * keyed `org:channel` and the whole tree `org:user`). The server draft store is a stateful fake keyed by
 * (channel, thread root), so a draft that lands in the wrong slot is visible as a wrong key, not as a lucky text match.
 *
 * Clause map lives in the PR / report; per-clause names are prefixed G1..G10.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
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
  /** (channel|root) -> the mention references the server holds with that draft. */
  readonly draftRefs: Map<string, Json[]>;
  /** The store key of every PUT, taken under the identity current when the request ARRIVED. */
  readonly putKeys: string[];
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
  const draftRefs = new Map<string, Json[]>();
  const putKeys: string[] = [];
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
                : {
                    body,
                    references: draftRefs.get(slot(init)) ?? [],
                    revision: 1,
                    deviceId: "other",
                    updatedAt: "t",
                  },
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
      putKeys.push(slot(init));
      drafts.set(slot(init), init.body.body);
      draftRefs.set(slot(init), init.body.references ?? []);
      revision += 1;
      return Promise.resolve({
        data: {
          draft: {
            body: init.body.body,
            references: init.body.references ?? [],
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
      draftRefs.delete(slot(init));
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
      // The real server deletes the author's draft in the same transaction as the message, so the client need not.
      drafts.delete(slot(init));
      draftRefs.delete(slot(init));
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
  return { api, drafts, draftRefs, putKeys, failSends };
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

/**
 * Deterministic timers: nothing advances unless a test says so (`settle`), so "inside the debounce" means zero virtual
 * milliseconds, not "fast enough". Testing Library's own polling cannot run on a faked clock, so waits retry a
 * synchronous assertion after flushing promises with a 0 ms advance.
 */
const UNTIL_ATTEMPTS = 200;
const until = async (assertion: () => void): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      if (attempt >= UNTIL_ATTEMPTS) throw error;
      await act(() => vi.advanceTimersByTimeAsync(0));
    }
  }
};
const open = async (title: string) => {
  await until(() => screen.getByRole("button", { name: title }));
  fireEvent.click(screen.getByRole("button", { name: title }));
  await until(() => screen.getByRole("region", { name: `Conversation with ${title}` }));
};
const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const type = (value: string) => fireEvent.change(box(), { target: { value } });
/** Text on screen INCLUDING what sits in textareas and inputs (textContent cannot see a field's value). */
const visibleText = (): string =>
  [
    document.body.textContent ?? "",
    ...Array.from(
      document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>("textarea,input"),
    ).map((field) => field.value),
  ].join("\n");
const settle = (ms = DRAFT_SAVE_DEBOUNCE_MS + 50) => act(() => vi.advanceTimersByTimeAsync(ms));
const calls = (mock: { mock: { calls: unknown[][] } }, path?: string) =>
  mock.mock.calls.filter(([p]) => path === undefined || p === path) as [string, Json][];
/** Clicks Send and waits until the fake server has seen `count` message POSTs. */
const send = async (fake: Fake, count = 1) => {
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await until(() => expect(calls(fake.api.POST, MESSAGES)).toHaveLength(count));
};
const putSlots = (fake: Fake) => calls(fake.api.PUT).map(([, init]) => slot(init));

/** Records EVERY mutation (set, remove, clear), so a test can prove what was (not) persisted. Node's own localStorage global is unusable here. */
class RecordingStorage {
  /** Every mutation, as `set key=value`, `remove key` or `clear`. */
  readonly mutations: string[] = [];
  private readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
  key(index: number): string | null {
    return this.keys()[index] ?? null;
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.mutations.push(`set ${key}=${value}`);
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.mutations.push(`remove ${key}`);
    this.map.delete(key);
  }
  clear(): void {
    this.mutations.push("clear");
    this.map.clear();
  }
}
let local: RecordingStorage;
let session: RecordingStorage;
const WINDOW_GLOBALS = ["localStorage", "sessionStorage", "indexedDB"] as const;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  vi.useFakeTimers();
  identity = "";
  local = new RecordingStorage();
  session = new RecordingStorage();
  for (const name of WINDOW_GLOBALS)
    savedGlobals.set(name, Object.getOwnPropertyDescriptor(window, name));
  Object.defineProperty(window, "localStorage", { configurable: true, value: local });
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: session });
});
afterEach(() => {
  cleanup(); // unmount while the fake clock is still installed, so no pending real timer outlives the test
  vi.useRealTimers();
  for (const name of WINDOW_GLOBALS) {
    const original = savedGlobals.get(name);
    if (original) Object.defineProperty(window, name, original);
    else Reflect.deleteProperty(window, name);
  }
});

const TEXT_A = "A-only secret";

describe("draft isolation: channel to channel", () => {
  it("G1: a draft typed in A never shows in B, is saved to A only, and comes back in A", async () => {
    const fake = fakeServer();
    mount(fake);
    await open("Nurse A");
    type(TEXT_A);
    await open("Nurse B");

    expect(box().value).toBe("");
    await settle();
    expect(putSlots(fake)).toEqual(["dm-a|"]);
    expect(fake.drafts.get("dm-a|")).toBe(TEXT_A);
    expect(fake.drafts.has("dm-b|")).toBe(false);

    await open("Nurse A");
    await until(() => expect(box().value).toBe(TEXT_A));
  });

  it("G2: rapid A, B, C switches inside the debounce put A's text in A's slot and nowhere else", async () => {
    const fake = fakeServer();
    mount(fake);
    await open("Nurse A");
    type("rapid A text");
    expect(fake.api.PUT).not.toHaveBeenCalled(); // inside the debounce: no virtual time has passed
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
    await until(() => screen.getByRole("region", { name: "Conversation with Nurse B" }));

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
    expect(fake.api.PUT).not.toHaveBeenCalled(); // inside the debounce: no virtual time has passed
    await open("Nurse B");
    await until(() => expect(box().value).toBe("B own draft"));

    await send(fake);
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
    await settle(); // saved to the server first, so "gone afterwards" is observable
    expect(fake.drafts.get("dm-a|")).toBe("send me");

    await send(fake);
    await until(() => expect(box().value).toBe(""));
    await settle();
    // The server deletes the draft with the message (the fake does too); the end state is what the user sees.
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
    await send(fake);
    await until(() => screen.getByText("Network unavailable"));
    expect(box().value).toBe("keep me");
    await settle();
    expect(fake.api.DELETE).not.toHaveBeenCalled();
    expect(fake.drafts.get("dm-a|")).toBe("keep me");

    await open("Nurse B");
    await open("Nurse A");
    await until(() => expect(box().value).toBe("keep me"));
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
    expect(visibleText()).not.toContain("first user's private text");
  });

  // An in-page session swap (not a production path today: identity changes are full page loads) must still never
  // write the old user's text under the new identity: the unmount flush is skipped when the identity changed.
  it("G7b: an in-page user swap flushes nothing under the new identity and leaks no text into the new composer", async () => {
    const fake = fakeServer();
    const view = mount(fake);
    await open("Nurse A");
    type("first user's private text");
    // Controls: the text is in the mounted composer and the debounce has not fired, so nothing is saved yet.
    expect(box().value).toBe("first user's private text");
    expect(fake.api.PUT).not.toHaveBeenCalled();

    identity = "colleague/";
    view.rerender(tree(fake, COLLEAGUE));
    await open("Nurse A");
    await settle();
    expect(box()).toBeTruthy(); // the new user's composer is mounted and usable

    // Each path is its own expectation, so a regression names the one that leaks.
    const leakedIntoSlot = fake.drafts.has("colleague/dm-a|");
    const leakedIntoBox = box().value !== "";
    expect(leakedIntoSlot, "unmount flush wrote the old text into the new user's server slot").toBe(
      false,
    );
    expect(leakedIntoBox, "the new user's composer re-hydrated the old user's text").toBe(false);
    expect(visibleText()).not.toContain("first user's private text");
    // The old text was never sent at all, under either identity.
    expect(fake.putKeys).toEqual([]);
  });

  it("G8: an organisation switch and a sign-out leave no draft text in the DOM, the server slots or browser storage", async () => {
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
    expect(visibleText()).not.toContain("north-only PHI draft");

    // South types, then signs out. Sign-out is a full page load in production (actor-menu signOut), so the old tree
    // unmounts first and its flush leaves under South's cookie; the signed-out page then mounts under no identity.
    // (An in-page session swap is covered by G7b: the flush is skipped rather than sent under the new identity.)
    type("south-only PHI draft");
    expect(box().value).toBe("south-only PHI draft");
    const putsBefore = fake.putKeys.length;
    await act(async () => southView.unmount());
    identity = "signed-out/";
    mount(fake, null);
    // Control: the signed-out tree really rendered (its inbox is there and a conversation opens with a composer).
    await open("Nurse A");
    await settle();
    expect(box().value).toBe("");
    expect(visibleText()).not.toContain("south-only PHI draft");
    expect(visibleText()).not.toContain("north-only PHI draft");
    // Every write after South typed was made as South; nothing was written for the signed-out identity.
    expect(fake.putKeys.slice(putsBefore)).toEqual(["south/dm-a|"]);
    expect([...fake.drafts.keys()].filter((key) => key.startsWith("signed-out/"))).toEqual([]);
    expect([...local.mutations, ...session.mutations].join("\n")).not.toMatch(/PHI draft/);
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
    await until(() => expect(box().value).toBe("PHI: Mrs Jones has 3 days"));
    await send(fake);
    await settle();

    expect(indexedDbOpen).not.toHaveBeenCalled();
    expect(local.mutations).toEqual([]);
    // The one allowed key is the per-tab device id (a random UUID, not message content).
    expect(session.keys()).toEqual(["wx-messaging-draft-device"]);
    expect(session.mutations.join("\n")).not.toMatch(/Jones|PHI/);
    // The text lives on the server (sealed there: m36-drafts.live.test.ts) and nowhere on this device.
    expect(fake.api.PUT).toHaveBeenCalled();
  });
});

describe("draft isolation: mentions and scheduling do not bleed", () => {
  it("G10: a mention chip made in A is saved with A's draft only, is not sent from B, and an open Schedule dialog does not follow the switch", async () => {
    const fake = fakeServer();
    mount(fake);
    await open("Nurse A");
    fireEvent.change(box(), { target: { value: "@Nur", selectionStart: 4 } });
    await settle(300); // past the 250 ms mention-lookup debounce, still inside the 1500 ms draft debounce
    await until(() => screen.getByRole("option", { name: /Nurse Two/ }));
    fireEvent.keyDown(box(), { key: "Enter" });
    type("@Nurse Two hi");
    fireEvent.click(screen.getByRole("button", { name: "Schedule send" }));
    await until(() => screen.getByRole("dialog"));

    // Positive control: the chip really exists on A's side. Saved, it carries exactly the one reference to the nurse.
    await settle();
    const aPuts = calls(fake.api.PUT).filter(([, init]) => slot(init) === "dm-a|");
    expect(aPuts.length).toBeGreaterThan(0);
    const aRefs = aPuts[aPuts.length - 1]![1].body.references as Json[];
    expect(aRefs).toHaveLength(1);
    expect(aRefs[0]).toMatchObject({ kind: "staff", entityId: NURSE_ID });
    expect(fake.draftRefs.get("dm-a|")).toHaveLength(1);

    await open("Nurse B");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(box().value).toBe(""); // B hydrated from a slot with no draft, hence with no chip
    expect(fake.draftRefs.has("dm-b|")).toBe(false);
    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.getByRole("button", { name: "Schedule send" })).toHaveProperty("disabled", true);

    type("plain note to B");
    await send(fake);
    const init = calls(fake.api.POST, MESSAGES)[0]![1];
    expect(init.params.path.id).toBe("dm-b");
    expect(init.body.references ?? []).toEqual([]);
    expect(init.body.body).toBe("plain note to B");
  });
});
