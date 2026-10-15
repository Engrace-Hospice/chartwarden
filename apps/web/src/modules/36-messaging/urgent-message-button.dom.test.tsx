// M36 WP 4.1: the composer action is shown only when the options route allows it and the channel is a patient care-team
// conversation; the dialog shows the emergency-procedure notice, requires a chosen recipient and the SBAR sections, and
// sends exactly what the server needs (an SBAR document, one recipient, a client id); the outcome stays on screen.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiClientProvider } from "@wardenx/ui";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SENT_STATUS_MS, UrgentMessageButton } from "./urgent-message-button";
import {
  OPTIONS_PATH,
  POLICY_PATH,
  RN,
  mountWithClient,
  optionsAnswer,
  policyAnswer,
  refusal,
  sentAnswer,
} from "./urgent-test-fixture";
import {
  DISCARD_LABEL,
  INDETERMINATE_TEXT,
  KEEP_DRAFT_LABEL,
  KEEP_EDITING_LABEL,
  LOAD_FAILED_TEXT,
  NOT_EMERGENCY_NOTICE,
  NO_PAGE_NOTICE,
  NO_RECIPIENT_TEXT,
  RETRY_LABEL,
  SENT_REPLAY_TEXT,
  SENT_TEXT,
  TURNED_OFF_NOTICE,
  UNAVAILABLE_TEXT,
  URGENT_BUTTON_LABEL,
} from "./urgent-wording";
import { POLICY_RETRY_DELAYS_MS } from "./use-sbar-policy";

const open = async () => {
  await userEvent.click(await screen.findByRole("button", { name: URGENT_BUTTON_LABEL }));
  await screen.findByRole("dialog");
  await screen.findByLabelText("Situation");
};
const fill = async (text = "Pain is uncontrolled") => {
  for (const label of ["Situation", "Background", "Assessment", "Recommendation"]) {
    await userEvent.type(screen.getByLabelText(label), text);
  }
};

describe("UrgentMessageButton visibility", () => {
  it("renders nothing while the options route says the mode is off", async () => {
    const { GET } = mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />, {
      get: () => ({ data: { enabled: false } }),
    });
    await waitFor(() => expect(GET).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: URGENT_BUTTON_LABEL })).toBeNull();
  });

  it("makes no read at all outside a care-team conversation", () => {
    const { GET } = mountWithClient(<UrgentMessageButton channelId="c1" kind="dm" />);
    expect(GET).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: URGENT_BUTTON_LABEL })).toBeNull();
  });

  it.each([401, 403, 404])("is hidden after a %s (fail closed)", async (status) => {
    const { GET } = mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />, {
      get: () => refusal(status, "X"),
    });
    await waitFor(() => expect(GET).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: URGENT_BUTTON_LABEL })).toBeNull();
  });

  it("is hidden when the options say the channel has no patient", async () => {
    const { GET } = mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />, {
      get: () => optionsAnswer({ patient_linked: false, patient_id: null, recipients: [] }),
    });
    await waitFor(() => expect(GET).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: URGENT_BUTTON_LABEL })).toBeNull();
  });
});

