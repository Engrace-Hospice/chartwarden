// M36 WP 3.3: the SBAR form inside the real thread composer: offered only when the flag is on and the channel allows it,
// accessible roles and keyboard, the emergency-path note always shown, urgency default per channel kind, server field
// errors mapped to sections, and the text kept when the form is cancelled.
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiClientProvider, FeatureFlagProvider } from "@wardenx/ui";
import type { ReactNode } from "react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { SbarFormDialog } from "./sbar-form-dialog";
import { buildSbarBody, emptySbarValues } from "./sbar-utils";
import { SBAR_FLAG_KEY } from "./sbar-utils";
import { StaffMessaging } from "./staff-messaging";
import type { AttachmentUploads } from "./use-attachment-upload";
import { useMessageSender } from "./use-message-sender";
import { type SbarPolicyView, parseSbarPolicy } from "./use-sbar-policy";

vi.mock("socket.io-client", () => ({
  io: () => ({ on: () => {}, off: () => {}, close: () => {} }),
}));

const SESSION: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizationName: "North Hospice",
};
const PATIENT = "44444444-4444-4444-8444-444444444444";
const POLICY = {
  minChars: { situation: 5, background: 1, assessment: 1, recommendation: 1 },
  maxChars: 2000,
  requirePatientChannel: false,
  hints: { situation: "Agency wording for situation" },
  customized: true,
};
const SECTIONS = {
  situation: "Pain is uncontrolled",
  background: "Cancer, day 3 of care",
  assessment: "Likely breakthrough",
  recommendation: "Call me within the hour",
};
const NOTE =
  "Messaging is not the emergency path. For critical symptoms follow the agency telephone/emergency procedure.";

const channel = (kind: string, subjectId: string | null) => ({
  channelId: "ch-1",
  kind,
  title: "Team",
  subjectId,
  archivedAt: null,
  unreadCount: 0,
  participantRoles: [],
  lastActivityAt: "2026-10-09T10:00:00.000Z",
  lastMessage: null,
});

interface MountOptions {
  kind?: string;
  subjectId?: string | null;
  flag?: boolean;
  policy?: Record<string, unknown> | "404";
  post?: () => Promise<unknown>;
  /** Adds a second channel titled "Other". */
  second?: boolean;
}

