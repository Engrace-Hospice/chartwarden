// M36 WP 4.1: the composer action is shown only when the options route allows it and the channel is a patient care-team
// conversation; the dialog shows the emergency-procedure notice, requires a chosen recipient and the SBAR sections, and
// sends exactly what the server needs (an SBAR document, one recipient, a client id); the outcome stays on screen.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { UrgentMessageButton } from "./urgent-message-button";
import {
  OPTIONS_PATH,
  RN,
  mountWithClient,
  optionsAnswer,
  refusal,
  sentAnswer,
} from "./urgent-test-fixture";
import {
  NOT_EMERGENCY_NOTICE,
  NO_PAGE_NOTICE,
  NO_RECIPIENT_TEXT,
  SENT_REPLAY_TEXT,
  SENT_TEXT,
  URGENT_BUTTON_LABEL,
} from "./urgent-wording";

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
    expect((await screen.findByRole("alert")).textContent).toMatch(/Choose who this goes to/);
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
      <UrgentMessageButton channelId="c1" kind="care_team" onSent={onSent} />,
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
      get: (path) => (path === OPTIONS_PATH ? optionsAnswer({ recipients: [] }) : undefined),
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