describe("UrgentMessageDialog", () => {
  it("shows the emergency-procedure notice and the no-page notice, permanently", async () => {
    mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />);
    await open();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(NOT_EMERGENCY_NOTICE)).toBeTruthy();
    expect(within(dialog).getByText(NO_PAGE_NOTICE)).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /dismiss|hide|close notice/i })).toBeNull();
  });

  it("labels every control and has no axe violations", async () => {
    mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />);
    await open();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("group", { name: /Send to/ })).toBeTruthy();
    expect(within(dialog).getAllByRole("radio")).toHaveLength(2);
    for (const label of ["Situation", "Background", "Assessment", "Recommendation"]) {
      expect(within(dialog).getByLabelText(label)).toBeTruthy();
    }
    const result = await axe.run(dialog, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations).toEqual([]);
  });

  it("will not send without a recipient, and nothing is posted", async () => {
    const { POST } = mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />);
    await open();
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Send urgent message" }));
    expect(await screen.findByText(/Choose who this goes to/)).toBeTruthy();
    expect(POST).not.toHaveBeenCalled();
  });

  it("will not send with an SBAR section below the policy floor, and names the field", async () => {
    const { POST } = mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />);
    await open();
    await userEvent.click(screen.getByRole("radio", { name: RN.display_name }));
    await userEvent.type(screen.getByLabelText("Situation"), "ab");
    await userEvent.click(screen.getByRole("button", { name: /Send urgent message to Rita/ }));
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    expect(POST).not.toHaveBeenCalled();
  });

  it("restates the chosen recipient before sending, then posts an SBAR body with that recipient", async () => {
    const onSent = vi.fn();
    const { POST } = mountWithClient(
      <UrgentMessageButton channelId="c1" kind="care_team" onThreadChanged={onSent} />,
    );
    await open();
    await userEvent.click(screen.getByRole("radio", { name: RN.display_name }));
    expect(screen.getByText(/This goes to Rita Nurse and is marked urgent/)).toBeTruthy();
    await fill();
    await userEvent.click(
      screen.getByRole("button", { name: "Send urgent message to Rita Nurse" }),
    );
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(POST).toHaveBeenCalledTimes(1);
    const [path, init] = POST.mock.calls[0] as [
      string,
      {
        body: Record<string, unknown>;
        params: { path: { id: string }; header: Record<string, string> };
      },
    ];
    expect(path).toBe("/api/v1/messaging/channels/{id}/urgent-messages");
    expect(init.params.path.id).toBe("c1");
    expect(init.params.header["Idempotency-Key"]).toMatch(/[0-9a-f-]{36}/);
    expect(Object.keys(init.body).sort()).toEqual([
      "body_doc",
      "client_message_id",
      "recipient_user_id",
    ]);
    expect(init.body.recipient_user_id).toBe(RN.user_id);
    const doc = JSON.stringify(init.body.body_doc);
    expect(doc).toContain('"type":"sbar"');
    expect(doc).toContain("Pain is uncontrolled");
  });

  it("keeps a focusable status after sending and returns focus to the trigger", async () => {
    mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />);
    await open();
    await userEvent.click(screen.getByRole("radio", { name: RN.display_name }));
    await fill();
    await userEvent.click(screen.getByRole("button", { name: /Send urgent message to Rita/ }));
    const status = await screen.findByText(SENT_TEXT);
    expect(status.tabIndex).toBe(0);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: URGENT_BUTTON_LABEL }),
      ),
    );
  });

  it("says plainly when the same message had already been sent", async () => {
    mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />, {
      post: vi.fn().mockResolvedValue(sentAnswer({ created: false })),
    });
    await open();
    await userEvent.click(screen.getByRole("radio", { name: RN.display_name }));
    await fill();
    await userEvent.click(screen.getByRole("button", { name: /Send urgent message to Rita/ }));
    expect(await screen.findByText(SENT_REPLAY_TEXT)).toBeTruthy();
  });

  it.each([
    ["URGENT_RECIPIENT_INVALID", 422, /cannot take this message/],
    ["URGENT_NOT_PATIENT_CHANNEL", 422, /patient's care team conversation/],
    ["X", 404, /not available here/],
    ["X", 403, /not allowed/],
  ])(
    "shows the refusal %s/%i and keeps the dialog open with nothing sent",
    async (code, status, text) => {
      const { POST } = mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />, {
        post: vi.fn().mockResolvedValue(refusal(status, code)),
      });
      await open();
      await userEvent.click(screen.getByRole("radio", { name: RN.display_name }));
      await fill();
      await userEvent.click(screen.getByRole("button", { name: /Send urgent message to Rita/ }));
      expect((await screen.findByRole("alert")).textContent).toMatch(text);
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(screen.queryByText(SENT_TEXT)).toBeNull();
      expect(POST).toHaveBeenCalledTimes(1);
    },
  );

  it("rotates the ids when the text changes and reuses them when an identical payload is retried", async () => {
    const post = vi.fn().mockResolvedValue(refusal(500, "X"));
    mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />, { post });
    await open();
    await userEvent.click(screen.getByRole("radio", { name: RN.display_name }));
    await fill();
    const send = () =>
      userEvent.click(screen.getByRole("button", { name: /Send urgent message to Rita/ }));
    await send();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await send();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    const key = (n: number) =>
      (
        post.mock.calls[n] as [
          string,
          { params: { header: Record<string, string> }; body: { client_message_id: string } },
        ]
      )[1];
    expect(key(1).params.header["Idempotency-Key"]).toBe(key(0).params.header["Idempotency-Key"]);
    expect(key(1).body.client_message_id).toBe(key(0).body.client_message_id);
    await userEvent.type(screen.getByLabelText("Situation"), " more");
    await send();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
    expect(key(2).params.header["Idempotency-Key"]).not.toBe(
      key(0).params.header["Idempotency-Key"],
    );
    expect(key(2).body.client_message_id).not.toBe(key(0).body.client_message_id);
  });

  it("offers no send and says what to do when nobody qualified is available", async () => {
    const { POST } = mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />, {
      get: (path) => (path === OPTIONS_PATH ? optionsAnswer({ recipients: [] }) : policyAnswer),
    });
    await userEvent.click(await screen.findByRole("button", { name: URGENT_BUTTON_LABEL }));
    expect(await screen.findByText(NO_RECIPIENT_TEXT)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Send urgent message" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(POST).not.toHaveBeenCalled();
  });

  it("returns focus to the trigger when closed with Escape", async () => {
    mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />);
    await open();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: URGENT_BUTTON_LABEL }));
  });
});

