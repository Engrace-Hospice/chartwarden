// M36 G2: the composer's "Needs a response" control. Offered only with the ack flag + both permissions + a patient care-team
// channel; checked it needs one chosen colleague (Send stays disabled, the sender refuses a bypass), sends the message and then
// asks that colleague; off by default and never remembered; it is not a dialog, so nothing can submit the composer's form.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ACK_REQUESTS_FLAG_KEY } from "@wardenx/types";
import { type ApiClient, ApiClientProvider, FeatureFlagProvider } from "@wardenx/ui";
import axe from "axe-core";
import { useRef, useState } from "react";
import type { JSX } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import type { ChannelKind } from "./messaging-types";
import {
  NEEDS_RESPONSE_CHOOSE_TEXT,
  NEEDS_RESPONSE_LABEL,
  NEEDS_RESPONSE_NONE_TEXT,
  NEEDS_RESPONSE_NOTICE,
  REQUEST_FAILED_TEXT,
  REQUEST_INDETERMINATE_TEXT,
  requestedText,
} from "./needs-response";
import { NeedsResponseControl, needsRecipient, useNeedsResponse } from "./needs-response-control";
import { OPTIONS_PATH, RN, optionsAnswer } from "./urgent-test-fixture";
import type { AttachmentUploads } from "./use-attachment-upload";
import { useMessageSender } from "./use-message-sender";

const SEND_PATH = "/api/v1/messaging/channels/{id}/messages";
const ASK_PATH = "/api/v1/messaging/escalations";
const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizationName: "North Hospice",
  isAdmin: false,
  permissions: ["messaging.send", "messaging.urgent.send"],
};
const UPLOADS = {
  chips: [],
  notices: [],
  blocksSend: false,
  sendableIds: [],
  addFiles: () => {},
  remove: () => {},
  retry: () => {},
  recheck: async () => {},
  reset: () => {},
} as AttachmentUploads;

/** A miniature composer: the real control + the real sender inside one <form>, like ThreadComposer. */
function Composer({ kind = "care_team" }: { kind?: ChannelKind }): JSX.Element {
  const [draft, setDraft] = useState("Please review the new orders");
  const generationRef = useRef(0);
  const needs = useNeedsResponse("c1", kind);
  const { send, sendError } = useMessageSender({
    channelId: "c1",
    archived: false,
    draft,
    draftReferences: [],
    uploads: UPLOADS,
    generationRef,
    onSent: () => setDraft(""),
    needsResponse: needs.forSend,
  });
  return (
    <form className="wx-message-composer" onSubmit={(event) => void send(event)}>
      <textarea aria-label="Message" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <NeedsResponseControl state={needs} />
      <button type="submit" disabled={needsRecipient(needs)}>
        Send
      </button>
      {sendError ? <p role="alert">{sendError}</p> : null}
    </form>
  );
}

function mount(
  options: {
    flags?: Record<string, boolean>;
    permissions?: string[];
    get?: (path: string) => unknown;
    ask?: (path: string) => Promise<unknown>;
    kind?: ChannelKind;
  } = {},
) {
  const GET = vi.fn((path: string) =>
    Promise.resolve(
      options.get
        ? options.get(path)
        : path === OPTIONS_PATH
          ? optionsAnswer()
          : { response: { status: 404 } },
    ),
  );
  const POST = vi.fn((path: string) =>
    path === SEND_PATH
      ? Promise.resolve({
          data: { messageId: "m1", createdAt: "2026-10-19T10:00:00.000Z" },
          response: { status: 201 },
        })
      : (
          options.ask ??
          (() => Promise.resolve({ data: { created: true }, response: { status: 201 } }))
        )(path),
  );
  const client = { GET, POST } as unknown as ApiClient;
  const view = render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <SessionProvider
          session={{ ...session, permissions: options.permissions ?? session.permissions }}
        >
          <FeatureFlagProvider flags={options.flags ?? { [ACK_REQUESTS_FLAG_KEY]: true }}>
            <Composer kind={options.kind ?? "care_team"} />
          </FeatureFlagProvider>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, POST, ...view };
}

const box = () => screen.findByRole("checkbox", { name: NEEDS_RESPONSE_LABEL });
const askCalls = (POST: ReturnType<typeof vi.fn>) =>
  POST.mock.calls.filter(([p]) => p === ASK_PATH);

afterEach(() => cleanup());

