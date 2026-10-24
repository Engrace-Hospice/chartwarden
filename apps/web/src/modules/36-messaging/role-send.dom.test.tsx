// M36 role-based send (ADR-0081, PROPOSED): the composer control is offered only behind the tenant flag + all three permissions + a care-team
// conversation (no flag provider = closed); the dialog needs a role, then shows who is on call (name, role, shift end in the roster's zone)
// and only the explicit send to that confirmed person goes out; a gap, an unconnected roster, a failed lookup and a changed resolution are
// explicit states that send nothing; the dialog's form never submits the composer's form; axe clean in each state.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ROLE_SEND_FLAG_KEY } from "@chartwarden/types";
import { type ApiClient, ApiClientProvider, FeatureFlagProvider } from "@chartwarden/ui";
import axe from "axe-core";
import type { JSX } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { RoleSendButton } from "./role-send-button";
import {
  CHANGED_TEXT,
  CHOOSE_ROLE_TEXT,
  INDETERMINATE_TEXT,
  LOOKUP_FAILED_TEXT,
  NAMES_UNAVAILABLE_TEXT,
  NOT_CONNECTED_TEXT,
  NO_COVERAGE_TEXT,
  REVIEW_LABEL,
  ROLE_SEND_BUTTON_LABEL,
  SENT_REPLAY_TEXT,
  UNTRACKED_TEXT,
  sentText,
} from "./role-send-wording";
import { OPTIONS_PATH, POLICY_PATH, optionsAnswer, policyAnswer } from "./urgent-test-fixture";

const RES_PATH = "/api/v1/messaging/channels/{id}/role-send/resolution";
const SEND_PATH = "/api/v1/messaging/channels/{id}/role-send";
const DANA = "dddddddd-dddd-4ddd-8ddd-000000000001";
const SAM = "dddddddd-dddd-4ddd-8ddd-000000000002";
const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizationName: "North Hospice",
  isAdmin: false,
  permissions: ["messaging.send", "messaging.urgent.send", "messaging.oncall.send"],
};

type Person = { user_id: string; display_name: string | null; rank: "primary" | "backup" };
const covered = (
  people: Person[] = [{ user_id: DANA, display_name: "Dana K.", rank: "primary" }],
) => ({
  data: {
    role: "rn",
    as_of: "2026-06-01T21:07:00.000Z",
    status: "covered",
    people,
    shift_ends_at: "2026-06-02T02:00:00.000Z",
    time_zone: "America/Los_Angeles",
  },
  response: { status: 200 },
});
const uncovered = (status: string) => ({
  data: {
    role: "rn",
    as_of: "2026-06-01T21:07:00.000Z",
    status,
    people: [],
    shift_ends_at: null,
    time_zone: null,
  },
  response: { status: 200 },
});
const sent = (over: Record<string, unknown> = {}) => ({
  data: {
    message_id: "m1",
    channel_id: "c1",
    patient_id: "p1",
    recipient_user_id: DANA,
    role: "rn",
    created: true,
    ...over,
  },
  response: { status: 201 },
});
const refusal = (status: number, code?: string) => ({
  error: code ? { error: { code } } : {},
  response: { status },
});

interface MountOptions {
  flags?: Record<string, boolean> | null;
  permissions?: string[];
  kind?: "care_team" | "dm";
  resolution?: () => unknown;
  post?: ReturnType<typeof vi.fn>;
  options?: unknown;
}

function mount(opts: MountOptions = {}) {
  const GET = vi.fn((path: string, _init?: unknown) => {
    if (path === OPTIONS_PATH) return Promise.resolve(opts.options ?? optionsAnswer());
    if (path === POLICY_PATH) return Promise.resolve(policyAnswer);
    if (path === RES_PATH) return Promise.resolve((opts.resolution ?? (() => covered()))());
    return Promise.resolve({ error: {}, response: { status: 404 } });
  });
  const POST = opts.post ?? vi.fn().mockResolvedValue(sent());
  const outerSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
  const tree = (
    <MemoryRouter>
      <ApiClientProvider client={{ GET, POST } as unknown as ApiClient}>
        <SessionProvider
          session={{ ...session, permissions: opts.permissions ?? session.permissions }}
        >
          <Outer
            flags={opts.flags === undefined ? { [ROLE_SEND_FLAG_KEY]: true } : opts.flags}
            kind={opts.kind ?? "care_team"}
            onSubmit={outerSubmit}
          />
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>
  );
  return { GET, POST, outerSubmit, ...render(tree) };
}

