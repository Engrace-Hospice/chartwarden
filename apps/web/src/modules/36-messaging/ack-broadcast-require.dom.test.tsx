// M36 WP 6.8 (ADR-0097) - "Require acknowledgment" in the announcement receipts dialog: one explicit click, one POST, and a 404 is said as the
// likelier causes (flag off, or not the author) rather than as success.
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnnouncementReceiptsDialog } from "./announcement-receipts";

type Reply = { data?: unknown; error?: unknown; response?: { status: number } };

function open(post: () => Reply) {
  const GET = vi.fn(async () => ({
    data: { recipientCount: 0, readCount: 0, readers: [], unread: [], truncated: false },
  }));
  const POST = vi.fn(async () => post());
  render(
    <ApiClientProvider client={{ GET, POST } as unknown as ApiClient}>
      <AnnouncementReceiptsDialog messageId="m1" onClose={() => undefined} />
    </ApiClientProvider>,
  );
  return POST;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Require acknowledgment", () => {
  it("is an explicit click that posts once and says what happened", async () => {
    const POST = open(() => ({ data: { created: true } }));
    fireEvent.click(await screen.findByRole("button", { name: "Require acknowledgment" }));
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Acknowledgment is now required/)).toBeTruthy();
  });

  it("says the likelier cause on a 404 (flag off or not the author)", async () => {
    open(() => ({ error: {}, response: { status: 404 } }));
    fireEvent.click(await screen.findByRole("button", { name: "Require acknowledgment" }));
    expect(await screen.findByText(/not turned on for your organization/)).toBeTruthy();
  });

  it("does not post anything until clicked", async () => {
    const POST = open(() => ({ data: {} }));
    await screen.findByRole("button", { name: "Require acknowledgment" });
    expect(POST).not.toHaveBeenCalled();
  });
});
