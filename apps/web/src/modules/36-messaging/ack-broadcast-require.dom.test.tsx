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
  const client = { GET, POST } as unknown as ApiClient;
  const ui = (id: string) => (
    <ApiClientProvider client={client}>
      <AnnouncementReceiptsDialog messageId={id} onClose={() => undefined} />
    </ApiClientProvider>
  );
  const view = render(ui("m1"));
  Object.assign(POST, { switchTo: (id: string) => view.rerender(ui(id)) });
  return POST as typeof POST & { switchTo: (id: string) => void };
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
    expect(await screen.findByText(/only the author of this announcement can require acknowledgment/)).toBeTruthy();
  });

  it("says to try again on a server or network failure, not that only the author can do this", async () => {
    open(() => ({ error: {}, response: { status: 503 } }));
    fireEvent.click(await screen.findByRole("button", { name: "Require acknowledgment" }));
    expect(await screen.findByText(/Try again\./)).toBeTruthy();
    expect(screen.queryByText(/only the author/)).toBeNull();
  });

  it("posts once on a double click", async () => {
    let release!: (r: Reply) => void;
    const held = new Promise<Reply>((r) => {
      release = r;
    });
    const POST = open(() => held as unknown as Reply);
    const button = await screen.findByRole("button", { name: "Require acknowledgment" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(POST).toHaveBeenCalledTimes(1);
    release({ data: { created: true } });
    expect(await screen.findByText(/Acknowledgment is now required/)).toBeTruthy();
  });

  it("drops a late answer for an earlier announcement after the dialog moves to another", async () => {
    let release!: (r: Reply) => void;
    const held = new Promise<Reply>((r) => {
      release = r;
    });
    const POST = open(() => held as unknown as Reply);
    fireEvent.click(await screen.findByRole("button", { name: "Require acknowledgment" }));
    POST.switchTo("m2");
    release({ data: { created: true } });
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByText(/Acknowledgment is now required/)).toBeNull();
    expect((screen.getByRole("button", { name: "Require acknowledgment" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not post anything until clicked", async () => {
    const POST = open(() => ({ data: {} }));
    await screen.findByRole("button", { name: "Require acknowledgment" });
    expect(POST).not.toHaveBeenCalled();
  });
});