const sendBtn = () => screen.getByRole("button", { name: /Send urgent message to/ });
const choose = async () => userEvent.click(screen.getByRole("radio", { name: RN.display_name }));
type Call = [
  string,
  { params: { header: Record<string, string> }; body: { client_message_id: string } },
];

describe("accessibility of the notices", () => {
  it("associates both notices with the dialog through aria-describedby (announced with it)", async () => {
    mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />);
    await open();
    const dialog = screen.getByRole("dialog");
    const target = document.getElementById(dialog.getAttribute("aria-describedby") ?? "");
    expect(target).not.toBeNull();
    expect(target?.textContent).toContain(NOT_EMERGENCY_NOTICE);
    expect(target?.textContent).toContain(NO_PAGE_NOTICE);
  });

  it("restates the recipient in a polite live region", async () => {
    mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />);
    await open();
    await choose();
    const line = screen.getByText(/This goes to Rita Nurse/);
    expect(line.getAttribute("aria-live")).toBe("polite");
  });

  it("moves focus to the recipient group and links the error when no one is chosen", async () => {
    mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />);
    await open();
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Send urgent message" }));
    const group = screen.getByRole("group", { name: /required/ });
    await waitFor(() => expect(document.activeElement).toBe(group));
    expect(
      document.getElementById(group.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toMatch(/Choose who this goes to/);
  });
});

describe("a dirty draft is never lost by a stray close", () => {
  it.each([
    ["Escape", () => userEvent.keyboard("{Escape}")],
    [
      "a scrim click",
      () => userEvent.click(document.querySelector('button[aria-label="Close"]') as Element),
    ],
    ["Cancel", () => userEvent.click(screen.getByRole("button", { name: "Cancel" }))],
  ])("%s asks first, in the dialog, and Keep editing leaves the text", async (_n, close) => {
    mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />);
    await open();
    await fill("Still typing");
    await close();
    expect(await screen.findByText(/Close this urgent message/)).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: KEEP_EDITING_LABEL })),
    );
    await userEvent.click(screen.getByRole("button", { name: KEEP_EDITING_LABEL }));
    expect((screen.getByLabelText("Situation") as HTMLTextAreaElement).value).toBe("Still typing");
  });

  it("an empty draft closes at once", async () => {
    mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />);
    await open();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Discard forgets the text; Close-keep-draft keeps it for the next open", async () => {
    mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />);
    await open();
    await fill("Keep me");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(await screen.findByRole("button", { name: KEEP_DRAFT_LABEL }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await open();
    expect((screen.getByLabelText("Situation") as HTMLTextAreaElement).value).toBe("Keep me");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(await screen.findByRole("button", { name: DISCARD_LABEL }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await open();
    expect((screen.getByLabelText("Situation") as HTMLTextAreaElement).value).toBe("");
  });
});