function mount({
  kind = "discipline",
  subjectId = null,
  flag = true,
  policy = POLICY,
  post,
  second = false,
}: MountOptions = {}) {
  const POST = vi.fn(
    post ??
      (() =>
        Promise.resolve({
          data: { messageId: "m-1", channelId: "ch-1", createdAt: "2026-10-10T10:00:00.000Z" },
          error: undefined,
        })),
  );
  const GET = vi.fn((path: string) => {
    if (path === "/api/v1/messaging/channels")
      return Promise.resolve({
        data: {
          channels: [
            channel(kind, subjectId),
            ...(second ? [{ ...channel(kind, subjectId), channelId: "ch-2", title: "Other" }] : []),
          ],
        },
        error: undefined,
      });
    if (path === "/api/v1/messaging/sbar/policy")
      return policy === "404"
        ? Promise.resolve({ data: undefined, error: {}, response: { status: 404 } })
        : Promise.resolve({ data: policy, error: undefined, response: { status: 200 } });
    if (path === "/api/v1/messaging/templates")
      return Promise.resolve({ data: { items: [] }, error: undefined });
    if (path === "/api/v1/patients/{id}")
      return Promise.resolve({ data: undefined, error: {}, response: { status: 404 } });
    return Promise.resolve({ data: { messages: [] }, error: undefined });
  });
  render(
    <MemoryRouter>
      <ApiClientProvider client={{ GET, POST } as unknown as ApiClient}>
        <FeatureFlagProvider flags={{ [SBAR_FLAG_KEY]: flag }}>
          <SessionProvider session={SESSION}>
            <StaffMessaging />
          </SessionProvider>
        </FeatureFlagProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { POST, GET };
}

const failure = (status: number, code: string, message: string) => ({
  data: undefined,
  error: { error: { code, message } },
  response: { status },
});
const toggle = async () => screen.findByRole("button", { name: "Saved replies" });
async function openForm() {
  await userEvent.click(await toggle());
  await userEvent.click(await screen.findByRole("option", { name: /SBAR/ }));
  return screen.findByRole("dialog", { name: "SBAR message" });
}
const field = (dialog: HTMLElement, name: string) =>
  within(dialog).getByRole("textbox", { name }) as HTMLTextAreaElement;
async function fillAll(dialog: HTMLElement) {
  for (const [name, text] of [
    ["Situation", "Pain is uncontrolled"],
    ["Background", "Cancer, day 3 of care"],
    ["Assessment", "Likely breakthrough"],
    ["Recommendation", "Call me within the hour"],
  ] as const) {
    fireEvent.change(field(dialog, name), { target: { value: text } });
  }
}

describe("SBAR item in the picker", () => {
  it("is the first option when the flag is on and the channel allows it", async () => {
    mount();
    await userEvent.click(await toggle());
    await waitFor(() => expect(screen.getAllByRole("option")[0]?.textContent).toContain("SBAR"));
  });

  it("is hidden when the flag is off, and the policy is not even requested", async () => {
    const { GET } = mount({ flag: false });
    await userEvent.click(await toggle());
    expect(screen.queryByRole("option", { name: /SBAR/ })).toBeNull();
    expect(GET).not.toHaveBeenCalledWith("/api/v1/messaging/sbar/policy");
  });

  it("is hidden when the server says SBAR is off (404)", async () => {
    mount({ policy: "404" });
    await userEvent.click(await toggle());
    await screen.findByText(/No saved replies yet/);
    expect(screen.queryByRole("option", { name: /SBAR/ })).toBeNull();
  });

  it("never asks for the policy in an announcement channel (its composer is admin-only)", async () => {
    const { GET } = mount({ kind: "announcement" });
    await screen.findByText(/Only administrators can post announcements/);
    expect(GET).not.toHaveBeenCalledWith("/api/v1/messaging/sbar/policy");
  });

  it("is hidden in a bereavement channel", async () => {
    const { GET } = mount({ kind: "bereavement" });
    await userEvent.click(await toggle());
    await screen.findByText(/No saved replies yet/);
    expect(screen.queryByRole("option", { name: /SBAR/ })).toBeNull();
    expect(GET).not.toHaveBeenCalledWith("/api/v1/messaging/sbar/policy");
  });

  it("with requirePatientChannel is offered only in care_team", async () => {
    const policy = { ...POLICY, requirePatientChannel: true };
    mount({ kind: "discipline", policy });
    await userEvent.click(await toggle());
    await screen.findByText(/No saved replies yet/);
    expect(screen.queryByRole("option", { name: /SBAR/ })).toBeNull();
  });

  it("with requirePatientChannel is offered in care_team", async () => {
    mount({
      kind: "care_team",
      subjectId: PATIENT,
      policy: { ...POLICY, requirePatientChannel: true },
    });
    await openForm();
  });
});

describe("SBAR form", () => {
  it("is a labelled modal with four labelled sections, hints and live counters", async () => {
    mount();
    const dialog = await openForm();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const situation = field(dialog, "Situation");
    expect(situation.getAttribute("aria-describedby")).toBeTruthy();
    const described = situation
      .getAttribute("aria-describedby")
      ?.split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    expect(described?.[0]).toBe("Agency wording for situation");
    expect(described?.[1]).toBe("0 / 5");
    fireEvent.change(situation, { target: { value: "abc" } });
    expect(within(dialog).getByText("3 / 5")).toBeTruthy();
    // Platform wording where the tenant set none.
    expect(within(dialog).getByText("Relevant history and context.")).toBeTruthy();
  });

  it("always shows the emergency-path note, and the urgent note only when urgent is chosen", async () => {
    mount();
    const dialog = await openForm();
    expect(within(dialog).getByText(NOTE)).toBeTruthy();
    expect(within(dialog).queryByText(/does not page or escalate/)).toBeNull();
    await userEvent.click(within(dialog).getByRole("radio", { name: "Urgent" }));
    expect(within(dialog).getByText(NOTE)).toBeTruthy();
    expect(
      within(dialog).getByText("Marking urgent does not page or escalate anyone."),
    ).toBeTruthy();
  });

  it("defaults urgency to routine, and to important in an on-call channel", async () => {
    mount({ kind: "discipline" });
    let dialog = await openForm();
    expect(
      (within(dialog).getByRole("radio", { name: "Routine" }) as HTMLInputElement).checked,
    ).toBe(true);
    cleanup();
    mount({ kind: "on_call" });
    dialog = await openForm();
    expect(
      (within(dialog).getByRole("radio", { name: "Important" }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("moves focus into the dialog, traps Tab, and Escape returns focus to the picker", async () => {
    mount();
    const dialog = await openForm();
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Modal's Tab trap: shift+Tab never leaves the dialog.
    await userEvent.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "SBAR message" })).toBeNull());
    expect(document.activeElement).toBe(await toggle());
  });

  it("keeps focus inside the dialog after a generic send failure, and Escape still closes it", async () => {
    let reply: (value: unknown) => void = () => {};
    mount({
      post: () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    });
    const dialog = await openForm();
    await fillAll(dialog);
    const last = field(dialog, "Recommendation");
    last.focus();
    fireEvent.keyDown(last, { key: "Enter", ctrlKey: true });
    // jsdom keeps focus on a control that becomes disabled; a browser drops it to <body>. Do what the browser does.
    await waitFor(() => expect(last.disabled).toBe(true));
    last.disabled = false; // jsdom cannot blur a disabled control
    last.blur();
    last.disabled = true;
    expect(document.activeElement).toBe(document.body);
    await act(async () => reply(failure(500, "GENERIC", "Something broke")));
    await within(dialog).findByText("Something broke");
    const active = document.activeElement as HTMLElement;
    expect(dialog.contains(active)).toBe(true);
    expect(active.matches(":enabled")).toBe(true);
    expect(last.value).toBe("Call me within the hour");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "SBAR message" })).toBeNull());
  });

  it("clears the stale send error as soon as a section is edited", async () => {
    mount({ post: () => Promise.resolve(failure(500, "GENERIC", "Something broke")) });
    const dialog = await openForm();
    await fillAll(dialog);
    await userEvent.click(within(dialog).getByRole("button", { name: "Send SBAR" }));
    await within(dialog).findByText("Something broke");
    await userEvent.type(field(dialog, "Situation"), "!");
    expect(within(dialog).queryByText("Something broke")).toBeNull();
  });

  it("keeps the text on Cancel and restores it on reopen; Discard forgets it", async () => {
    mount();
    let dialog = await openForm();
    fireEvent.change(field(dialog, "Situation"), { target: { value: "Keep this text" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "SBAR message" })).toBeNull();
    expect(document.activeElement).toBe(await toggle());
    dialog = await openForm();
    expect(field(dialog, "Situation").value).toBe("Keep this text");
    await userEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    dialog = await openForm();
    expect(field(dialog, "Situation").value).toBe("");
  });

  it("checks lengths on the client, focuses the first invalid section and does not send", async () => {
    const { POST } = mount();
    const dialog = await openForm();
    fireEvent.change(field(dialog, "Situation"), { target: { value: "abc" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Send SBAR" }));
    expect(POST).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field(dialog, "Situation"));
    expect(field(dialog, "Situation").getAttribute("aria-invalid")).toBe("true");
    expect(within(dialog).getByText("Situation must be at least 5 characters")).toBeTruthy();
    expect(within(dialog).getByText("Background is required")).toBeTruthy();
  });

  it("sends a closed sbar body on Ctrl+Enter and closes", async () => {
    const { POST } = mount({ kind: "on_call" });
    const dialog = await openForm();
    await fillAll(dialog);
    fireEvent.keyDown(field(dialog, "Recommendation"), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    const [path, init] = POST.mock.calls[0] as unknown as [
      string,
      { params: { header: Record<string, string> }; body: Record<string, unknown> },
    ];
    expect(path).toBe("/api/v1/messaging/channels/{id}/messages");
    expect(init.params.header["Idempotency-Key"]).toBeTruthy();
    expect(init.body.clientMessageId).toBeTruthy();
    expect(init.body.body).toBeUndefined();
    const block = (init.body.bodyDoc as { doc: { content: Record<string, unknown>[] } }).doc
      .content;
    expect(block).toHaveLength(1);
    expect(block[0]?.type).toBe("sbar");
    expect(block[0]?.urgencyHint).toBe("important");
    expect(block[0]?.situation).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "Pain is uncontrolled" }] },
    ]);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "SBAR message" })).toBeNull());
  });

  it("maps server field errors to their sections, focuses the first, and keeps the text", async () => {
    mount({
      post: () =>
        Promise.resolve({
          data: undefined,
          error: {
            error: {
              code: "SBAR_INVALID",
              message: "SBAR is invalid",
              details: [
                {
                  field: "sbar.assessment",
                  code: "TOO_SHORT",
                  message: "must be at least 40 characters",
                },
                { field: "sbar.background", code: "REQUIRED", message: "is required" },
              ],
            },
          },
          response: { status: 422 },
        }),
    });
    const dialog = await openForm();
    await fillAll(dialog);
    await userEvent.click(within(dialog).getByRole("button", { name: "Send SBAR" }));
    await waitFor(() =>
      expect(within(dialog).getByText("Assessment must be at least 40 characters")).toBeTruthy(),
    );
    expect(within(dialog).getByText("Background is required")).toBeTruthy();
    expect(document.activeElement).toBe(field(dialog, "Background"));
    expect(field(dialog, "Assessment").getAttribute("aria-invalid")).toBe("true");
    expect(field(dialog, "Assessment").value).toBe("Likely breakthrough");
    expect(
      within(dialog).getByText("Some SBAR sections need attention. Your text is still here."),
    ).toBeTruthy();
  });

  it.each([
    ["SBAR_NOT_ALLOWED_IN_CHANNEL", "SBAR messages can't be sent in this conversation."],
    ["SBAR_NOT_AVAILABLE", "SBAR messages aren't available right now."],
  ])("shows a short message for %s without saying why", async (code, text) => {
    mount({
      post: () =>
        Promise.resolve({
          data: undefined,
          error: { error: { code, message: "server detail that must not be shown" } },
          response: { status: 422 },
        }),
    });
    const dialog = await openForm();
    await fillAll(dialog);
    await userEvent.click(within(dialog).getByRole("button", { name: "Send SBAR" }));
    await waitFor(() => expect(within(dialog).getByText(text)).toBeTruthy());
    expect(screen.queryByText(/server detail/)).toBeNull();
    expect(field(dialog, "Situation").value).toBe("Pain is uncontrolled");
  });
});

