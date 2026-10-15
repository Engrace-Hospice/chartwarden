// M36 WP 3.7: the "Chart proposals" tab list - loading, empty, error, rows, Withdraw and focus after a reload.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PromotionsList } from "./promotions-list";
import { PROMOTION_FIXTURE, listAnswer, mountWithClient } from "./promotions-test-fixture";

describe("PromotionsList", () => {
  it("shows the empty state in plain words", async () => {
    mountWithClient(<PromotionsList />, { list: listAnswer([]) });
    expect(await screen.findByText("You have no open chart proposals.")).toBeTruthy();
  });

  it("says so when the list cannot be loaded", async () => {
    mountWithClient(<PromotionsList />, { list: { data: undefined } });
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be loaded/);
  });

  it("lists a proposal with status, target and a link back, and no message text", async () => {
    mountWithClient(<PromotionsList />, { list: listAnswer([PROMOTION_FIXTURE]) });
    const row = await screen.findByRole("listitem");
    expect(within(row).getByText("Proposed")).toBeTruthy();
    expect(within(row).getByText("Encounter addendum")).toBeTruthy();
    expect(within(row).getByRole("link", { name: "Open message" }).getAttribute("href")).toBe(
      "/messaging?channelId=c1&messageId=m1",
    );
  });

  it("reads the closed list when asked", async () => {
    const { GET } = mountWithClient(<PromotionsList />, { list: listAnswer([]) });
    await screen.findByText("You have no open chart proposals.");
    await userEvent.click(screen.getByRole("button", { name: "Closed" }));
    await waitFor(() =>
      expect(GET).toHaveBeenLastCalledWith("/api/v1/messaging/chart-promotions", {
        params: { query: { status: "closed" } },
      }),
    );
  });

  it("withdraws, re-reads and moves focus to the heading when the row leaves", async () => {
    const post = vi.fn().mockResolvedValue({
      data: { promotion: { ...PROMOTION_FIXTURE, status: "withdrawn", allowed_actions: [] } },
      response: { status: 200 },
    });
    const { GET } = mountWithClient(<PromotionsList />, {
      list: listAnswer([PROMOTION_FIXTURE]),
      post,
    });
    await userEvent.click(await screen.findByRole("button", { name: "Withdraw proposal" }));
    await waitFor(() => expect(GET.mock.calls.length).toBeGreaterThan(1));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Chart proposals" }));
    expect(document.querySelector("output")?.textContent).toBe("Proposal withdrawn.");
  });

  it("offers no Withdraw when the server does not allow it", async () => {
    mountWithClient(<PromotionsList />, {
      list: listAnswer([{ ...PROMOTION_FIXTURE, status: "accepted", allowed_actions: [] }]),
    });
    await screen.findByRole("listitem");
    expect(screen.queryByRole("button", { name: "Withdraw proposal" })).toBeNull();
  });
});