/** The real control inside a <form>, like the composer; no flag provider at all when `flags` is null. */
function Outer({
  flags,
  kind,
  onSubmit,
}: {
  flags: Record<string, boolean> | null;
  kind: "care_team" | "dm";
  onSubmit: (event: { preventDefault: () => void }) => void;
}): JSX.Element {
  const control = (
    <form onSubmit={onSubmit}>
      <RoleSendButton channelId="c1" kind={kind} />
    </form>
  );
  return flags === null ? (
    control
  ) : (
    <FeatureFlagProvider flags={flags}>{control}</FeatureFlagProvider>
  );
}

const open = async () => {
  await userEvent.click(await screen.findByRole("button", { name: ROLE_SEND_BUTTON_LABEL }));
  await screen.findByRole("dialog");
  await screen.findByLabelText("Situation");
};
const fill = async () => {
  for (const label of ["Situation", "Background", "Assessment", "Recommendation"]) {
    await userEvent.type(screen.getByLabelText(label), "Pain is uncontrolled");
  }
};
const review = async (role = "RN") => {
  await userEvent.click(screen.getByRole("radio", { name: role }));
  await fill();
  await userEvent.click(screen.getByRole("button", { name: REVIEW_LABEL }));
};
const sendCalls = (POST: ReturnType<typeof vi.fn>) =>
  POST.mock.calls.filter(([p]) => p === SEND_PATH);
const sendButton = () => screen.findByRole("button", { name: /^Send urgent message to / });
/** No person is confirmed: the only Send there is stays disabled and names nobody. */
const sendIsOff = () =>
  expect(
    (screen.getByRole("button", { name: "Send urgent message" }) as HTMLButtonElement).disabled,
  ).toBe(true);
const noAxe = { rules: { "color-contrast": { enabled: false } } };

afterEach(() => cleanup());

describe("role send: when it is offered", () => {
  it("is offered with the flag, all three permissions and a care-team conversation", async () => {
    mount();
    expect(await screen.findByRole("button", { name: ROLE_SEND_BUTTON_LABEL })).toBeTruthy();
  });

  it.each([
    ["no flag provider is mounted", { flags: null }],
    ["the flag is off", { flags: {} }],
    [
      "messaging.oncall.send is missing",
      { permissions: ["messaging.send", "messaging.urgent.send"] },
    ],
    [
      "messaging.urgent.send is missing",
      { permissions: ["messaging.send", "messaging.oncall.send"] },
    ],
    [
      "messaging.send is missing",
      { permissions: ["messaging.urgent.send", "messaging.oncall.send"] },
    ],
    ["the conversation is not a care-team conversation", { kind: "dm" as const }],
    ["the urgent options say no", { options: { data: { enabled: false } } }],
    [
      "the urgent options give no patient",
      { options: optionsAnswer({ patient_linked: false, patient_id: null }) },
    ],
  ])("is hidden when %s", async (_why, options) => {
    const { GET } = mount(options as MountOptions);
    await waitFor(() => expect(GET.mock.calls.length >= 0).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("button", { name: ROLE_SEND_BUTTON_LABEL })).toBeNull();
  });
});