describe("SBAR dialog focus, on its own (Modal's restore, not the composer's)", () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    const [values, setValues] = useState(emptySbarValues("discipline"));
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Opener
        </button>
        {open ? (
          <SbarFormDialog
            policy={parseSbarPolicy(POLICY) as SbarPolicyView}
            values={values}
            onChange={setValues}
            sending={false}
            serverIssues={[]}
            sendError={null}
            onEdit={() => {}}
            onSubmit={() => {}}
            onCancel={() => setOpen(false)}
            onDiscard={() => setOpen(false)}
          />
        ) : null}
      </>
    );
  }

  it("Escape closes and Modal itself returns focus to the element that opened it", async () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Opener" });
    await userEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "SBAR message" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "SBAR message" })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("SBAR send outcomes", () => {
  const sentInits = (POST: ReturnType<typeof mount>["POST"]) =>
    (POST.mock.calls as unknown as unknown[][]).map(
      (call) =>
        call[1] as {
          params: { header: Record<string, string> };
          body: { clientMessageId: string };
        },
    );

  it("a network failure queues the SBAR in the outbox, closes the dialog and clears the form", async () => {
    const { POST } = mount({ post: () => Promise.reject(new TypeError("Failed to fetch")) });
    const dialog = await openForm();
    await fillAll(dialog);
    await userEvent.click(within(dialog).getByRole("button", { name: "Send SBAR" }));
    await screen.findByText("Not sent");
    expect(screen.queryByRole("dialog", { name: "SBAR message" })).toBeNull();
    expect(POST).toHaveBeenCalledTimes(1);
    // The composer refocuses its textarea on the next frame; let that land before reopening.
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
    const reopened = await openForm();
    expect(field(reopened, "Situation").value).toBe("");
    expect(field(reopened, "Recommendation").value).toBe("");
  });

  it("a lost reply is retried from the outbox under the same Idempotency-Key and clientMessageId", async () => {
    let call = 0;
    const { POST } = mount({
      post: () =>
        ++call === 1
          ? Promise.reject(new TypeError("Failed to fetch"))
          : Promise.resolve({
              data: { messageId: "m-9", channelId: "ch-1", createdAt: "2026-10-10T10:00:00.000Z" },
              error: undefined,
              response: { status: 200 },
            }),
    });
    const dialog = await openForm();
    await fillAll(dialog);
    await userEvent.click(within(dialog).getByRole("button", { name: "Send SBAR" }));
    await screen.findByText("Not sent");
    await userEvent.click(screen.getByRole("button", { name: "Retry sending message" }));
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(2));
    const [first, second] = sentInits(POST);
    expect(second?.params.header["Idempotency-Key"]).toBe(first?.params.header["Idempotency-Key"]);
    expect(second?.body.clientMessageId).toBe(first?.body.clientMessageId);
  });

  it("rotates the Idempotency-Key after an answered 422 but keeps the clientMessageId", async () => {
    let call = 0;
    const { POST } = mount({
      post: () =>
        ++call === 1
          ? Promise.resolve(failure(422, "SBAR_NOT_AVAILABLE", "x"))
          : Promise.resolve({
              data: { messageId: "m-9", channelId: "ch-1", createdAt: "2026-10-10T10:00:00.000Z" },
              error: undefined,
              response: { status: 200 },
            }),
    });
    const dialog = await openForm();
    await fillAll(dialog);
    await userEvent.click(within(dialog).getByRole("button", { name: "Send SBAR" }));
    await within(dialog).findByText("SBAR messages aren't available right now.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send SBAR" }));
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(2));
    const [first, second] = sentInits(POST);
    expect(second?.params.header["Idempotency-Key"]).not.toBe(
      first?.params.header["Idempotency-Key"],
    );
    expect(second?.body.clientMessageId).toBe(first?.body.clientMessageId);
  });

  it("keeps each channel's SBAR text separate", async () => {
    mount({ second: true });
    let dialog = await openForm();
    fireEvent.change(field(dialog, "Situation"), {
      target: { value: "Text for the first channel" },
    });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await userEvent.click(await screen.findByRole("button", { name: /Other/ }));
    await screen.findByRole("region", { name: /Other/ });
    dialog = await openForm();
    expect(field(dialog, "Situation").value).toBe("");
  });

  it("with no outbox, a failed send keeps the attempt and reports the failure (hook level)", async () => {
    const POST = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    const onSettled = vi.fn();
    const uploads = {
      sendableIds: [],
      blocksSend: false,
      chips: [],
      reset: vi.fn(),
      recheck: vi.fn(),
    } as unknown as AttachmentUploads;
    const { result } = renderHook(
      () =>
        useMessageSender({
          channelId: "ch-1",
          archived: false,
          draft: "",
          draftReferences: [],
          uploads,
          generationRef: { current: 0 },
          onSent: vi.fn(),
          onSettled,
        }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <ApiClientProvider client={{ POST } as unknown as ApiClient}>
            {children}
          </ApiClientProvider>
        ),
      },
    );
    const body = buildSbarBody({ ...emptySbarValues("discipline"), sections: SECTIONS });
    await act(async () => result.current.send(undefined, body));
    await act(async () => result.current.send(undefined, body));
    expect(result.current.sendError).toMatch(/draft has been preserved/);
    expect(onSettled).toHaveBeenCalledWith(false, expect.any(String));
    const keys = (POST.mock.calls as unknown as [string, any][]).map(
      ([, init]) => init.params.header["Idempotency-Key"],
    );
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });
});

