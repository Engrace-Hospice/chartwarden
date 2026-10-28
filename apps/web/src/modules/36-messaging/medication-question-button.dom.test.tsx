import { ApiClientProvider } from "@chartwarden/ui";
// M36 WP 3.10: the composer action is shown only when the options route allows it, and keeps its outcome on screen.
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { MedicationQuestionButton } from "./medication-question-button";
import {
  OPTIONS_PATH,
  mountWithClient,
  optionsAnswer,
  sentAnswer,
} from "./medication-question-test-fixture";
import {
  ASK_BUTTON_LABEL,
  SENT_ROUTED_TEXT,
  SENT_UNROUTED_TEXT,
} from "./medication-question-wording";

describe("MedicationQuestionButton", () => {
  it("renders nothing while the options route says the entry is off", async () => {
    const { GET } = mountWithClient(<MedicationQuestionButton channelId="c1" kind="care_team" />, {
      get: () => ({ data: { enabled: false } }),
    });
    await waitFor(() => expect(GET).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: ASK_BUTTON_LABEL })).toBeNull();
  });

  it("makes no read at all outside a care-team conversation", () => {
    const { GET } = mountWithClient(<MedicationQuestionButton channelId="c1" kind="dm" />);
    expect(GET).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: ASK_BUTTON_LABEL })).toBeNull();
  });

  it("is hidden after a 403 (fail closed)", async () => {
    const { GET } = mountWithClient(<MedicationQuestionButton channelId="c1" kind="care_team" />, {
      get: () => ({ error: { error: { code: "FORBIDDEN" } }, response: { status: 403 } }),
    });
    await waitFor(() => expect(GET).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: ASK_BUTTON_LABEL })).toBeNull();
  });

  it("opens the dialog, sends, returns focus to the trigger and keeps a focusable status", async () => {
    const onSent = vi.fn();
    mountWithClient(<MedicationQuestionButton channelId="c1" kind="care_team" onSent={onSent} />);
    const trigger = await screen.findByRole("button", { name: ASK_BUTTON_LABEL });
    await userEvent.click(trigger);
    await userEvent.type(await screen.findByLabelText("Your question"), "Is the dose right?");
    await userEvent.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    const status = await screen.findByText(SENT_ROUTED_TEXT);
    expect(status.tabIndex).toBe(0);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: ASK_BUTTON_LABEL })),
    );
  });

  it("states plainly when the question went out without a nurse", async () => {
    mountWithClient(<MedicationQuestionButton channelId="c1" kind="care_team" />, {
      get: (path) =>
        path === OPTIONS_PATH
          ? optionsAnswer({ nurse: null, colleagues: [] })
          : { error: {}, response: { status: 403 } },
      post: vi.fn().mockResolvedValue(sentAnswer({ routed: false })),
    });
    await userEvent.click(await screen.findByRole("button", { name: ASK_BUTTON_LABEL }));
    await userEvent.type(await screen.findByLabelText("Your question"), "Question");
    await userEvent.click(screen.getByRole("button", { name: /Send without a nurse/ }));
    expect(await screen.findByText(SENT_UNROUTED_TEXT)).toBeTruthy();
  });

  it("returns focus to the trigger when the dialog is closed with Escape", async () => {
    mountWithClient(<MedicationQuestionButton channelId="c1" kind="care_team" />);
    await userEvent.click(await screen.findByRole("button", { name: ASK_BUTTON_LABEL }));
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: ASK_BUTTON_LABEL }));
  });

  it("shows nothing from the old channel after a switch and does not steal focus", async () => {
    const view = mountWithClient(<MedicationQuestionButton channelId="c1" kind="care_team" />, {
      get: (path) => (path === OPTIONS_PATH ? optionsAnswer() : { data: { orders: [] } }),
    });
    await userEvent.click(await screen.findByRole("button", { name: ASK_BUTTON_LABEL }));
    await screen.findByRole("dialog");
    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    view.rerender(
      <MemoryRouter>
        <ApiClientProvider client={view.client}>
          <MedicationQuestionButton channelId="c2" kind="care_team" />
        </ApiClientProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