describe("sending", () => {
  it("Ctrl+Enter sends", async () => {
    const { POST } = mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />);
    await open();
    await choose();
    await fill();
    fireEvent.keyDown(screen.getByLabelText("Situation"), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
  });

  it("a double submit while in flight posts once", async () => {
    let release: (v: unknown) => void = () => {};
    const post = vi.fn().mockReturnValue(
      new Promise((r) => {
        release = r;
      }),
    );
    mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />, { post });
    await open();
    await choose();
    await fill();
    const form = screen.getByRole("dialog").querySelector("form") as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.keyDown(screen.getByLabelText("Situation"), { key: "Enter", ctrlKey: true });
    expect(post).toHaveBeenCalledTimes(1);
    await act(async () => release(sentAnswer()));
  });

  it("a 409 keeps the message id and rotates only the Idempotency-Key", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(refusal(409, "IDEMPOTENCY_IN_PROGRESS"))
      .mockResolvedValue(sentAnswer());
    mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />, { post });
    await open();
    await choose();
    await fill();
    await userEvent.click(sendBtn());
    expect((await screen.findByRole("alert")).textContent).toBe(INDETERMINATE_TEXT);
    await userEvent.click(sendBtn());
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    const [a, b] = post.mock.calls as [Call, Call];
    expect(b[1].body.client_message_id).toBe(a[1].body.client_message_id);
    expect(b[1].params.header["Idempotency-Key"]).not.toBe(a[1].params.header["Idempotency-Key"]);
  });

  it.each([
    ["thrown", () => Promise.reject(new Error("net"))],
    ["a 503", () => Promise.resolve(refusal(503, "X"))],
  ])(
    "%s: says it may not have been sent, re-reads the thread, and a close/reopen retry reuses the same ids",
    async (_n, fail) => {
      const onSent = vi.fn();
      const post = vi.fn().mockImplementationOnce(fail).mockResolvedValue(sentAnswer());
      mountWithClient(
        <UrgentMessageButton channelId="c1" kind="care_team" onThreadChanged={onSent} />,
        {
          post,
        },
      );
      await open();
      await choose();
      await fill();
      await userEvent.click(sendBtn());
      expect((await screen.findByRole("alert")).textContent).toBe(INDETERMINATE_TEXT);
      expect(onSent).toHaveBeenCalledTimes(1); // the thread is reloaded so the sender can check it
      await userEvent.keyboard("{Escape}");
      await userEvent.click(await screen.findByRole("button", { name: KEEP_DRAFT_LABEL }));
      await open();
      await userEvent.click(sendBtn());
      await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
      const [a, b] = post.mock.calls as [Call, Call];
      expect(b[1].body.client_message_id).toBe(a[1].body.client_message_id);
      expect(b[1].params.header["Idempotency-Key"]).toBe(a[1].params.header["Idempotency-Key"]);
    },
  );

  it("a definitive refusal says nothing was sent and does not reload the thread", async () => {
    const onSent = vi.fn();
    mountWithClient(
      <UrgentMessageButton channelId="c1" kind="care_team" onThreadChanged={onSent} />,
      {
        post: vi.fn().mockResolvedValue(refusal(422, "URGENT_RECIPIENT_INVALID")),
      },
    );
    await open();
    await choose();
    await fill();
    await userEvent.click(sendBtn());
    expect((await screen.findByRole("alert")).textContent).toMatch(/cannot take this message/);
    expect(onSent).not.toHaveBeenCalled();
  });

  it("a 429 tells the sender to wait and that nothing was sent", async () => {
    mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />, {
      post: vi.fn().mockResolvedValue(refusal(429, "RATE_LIMITED")),
    });
    await open();
    await choose();
    await fill();
    await userEvent.click(sendBtn());
    expect((await screen.findByRole("alert")).textContent).toMatch(/Nothing was sent/);
  });
});

describe("channel switch", () => {
  const rerenderWith = (
    view: ReturnType<typeof mountWithClient>,
    channelId: string,
    onSent?: () => void,
  ) =>
    view.rerender(
      <MemoryRouter>
        <ApiClientProvider client={view.client}>
          <UrgentMessageButton channelId={channelId} kind="care_team" onThreadChanged={onSent} />
        </ApiClientProvider>
      </MemoryRouter>,
    );

  it("closes an open dialog and starts the new conversation with a clean draft", async () => {
    const view = mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />);
    await open();
    await fill("From c1");
    rerenderWith(view, "c2");
    expect(screen.queryByRole("dialog")).toBeNull();
    await open();
    expect((screen.getByLabelText("Situation") as HTMLTextAreaElement).value).toBe("");
  });

  it("ignores a send that finishes after the person left (no status, no reload)", async () => {
    let release: (v: unknown) => void = () => {};
    const post = vi.fn().mockReturnValue(
      new Promise((r) => {
        release = r;
      }),
    );
    const onSent = vi.fn();
    const view = mountWithClient(
      <UrgentMessageButton channelId="c1" kind="care_team" onThreadChanged={onSent} />,
      { post },
    );
    await open();
    await choose();
    await fill();
    await userEvent.click(sendBtn());
    rerenderWith(view, "c2", onSent);
    await act(async () => release(sentAnswer()));
    expect(onSent).not.toHaveBeenCalled();
    expect(screen.queryByText(SENT_TEXT)).toBeNull();
  });
});