describe("a policy the client cannot trust", () => {
  it.each([
    ["an object", {}],
    ["an array", []],
    ["a number", 5],
  ])("ignores a hint that is %s and shows the platform wording", async (_name, bad) => {
    mount({ policy: { ...POLICY, hints: { situation: bad } } });
    const dialog = await openForm();
    expect(within(dialog).getByText("What is happening with the patient right now?")).toBeTruthy();
  });

  it("treats a non-numeric maxChars as an unreadable policy and does not offer SBAR", async () => {
    mount({ policy: { ...POLICY, maxChars: "x" } });
    await userEvent.click(await toggle());
    await screen.findByText(/No saved replies yet/);
    expect(screen.queryByRole("option", { name: /SBAR/ })).toBeNull();
  });
});

describe("a transient policy failure", () => {
  it("offers SBAR when the menu is opened after the policy read failed", async () => {
    const { GET } = mount();
    const original = GET.getMockImplementation() as (path: string) => Promise<unknown>;
    let failing = true;
    GET.mockImplementation(((path: string) =>
      path === "/api/v1/messaging/sbar/policy" && failing
        ? Promise.resolve({ data: undefined, error: {}, response: { status: 503 } })
        : original(path)) as never);
    await userEvent.click(await toggle());
    await screen.findByText(/No saved replies yet/);
    expect(screen.queryByRole("option", { name: /SBAR/ })).toBeNull();
    failing = false;
    await userEvent.keyboard("{Escape}");
    await userEvent.click(await toggle());
    await screen.findByRole("option", { name: /SBAR/ });
  });
});