describe("role send: the dialog", () => {
  it("needs a role and the four SBAR sections before it asks who is on call, and has no axe violations", async () => {
    const { GET } = mount();
    await open();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/not the emergency path/)).toBeTruthy();
    expect(
      within(dialog)
        .getAllByRole("radio")
        .map((r) => r.getAttribute("value")),
    ).toEqual(["rn", "physician"]);
    expect((await axe.run(dialog, noAxe)).violations).toEqual([]);
    await userEvent.click(within(dialog).getByRole("button", { name: REVIEW_LABEL }));
    expect(await within(dialog).findByText(CHOOSE_ROLE_TEXT)).toBeTruthy();
    expect(GET.mock.calls.some(([p]) => p === RES_PATH)).toBe(false);
  });

  it("shows the confirmed person with role and shift end in the roster's zone, then sends only to them with the role", async () => {
    const { POST, GET } = mount();
    await open();
    await review();
    const confirm = await sendButton();
    expect(confirm.textContent).toBe("Send urgent message to Dana K.");
    expect(screen.getByText(/Primary: Dana K\., on call RN/)).toBeTruthy();
    expect(screen.getByText(/until .*PDT/)).toBeTruthy();
    expect(
      screen.getByText(/This goes to Dana K\. \(Primary\), the on-call RN right now/),
    ).toBeTruthy();
    expect(GET.mock.calls.find(([p]) => p === RES_PATH)?.[1]).toMatchObject({
      params: { query: { role: "rn", patient_id: "p1" } },
    });
    expect(sendCalls(POST)).toHaveLength(0);
    expect((await axe.run(screen.getByRole("dialog"), noAxe)).violations).toEqual([]);
    await userEvent.click(confirm);
    await waitFor(() => expect(sendCalls(POST)).toHaveLength(1));
    const [, init] = sendCalls(POST)[0] as [
      string,
      { body: Record<string, unknown>; params: { header: Record<string, string> } },
    ];
    expect(init.body).toMatchObject({ role: "rn", patient_id: "p1", recipient_user_id: DANA });
    expect(init.params.header["Idempotency-Key"]).toBeTruthy();
    expect(await screen.findByText(sentText("rn", "Dana K."))).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("never submits the composer's own form", async () => {
    const { outerSubmit } = mount();
    await open();
    await review();
    await userEvent.click(await sendButton());
    await screen.findByText(sentText("rn", "Dana K."));
    expect(outerSubmit).not.toHaveBeenCalled();
  });

  it("with several people on call, makes the sender choose one: Send stays off until then", async () => {
    mount({
      resolution: () =>
        covered([
          { user_id: DANA, display_name: "Zed Z.", rank: "primary" },
          { user_id: SAM, display_name: "Abe A.", rank: "backup" },
        ]),
    });
    await open();
    await review();
    const send = (await screen.findByRole("button", {
      name: "Send urgent message",
    })) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    // rank is said in words; the primary stays first even though the backup sorts first by name; nothing is preselected
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.checked)).toEqual([false, false]);
    expect(screen.getByRole("radio", { name: /^Primary: Zed Z\., on call RN/ })).toBe(radios[0]);
    expect(screen.getByRole("radio", { name: /^Backup: Abe A\., on call RN/ })).toBe(radios[1]);
    await userEvent.click(radios[1] as HTMLInputElement);
    expect(((await sendButton()) as HTMLButtonElement).disabled).toBe(false);
    expect((await sendButton()).textContent).toBe("Send urgent message to Abe A.");
    expect(screen.getByText(/This goes to Abe A\. \(Backup\)/)).toBeTruthy();
  });

  it.each([
    ["a coverage gap", "coverage_gap", NO_COVERAGE_TEXT],
    ["an unconnected roster", "roster_not_connected", NOT_CONNECTED_TEXT],
  ])("says %s in words, sends nothing and offers no send", async (_name, status, text) => {
    const { POST } = mount({ resolution: () => uncovered(status) });
    await open();
    await review();
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.getByText(text).getAttribute("role")).toBe("alert");
    sendIsOff();
    expect(screen.queryByRole("radio", { name: /on call/ })).toBeNull();
    expect((await axe.run(screen.getByRole("dialog"), noAxe)).violations).toEqual([]);
    expect(sendCalls(POST)).toHaveLength(0);
  });

  it("does not offer a person whose name cannot be shown", async () => {
    mount({ resolution: () => covered([{ user_id: DANA, display_name: null, rank: "primary" }]) });
    await open();
    await review();
    expect(await screen.findByText(NAMES_UNAVAILABLE_TEXT)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Send urgent message to/ })).toBeNull();
  });

  it("says a failed lookup in words and Try again asks again", async () => {
    let calls = 0;
    mount({ resolution: () => (++calls === 1 ? refusal(500) : covered()) });
    await open();
    await review();
    expect(await screen.findByText(LOOKUP_FAILED_TEXT)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await sendButton()).toBeTruthy();
  });

  it("fails closed when the server says it is not available (404)", async () => {
    const { POST } = mount({ resolution: () => refusal(404) });
    await open();
    await review();
    expect(await screen.findByText(/not available here/)).toBeTruthy();
    sendIsOff();
    expect(sendCalls(POST)).toHaveLength(0);
  });

  it("after a changed resolution (409) says so, sends nothing more, and asks the sender to confirm the new person", async () => {
    let calls = 0;
    const post = vi.fn().mockResolvedValue(refusal(409, "ROLE_SEND_RESOLUTION_CHANGED"));
    mount({
      post,
      resolution: () =>
        ++calls === 1
          ? covered()
          : covered([{ user_id: SAM, display_name: "Sam R.", rank: "primary" }]),
    });
    await open();
    await review();
    await userEvent.click(await sendButton());
    expect(await screen.findByText(CHANGED_TEXT)).toBeTruthy();
    const next = await screen.findByRole("button", { name: "Send urgent message to Sam R." });
    expect(sendCalls(post)).toHaveLength(1);
    await userEvent.click(next);
    await waitFor(() => expect(sendCalls(post)).toHaveLength(2));
    expect(
      (sendCalls(post)[1] as [string, { body: Record<string, unknown> }])[1].body,
    ).toMatchObject({ recipient_user_id: SAM });
    expect(screen.queryByText(INDETERMINATE_TEXT)).toBeNull();
  });

  it.each([
    [
      "a changed resolution (the server cached the refusal under the old key)",
      refusal(409, "ROLE_SEND_RESOLUTION_CHANGED"),
      false,
    ],
    ["a refused coverage", refusal(422, "ROLE_SEND_NO_COVERAGE"), false],
    [
      "a failure that may have stored the message (a retry must be the same request)",
      refusal(502),
      true,
    ],
  ])("after %s, the next send uses %s Idempotency-Key", async (_why, failure, sameKey) => {
    const post = vi.fn().mockResolvedValue(failure);
    mount({ post });
    await open();
    await review();
    await userEvent.click(await sendButton());
    await waitFor(() => expect(sendCalls(post)).toHaveLength(1));
    // The roster is read again; the same person is on call, so the same Send is offered.
    await userEvent.click(await sendButton());
    await waitFor(() => expect(sendCalls(post)).toHaveLength(2));
    const keyOf = (i: number) =>
      (sendCalls(post)[i] as [string, { params: { header: Record<string, string> } }])[1].params
        .header["Idempotency-Key"];
    expect(keyOf(0) === keyOf(1)).toBe(sameKey);
  });

  it("a refused coverage at send time shows the telephone procedure and re-reads the roster", async () => {
    let calls = 0;
    const post = vi.fn().mockResolvedValue(refusal(422, "ROLE_SEND_NO_COVERAGE"));
    mount({ post, resolution: () => (++calls === 1 ? covered() : uncovered("coverage_gap")) });
    await open();
    await review();
    await userEvent.click(await sendButton());
    expect((await screen.findAllByText(NO_COVERAGE_TEXT)).length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^Send urgent message to/ })).toBeNull(),
    );
  });

  it("says role send is unavailable when the server cannot track the response (503, nothing sent)", async () => {
    const post = vi.fn().mockResolvedValue(refusal(503, "ROLE_SEND_UNAVAILABLE"));
    mount({ post });
    await open();
    await review();
    await userEvent.click(await sendButton());
    expect(await screen.findByText(UNTRACKED_TEXT)).toBeTruthy();
    expect(screen.queryByText(INDETERMINATE_TEXT)).toBeNull();
  });

  it("treats an untyped 5xx as indeterminate (it may have been stored)", async () => {
    const post = vi.fn().mockResolvedValue(refusal(502));
    mount({ post });
    await open();
    await review();
    await userEvent.click(await sendButton());
    expect(await screen.findByText(INDETERMINATE_TEXT)).toBeTruthy();
  });

  it("reports a replay as already sent", async () => {
    mount({
      post: vi.fn().mockResolvedValue({ ...sent({ created: false }), response: { status: 200 } }),
    });
    await open();
    await review();
    await userEvent.click(await sendButton());
    expect(await screen.findByText(SENT_REPLAY_TEXT)).toBeTruthy();
  });

  it("Back returns to the form with the text kept, and closing with text asks before discarding", async () => {
    mount();
    await open();
    await review();
    await userEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect((screen.getByLabelText("Situation") as HTMLTextAreaElement).value).toBe(
      "Pain is uncontrolled",
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("role send: after-hours triage (ADR-0082)", () => {
  const withTriage = (on: boolean) => () => {
    const base = covered();
    return { ...base, data: { ...base.data, afterhours_triage: on } };
  };

  it("tells the sender, before they confirm, that the send also asks for a triage call (words and icon)", async () => {
    mount({ resolution: withTriage(true) });
    await open();
    await review();
    await sendButton();
    const note = document.querySelector("[data-afterhours-indicator]");
    expect(note?.textContent).toMatch(/after-hours triage call/);
    expect(note?.querySelector("svg")).toBeTruthy();
  });

  it("shows no indicator when after-hours triage is off", async () => {
    mount({ resolution: withTriage(false) });
    await open();
    await review();
    await sendButton();
    expect(document.querySelector("[data-afterhours-indicator]")).toBeNull();
  });

  it("a lookup_failed resolution is a refusal with no way to send, not a coverage gap", async () => {
    mount({ resolution: () => uncovered("lookup_failed") });
    await open();
    await review();
    expect(await screen.findByText(LOOKUP_FAILED_TEXT)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Send urgent message to/ })).toBeNull();
  });

  it("a 503 ROLE_SEND_LOOKUP_FAILED at send time is a clean refusal (nothing sent), not an indeterminate send", async () => {
    const post = vi.fn().mockResolvedValue(refusal(503, "ROLE_SEND_LOOKUP_FAILED"));
    mount({ post });
    await open();
    await review();
    await userEvent.click(await sendButton());
    expect(await screen.findByText(LOOKUP_FAILED_TEXT)).toBeTruthy();
    expect(screen.queryByText(/may not have been sent/)).toBeNull();
  });
});