describe("options failures", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());
  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  const triggerDisabled = () =>
    (screen.getByRole("button", { name: URGENT_BUTTON_LABEL }) as HTMLButtonElement).disabled;

  it.each([
    ["a 503", () => refusal(503, "X")],
    ["a thrown client", () => Promise.reject(new Error("net"))],
  ])(
    "%s is transient: unavailable text while retrying, then the button works",
    async (_n, fail) => {
      let first = true;
      const { GET } = mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />, {
        get: (path) => {
          if (path === OPTIONS_PATH && first) {
            first = false;
            return fail();
          }
          return path === OPTIONS_PATH ? optionsAnswer() : policyAnswer;
        },
      });
      expect(await screen.findByText(UNAVAILABLE_TEXT)).toBeTruthy();
      expect(triggerDisabled()).toBe(true);
      await advance(POLICY_RETRY_DELAYS_MS[0] + 50);
      await waitFor(() => expect(triggerDisabled()).toBe(false));
      expect(GET.mock.calls.filter((c) => c[0] === OPTIONS_PATH).length).toBeGreaterThanOrEqual(2);
    },
  );

  it("after the retries are exhausted says it could not load and offers Try again, which starts over", async () => {
    let healthy = false;
    const { GET } = mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />, {
      get: (path) =>
        path === OPTIONS_PATH ? (healthy ? optionsAnswer() : refusal(503, "X")) : policyAnswer,
    });
    expect(await screen.findByText(UNAVAILABLE_TEXT)).toBeTruthy();
    for (const delay of POLICY_RETRY_DELAYS_MS) await advance(delay + 50);
    expect(await screen.findByText(LOAD_FAILED_TEXT)).toBeTruthy();
    expect(triggerDisabled()).toBe(true);
    const calls = GET.mock.calls.filter((c) => c[0] === OPTIONS_PATH).length;
    healthy = true;
    await userEvent.click(screen.getByRole("button", { name: RETRY_LABEL }));
    await waitFor(() => expect(triggerDisabled()).toBe(false));
    expect(GET.mock.calls.filter((c) => c[0] === OPTIONS_PATH).length).toBeGreaterThan(calls);
    expect(screen.queryByText(LOAD_FAILED_TEXT)).toBeNull();
  });

  it("re-reads the options each time the dialog opens", async () => {
    const { GET } = mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />);
    await open();
    await waitFor(() =>
      expect(GET.mock.calls.filter((c) => c[0] === OPTIONS_PATH).length).toBeGreaterThanOrEqual(2),
    );
  });
});

describe("recipient names", () => {
  it("never offers a colleague whose name is missing, and says some are not listed", async () => {
    mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />, {
      get: (path) =>
        path === OPTIONS_PATH
          ? optionsAnswer({
              recipients: [
                RN,
                { user_id: "u-x", display_name: null },
                { user_id: "u-y", display_name: "  " },
              ],
            })
          : path === POLICY_PATH
            ? policyAnswer
            : undefined,
    });
    await open();
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    expect(screen.getByText(/not listed because their names could not be shown/)).toBeTruthy();
  });

  it("tells two people with the same name apart, and the restated name matches the one chosen", async () => {
    mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />, {
      get: (path) =>
        path === OPTIONS_PATH
          ? optionsAnswer({
              recipients: [
                { user_id: "u-1", display_name: "Sam Lee" },
                { user_id: "u-2", display_name: "Sam Lee" },
              ],
            })
          : path === POLICY_PATH
            ? policyAnswer
            : undefined,
    });
    await open();
    await userEvent.click(screen.getByRole("radio", { name: "Sam Lee (2 of 2)" }));
    expect(screen.getByText(/This goes to Sam Lee \(2 of 2\)/)).toBeTruthy();
    expect(sendBtn().textContent).toBe("Send urgent message to Sam Lee (2 of 2)");
  });
});

