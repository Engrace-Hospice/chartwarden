// M36 WP 3.7: the message-row "Propose for chart" trigger, its dialog and the per-message status chip. Gating comes from
// the list route's `enabled`, the viewer's permission and the channel kind; nothing is shown otherwise.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MessagePromotionButton } from "./message-promotion-button";
import { PROMOTION_FIXTURE, listAnswer, mountWithClient } from "./promotions-test-fixture";

const POST_PATH = "/api/v1/messaging/channels/{id}/messages/{messageId}/chart-promotions";
const row = (patientLinked = true) => (
  <MessagePromotionButton channelId="c1" messageId="m1" patientLinked={patientLinked} />
);
const created = (promotion = PROMOTION_FIXTURE, wasCreated = true) =>
  vi
    .fn()
    .mockResolvedValue({ data: { promotion, created: wasCreated }, response: { status: 201 } });
const refused = (status: number, code: string) =>
  vi.fn().mockResolvedValue({
    data: undefined,
    error: { error: { code, message: "server text" } },
    response: { status },
  });

describe("MessagePromotionButton visibility", () => {
  it("renders nothing while the tenant has chart proposals off", async () => {
    const { GET } = mountWithClient(row(), { list: listAnswer([], false) });
    await waitFor(() => expect(GET).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /propose/i })).toBeNull();
  });

  it("renders nothing when the read fails (fails closed)", async () => {
    const { GET } = mountWithClient(row(), { list: { data: undefined } });
    await waitFor(() => expect(GET).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /propose/i })).toBeNull();
  });

  it("renders nothing without messaging.promote", async () => {
    const { GET } = mountWithClient(row(), { permissions: ["messaging.send"] });
    await Promise.resolve();
    expect(screen.queryByRole("button", { name: /propose/i })).toBeNull();
    // A viewer who cannot propose never issues the index read.
    expect(GET).not.toHaveBeenCalled();
  });

  it("renders nothing outside a patient-linked conversation", async () => {
    const { GET } = mountWithClient(row(false));
    await Promise.resolve();
    expect(screen.queryByRole("button", { name: /propose/i })).toBeNull();
    expect(GET).not.toHaveBeenCalled();
  });

  it("reads the list route's enabled flag, never a feature-flag hook", async () => {
    const { GET } = mountWithClient(row());
    await screen.findByRole("button", { name: /^propose for chart/i });
    expect(GET).toHaveBeenCalledWith(
      "/api/v1/messaging/chart-promotions",
      expect.objectContaining({ params: { query: expect.objectContaining({ status: "all" }) } }),
    );
  });
});

describe("Propose dialog", () => {
  async function openDialog() {
    await userEvent.click(await screen.findByRole("button", { name: /^propose for chart/i }));
    return screen.findByRole("dialog");
  }

  it("says nothing enters the chart and sends only the target, never any text", async () => {
    const post = created();
    mountWithClient(row(), { post });
    const dialog = await openDialog();
    expect(within(dialog).getByText(/Nothing enters the chart until they decide/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("radio", { name: /IDG agenda item/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Send for review" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith(POST_PATH, {
      params: { path: { id: "c1", messageId: "m1" } },
      body: { target_module: "m14", target_kind: "idg_agenda_item" },
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.querySelector("output")?.textContent).toMatch(/Proposal sent for review/);
  });

  it("returns focus to the trigger when the dialog closes", async () => {
    mountWithClient(row(), { post: created() });
    const trigger = await screen.findByRole("button", { name: /^propose for chart/i });
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("asks for a target before sending anything", async () => {
    const post = created();
    mountWithClient(row(), { post });
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("button", { name: "Send for review" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/Choose where/);
    expect(post).not.toHaveBeenCalled();
  });

  it("says a replayed proposal was not changed", async () => {
    mountWithClient(row(), { post: created(PROMOTION_FIXTURE, false) });
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("radio", { name: /Encounter addendum/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Send for review" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.querySelector("output")?.textContent).toMatch(/already proposed/);
  });

  it.each([
    ["PROMOTION_TARGET_INVALID", /not available for chart proposals/],
    ["PROMOTION_SOURCE_NOT_PATIENT_LINKED", /patient's care-team conversation/],
    ["PROMOTION_SUGGESTED_REF_INVALID", /suggested record/],
  ])("maps %s to its own wording without echoing server text", async (code, pattern) => {
    mountWithClient(row(), { post: refused(422, code) });
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("radio", { name: /Encounter addendum/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Send for review" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toMatch(pattern);
    expect(alert.textContent).not.toMatch(/server text/);
  });
});

describe("per-message status chip", () => {
  it("shows the caller's proposal on this message only, with Withdraw from allowed_actions", async () => {
    mountWithClient(row(), {
      list: listAnswer([
        PROMOTION_FIXTURE,
        { ...PROMOTION_FIXTURE, id: "pr2", message_id: "other", status: "rejected" },
      ]),
    });
    expect(await screen.findByText("Encounter addendum: Proposed")).toBeTruthy();
    expect(screen.queryByText(/Declined by reviewer/)).toBeNull();
    expect(screen.getByRole("button", { name: "Withdraw proposal" })).toBeTruthy();
  });

  it("offers no Withdraw on a decided proposal", async () => {
    mountWithClient(row(), {
      list: listAnswer([{ ...PROMOTION_FIXTURE, status: "accepted", allowed_actions: [] }]),
    });
    expect(await screen.findByText("Encounter addendum: Accepted by reviewer")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Withdraw proposal" })).toBeNull();
  });

  it("withdraws through the server and reports it", async () => {
    const post = vi.fn().mockResolvedValue({
      data: { promotion: { ...PROMOTION_FIXTURE, status: "withdrawn", allowed_actions: [] } },
      response: { status: 200 },
    });
    const { GET } = mountWithClient(row(), { list: listAnswer([PROMOTION_FIXTURE]), post });
    await userEvent.click(await screen.findByRole("button", { name: "Withdraw proposal" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/api/v1/messaging/chart-promotions/{promotionId}/withdraw",
        {
          params: { path: { promotionId: "pr1" } },
        },
      ),
    );
    await waitFor(() =>
      expect(document.querySelector("output")?.textContent).toBe("Proposal withdrawn."),
    );
    expect(GET.mock.calls.length).toBeGreaterThan(1);
  });

  it("explains a refused withdraw", async () => {
    mountWithClient(row(), {
      list: listAnswer([PROMOTION_FIXTURE]),
      post: refused(409, "PROMOTION_STATE_CONFLICT"),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Withdraw proposal" }));
    await waitFor(() =>
      expect(document.querySelector("output")?.textContent).toMatch(/changed since you opened/),
    );
  });
});