describe("Needs a response: when it is offered", () => {
  it("is off by default, with the not-the-emergency-path wording described-by the box", async () => {
    mount();
    const checkbox = await box();
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(NEEDS_RESPONSE_NOTICE).textContent).toMatch(/not the emergency path/);
    expect(screen.getByText(NEEDS_RESPONSE_NOTICE).textContent).toMatch(
      /does not count as taking responsibility/,
    );
    expect(checkbox.getAttribute("aria-describedby")).toBe(
      screen.getByText(NEEDS_RESPONSE_NOTICE).id,
    );
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it.each([
    ["the ack flag is off", { flags: {} }],
    ["messaging.urgent.send is missing", { permissions: ["messaging.send"] }],
    ["messaging.send is missing", { permissions: ["messaging.urgent.send"] }],
    ["the channel is not a care-team conversation", { kind: "location" as ChannelKind }],
    ["the options route says no", { get: () => ({ data: { enabled: false } }) }],
  ])("is hidden when %s", async (_why, options) => {
    const { GET } = mount(options);
    await waitFor(() => expect(screen.getByLabelText("Message")).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("checkbox")).toBeNull();
    if (!("get" in options)) expect(GET).not.toHaveBeenCalled();
  });

  it("is disabled with the reason when no qualified colleague exists", async () => {
    mount({ get: () => optionsAnswer({ recipients: [] }) });
    expect(((await box()) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(NEEDS_RESPONSE_NONE_TEXT)).toBeTruthy();
  });
});

describe("Needs a response: the recipient is required", () => {
  it("checking shows the picker; Send stays disabled until one is chosen", async () => {
    const { POST } = mount();
    await userEvent.click(await box());
    expect(screen.getByRole("group", { name: /Ask \(choose one/ })).toBeTruthy();
    const send = screen.getByRole("button", { name: "Send" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("radio", { name: new RegExp(RN.display_name) }));
    expect((send as HTMLButtonElement).disabled).toBe(false);
    expect(POST).not.toHaveBeenCalled();
  });

  it("Enter in the textarea with no recipient posts nothing, shows the error once, focuses the picker, and clears it on a choice", async () => {
    const { POST } = mount();
    await userEvent.click(await box());
    const textarea = screen.getByLabelText("Message");
    fireEvent.submit(textarea.closest("form") as HTMLFormElement);
    expect(POST).not.toHaveBeenCalled();
    const group = screen.getByRole("group", { name: /Ask \(choose one/ });
    expect(screen.getAllByText(NEEDS_RESPONSE_CHOOSE_TEXT)).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toMatch(NEEDS_RESPONSE_CHOOSE_TEXT);
    expect(group.getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id);
    await waitFor(() => expect(document.activeElement).toBe(group));
    await userEvent.click(screen.getByRole("radio", { name: new RegExp(RN.display_name) }));
    expect(screen.queryByText(NEEDS_RESPONSE_CHOOSE_TEXT)).toBeNull();
    expect(group.getAttribute("aria-describedby")).toBeNull();
  });

  it("Escape in the picker unchecks the box and returns focus to it", async () => {
    mount();
    const checkbox = await box();
    await userEvent.click(checkbox);
    await userEvent.click(screen.getByRole("radio", { name: new RegExp(RN.display_name) }));
    await userEvent.keyboard("{Escape}");
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    expect(document.activeElement).toBe(checkbox);
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("Space toggles the box from the keyboard and Tab reaches the picker", async () => {
    mount();
    const checkbox = await box();
    checkbox.focus();
    await userEvent.keyboard(" ");
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getAllByRole("radio")[0]);
  });
});

describe("Needs a response: sending", () => {
  it("sends the message, then asks exactly the chosen colleague, and forgets the choice", async () => {
    const { POST } = mount();
    await userEvent.click(await box());
    await userEvent.click(screen.getByRole("radio", { name: new RegExp(RN.display_name) }));
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(requestedText(RN.display_name))).toBeTruthy();
    const calls = askCalls(POST);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toMatchObject({
      body: { message_id: "m1", assigned_user_id: RN.user_id },
    });
    expect(POST.mock.calls[0]?.[0]).toBe(SEND_PATH); // the message first, then the request
    expect(((await box()) as HTMLInputElement).checked).toBe(false); // never remembered
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("an unchecked box sends a plain message and asks nobody", async () => {
    const { POST } = mount();
    await box();
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    expect(askCalls(POST)).toHaveLength(0);
  });

  it("says plainly that the message went but the request did not (definitive refusal)", async () => {
    mount({ ask: vi.fn().mockResolvedValue({ error: {}, response: { status: 422 } }) });
    await userEvent.click(await box());
    await userEvent.click(screen.getByRole("radio", { name: new RegExp(RN.display_name) }));
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(REQUEST_FAILED_TEXT)).toBeTruthy();
  });

  it("a lost answer is reported as indeterminate, not as success", async () => {
    mount({ ask: vi.fn().mockRejectedValue(new Error("network")) });
    await userEvent.click(await box());
    await userEvent.click(screen.getByRole("radio", { name: new RegExp(RN.display_name) }));
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(REQUEST_INDETERMINATE_TEXT)).toBeTruthy();
  });
});

describe("Needs a response: composer form", () => {
  it("toggling, choosing and Escape never submit the composer's form (no nested form, nothing portalled to bubble)", async () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    const client = {
      GET: vi.fn().mockResolvedValue(optionsAnswer()),
      POST: vi.fn(),
    } as unknown as ApiClient;
    render(
      <MemoryRouter>
        <ApiClientProvider client={client}>
          <SessionProvider session={session}>
            <FeatureFlagProvider flags={{ [ACK_REQUESTS_FLAG_KEY]: true }}>
              <Harness onSubmit={onSubmit} />
            </FeatureFlagProvider>
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    await userEvent.click(await box());
    await userEvent.click(screen.getByRole("radio", { name: new RegExp(RN.display_name) }));
    await userEvent.keyboard("{Escape}");
    expect(document.querySelectorAll("form form")).toHaveLength(0);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("has no axe violations with the picker open", async () => {
    const { container } = mount();
    await userEvent.click(await box());
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });
});

function Harness({
  onSubmit,
}: { onSubmit: (event: { preventDefault: () => void }) => void }): JSX.Element {
  const needs = useNeedsResponse("c1", "care_team");
  return (
    <form className="wx-message-composer" onSubmit={onSubmit}>
      <NeedsResponseControl state={needs} />
    </form>
  );
}