describe("the sent status", () => {
  it("clears when the composer text changes", async () => {
    const view = mountWithClient(
      <UrgentMessageButton channelId="c1" kind="care_team" statusResetKey="a" />,
    );
    await open();
    await choose();
    await fill();
    await userEvent.click(sendBtn());
    expect(await screen.findByText(SENT_TEXT)).toBeTruthy();
    view.rerender(
      <MemoryRouter>
        <ApiClientProvider client={view.client}>
          <UrgentMessageButton channelId="c1" kind="care_team" statusResetKey="ab" />
        </ApiClientProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.queryByText(SENT_TEXT)).toBeNull());
  });

  it("clears by itself after a while", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />);
      await open();
      await choose();
      await fill();
      await userEvent.click(sendBtn());
      expect(await screen.findByText(SENT_TEXT)).toBeTruthy();
      await act(async () => void (await vi.advanceTimersByTimeAsync(SENT_STATUS_MS + 100)));
      expect(screen.queryByText(SENT_TEXT)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the discard prompt", () => {
  const dirtyThenAsk = async () => {
    await open();
    await fill("Typing");
    await userEvent.keyboard("{Escape}");
    await screen.findByText(/Close this urgent message/);
  };

  it("Escape inside the prompt means Keep editing, and focus returns to the first section", async () => {
    mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />);
    await dirtyThenAsk();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText(/Close this urgent message/)).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Situation")));
    expect((screen.getByLabelText("Situation") as HTMLTextAreaElement).value).toBe("Typing");
  });

  it("Keep editing also returns focus to the first section", async () => {
    mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />);
    await dirtyThenAsk();
    await userEvent.click(screen.getByRole("button", { name: KEEP_EDITING_LABEL }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Situation")));
  });

  it("disables the form behind it, and describes the prompt", async () => {
    mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />);
    await dirtyThenAsk();
    for (const label of ["Situation", "Background", "Assessment", "Recommendation"]) {
      expect((screen.getByLabelText(label) as HTMLTextAreaElement).disabled).toBe(true);
    }
    expect(screen.getByRole("group", { name: /Send to/ }).hasAttribute("disabled")).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    const prompt = screen.getByRole("alertdialog");
    const text = document.getElementById(prompt.getAttribute("aria-describedby") ?? "");
    expect(text?.textContent).toMatch(/Close this urgent message/);
  });

  it("will not send while the prompt is showing (Ctrl+Enter)", async () => {
    const { POST } = mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />);
    await open();
    await choose();
    await fill("Typing");
    await userEvent.keyboard("{Escape}");
    await screen.findByText(/Close this urgent message/);
    fireEvent.keyDown(screen.getByRole("dialog").querySelector("form") as Element, {
      key: "Enter",
      ctrlKey: true,
    });
    expect(POST).not.toHaveBeenCalled();
  });
});

describe("a refetch while the dialog is open", () => {
  it("keeps the dialog and the draft when the feature is turned off, tells the person, and blocks sending", async () => {
    let calls = 0;
    const { POST } = mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />, {
      get: (path) => {
        if (path !== OPTIONS_PATH) return policyAnswer;
        calls += 1;
        return calls === 1 ? optionsAnswer() : { data: { enabled: false } };
      },
    });
    await open();
    await choose();
    await fill("Do not lose this");
    expect(await screen.findByText(TURNED_OFF_NOTICE)).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((screen.getByLabelText("Situation") as HTMLTextAreaElement).value).toBe(
      "Do not lose this",
    );
    const send = screen.getByRole("button", { name: /Send urgent message/ }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.keyDown(screen.getByLabelText("Situation"), { key: "Enter", ctrlKey: true });
    expect(POST).not.toHaveBeenCalled();
  });

  it("does not shift the recipient list under a person who is already choosing", async () => {
    let calls = 0;
    let release: (v: unknown) => void = () => {};
    const slow = new Promise((resolve) => {
      release = resolve;
    });
    mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />, {
      get: (path) => {
        if (path !== OPTIONS_PATH) return policyAnswer;
        calls += 1;
        return calls === 1 ? optionsAnswer() : slow;
      },
    });
    await open();
    await choose();
    await act(async () =>
      release(optionsAnswer({ recipients: [{ user_id: "u-new", display_name: "New Person" }] })),
    );
    expect(screen.getAllByRole("radio").map((r) => (r as HTMLInputElement).value)).toEqual([
      RN.user_id,
      "u-md",
    ]);
    expect((screen.getByRole("radio", { name: RN.display_name }) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it("applies a fresher list when nothing is chosen yet", async () => {
    let calls = 0;
    mountWithClient(<UrgentMessageButton channelId="c1" kind="care_team" />, {
      get: (path) => {
        if (path !== OPTIONS_PATH) return policyAnswer;
        calls += 1;
        return calls === 1
          ? optionsAnswer()
          : optionsAnswer({ recipients: [{ user_id: "u-new", display_name: "New Person" }] });
      },
    });
    await open();
    await waitFor(() => expect(screen.getByRole("radio", { name: "New Person" })).toBeTruthy());
    expect(screen.getAllByRole("radio")).toHaveLength(1);
  });
});
