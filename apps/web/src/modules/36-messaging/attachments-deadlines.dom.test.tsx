import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentChips } from "./attachment-composer";
import {
  ATTACHMENT_ID,
  STORE_PATHS,
  attach,
  authorizedWith,
  completed,
  envelope,
  fakeTab,
  mountThread,
  pdf,
  sendButton,
  status,
} from "./attachments-test-support";
import type { AttachmentChip } from "./messaging-types";

// AbortSignal.timeout runs on Node's own timers, which fake timers do not move: capture and fire by hand.
const deadlines: AbortController[] = [];
beforeEach(() => {
  deadlines.length = 0;
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    const controller = new AbortController();
    deadlines.push(controller);
    return controller.signal;
  });
});
const expireDeadlines = () =>
  act(async () => {
    for (const controller of deadlines) controller.abort(new DOMException("t", "TimeoutError"));
  });
/** A reply that never comes; rejects when the request is aborted, like fetch. */
const hang = (init: Record<string, unknown>) =>
  new Promise((_, reject) => {
    const signal = init.signal as AbortSignal | undefined;
    signal?.addEventListener("abort", () => reject(signal.reason));
  });

const inList = () => within(screen.getByRole("list", { name: "Attached files" }));
const setDraft = (value: string) =>
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value } });
const FILE_ROW = {
  attachmentId: ATTACHMENT_ID,
  fileName: "plan.pdf",
  mimeType: "application/pdf",
  byteSize: 2_500_000,
  availability: "available",
};
const listWithFile = (path: string) =>
  path === STORE_PATHS.messages
    ? {
        data: {
          messages: [
            {
              messageId: "m-0",
              channelId: "dm-1",
              authorUserId: "u",
              authorDisplayName: "Nurse Two",
              body: "hi",
              bodyKind: "plain",
              createdAt: "2026-10-10T09:00:00.000Z",
              parentMessageId: null,
              references: [],
              attachments: [FILE_ROW],
            },
          ],
        },
        error: undefined,
      }
    : undefined;

describe("WP 1.5 request deadlines", () => {
  it("fails a chip whose authorize never answers, and lets the user remove it and send", async () => {
    mountThread({
      POST: (path, init) => (path === STORE_PATHS.uploads ? hang(init) : undefined),
    });
    await attach([pdf()]);
    await waitFor(() => expect(deadlines.length).toBeGreaterThan(0));
    await expireDeadlines();
    await waitFor(() => expect(inList().getByText("Failed")).toBeTruthy());
    expect(inList().getByText(/took too long/)).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
    fireEvent.click(inList().getByRole("button", { name: "Remove report.pdf" }));
    setDraft("hello");
    expect(sendButton().disabled).toBe(false);
  });

  it("fails a chip whose complete never answers with a retryable state", async () => {
    mountThread({
      POST: (path, init) =>
        path === STORE_PATHS.uploads
          ? authorizedWith(ATTACHMENT_ID)
          : path === STORE_PATHS.complete
            ? hang(init)
            : undefined,
    });
    await attach([pdf()]);
    await waitFor(() => expect(deadlines.length).toBeGreaterThan(1));
    await expireDeadlines();
    await waitFor(() => expect(inList().getByText("Failed")).toBeTruthy());
    expect(inList().getByText(/took too long/)).toBeTruthy();
    expect(inList().getByRole("button", { name: "Retry report.pdf" })).toBeTruthy();
    expect(inList().getByRole("button", { name: "Remove report.pdf" })).toBeTruthy();
  });

  it("labels a chip Scanning while complete is in flight, yet holds Send until the server answers", async () => {
    mountThread({
      POST: (path, init) =>
        path === STORE_PATHS.uploads
          ? authorizedWith(ATTACHMENT_ID)
          : path === STORE_PATHS.complete
            ? hang(init)
            : undefined,
    });
    await attach([pdf()]);
    await waitFor(() => expect(inList().getByText("Scanning…")).toBeTruthy());
    expect(inList().queryByText("Uploading…")).toBeNull();
    expect(sendButton().disabled).toBe(true);
  });

  it("closes the pre-opened tab and shows the unavailable state when the access read never answers", async () => {
    const tab = fakeTab();
    const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    mountThread({
      GET: (path, init) => (path === STORE_PATHS.access ? hang(init) : listWithFile(path)),
    });
    const button = await screen.findByRole("button", { name: "Open plan.pdf in a new tab" });
    fireEvent.click(button);
    await waitFor(() => expect(deadlines.length).toBeGreaterThan(0));
    await expireDeadlines();
    await screen.findByText("File unavailable");
    expect(tab.close).toHaveBeenCalled();
    expect(button.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(button);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("recovers from a blocked pop-up on the next click", async () => {
    const tab = fakeTab();
    const open = vi
      .spyOn(window, "open")
      .mockReturnValueOnce(null)
      .mockReturnValue(tab as unknown as Window);
    mountThread({
      GET: (path) =>
        path === STORE_PATHS.access
          ? { data: { url: "https://objects.example.test/f?sig=1" }, error: undefined }
          : listWithFile(path),
    });
    const button = await screen.findByRole("button", { name: "Open plan.pdf in a new tab" });
    fireEvent.click(button);
    await screen.findByText("Allow pop-ups to open files");
    fireEvent.click(button);
    await waitFor(() => expect(tab.location.replace).toHaveBeenCalled());
    expect(open).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByText("Allow pop-ups to open files")).toBeNull());
  });
});

describe("WP 1.5 refused send that names no culprit", () => {
  const refused = (statusReply: (init: Record<string, unknown>) => unknown) =>
    mountThread({
      POST: (path) => {
        if (path === STORE_PATHS.uploads) return authorizedWith(ATTACHMENT_ID);
        if (path === STORE_PATHS.complete) return completed("available");
        if (path === STORE_PATHS.messages) return envelope("ATTACHMENT_NOT_BINDABLE", "x", 422);
        return undefined;
      },
      GET: (path, init) => (path === STORE_PATHS.status ? statusReply(init) : undefined),
    });
  async function sendRefused() {
    await attach([pdf()]);
    await waitFor(() => expect(inList().getByText("Ready")).toBeTruthy());
    setDraft("keep me");
    await act(async () => {
      fireEvent.click(sendButton());
    });
  }

  it("marks every attached chip as needing re-attach when the recheck flags none", async () => {
    refused(() => ({ data: status("available"), error: undefined }));
    await sendRefused();
    await waitFor(() => expect(inList().getByText("Re-attach")).toBeTruthy());
    expect(inList().queryByText("Ready")).toBeNull();
    expect(sendButton().disabled).toBe(true);
    fireEvent.click(inList().getByRole("button", { name: "Remove report.pdf" }));
    expect(sendButton().disabled).toBe(false);
  });

  it("leaves the chips alone when the recheck times out", async () => {
    refused((init) => hang(init));
    await sendRefused();
    await waitFor(() => expect(deadlines.length).toBeGreaterThan(0));
    await expireDeadlines();
    await act(async () => {});
    expect(inList().getByText("Ready")).toBeTruthy();
    expect(inList().queryByText("Re-attach")).toBeNull();
  });

  it("leaves every chip alone when one read was answered and another was unreachable", async () => {
    mountThread({
      POST: (path, init) => {
        if (path === STORE_PATHS.uploads) {
          return authorizedWith(
            (init.body as { fileName: string }).fileName === "a.pdf" ? "id-a" : "id-b",
          );
        }
        if (path === STORE_PATHS.complete) return completed("available");
        if (path === STORE_PATHS.messages) return envelope("ATTACHMENT_NOT_BINDABLE", "x", 422);
        return undefined;
      },
      GET: (path, init) => {
        if (path !== STORE_PATHS.status) return undefined;
        const id = (init.params as { path: { id: string } }).path.id;
        return id === "id-a"
          ? { data: status("available"), error: undefined }
          : { data: undefined, error: { error: {} }, response: { status: 503 } };
      },
    });
    await attach([pdf("a.pdf"), pdf("b.pdf")]);
    await waitFor(() => expect(inList().getAllByText("Ready")).toHaveLength(2));
    setDraft("keep me");
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await screen.findByText(/can no longer be attached/);
    await act(async () => {});
    expect(inList().getAllByText("Ready")).toHaveLength(2);
    expect(inList().queryByText("Re-attach")).toBeNull();
  });

  it("drops a recheck result for a chip whose status changed while the read was in flight", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let statusReads = 0;
    mountThread({
      POST: (path) => {
        if (path === STORE_PATHS.uploads) return authorizedWith(ATTACHMENT_ID);
        if (path === STORE_PATHS.complete) return completed("scanning");
        if (path === STORE_PATHS.messages) return envelope("ATTACHMENT_NOT_BINDABLE", "x", 422);
        return undefined;
      },
      GET: (path) => {
        if (path !== STORE_PATHS.status) return undefined;
        statusReads += 1;
        // Read 1 is the recheck (held open, then "blocked"); read 2 is the poll that makes the chip Ready.
        return statusReads === 1
          ? gate.then(() => ({ data: status("blocked"), error: undefined }))
          : { data: status("available"), error: undefined };
      },
    });
    await attach([pdf()]);
    await waitFor(() => expect(inList().getByText("Scanning…")).toBeTruthy());
    setDraft("keep me");
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await act(async () => vi.advanceTimersByTimeAsync(3_500));
    await waitFor(() => expect(inList().getByText("Ready")).toBeTruthy());
    await act(async () => {
      release();
    });
    expect(inList().getByText("Ready")).toBeTruthy();
    expect(inList().queryByText("Blocked")).toBeNull();
    vi.useRealTimers();
  });
});

describe("WP 1.5 focus after removing the last chip", () => {
  it("falls back to the textbox when the Attach button is disabled", () => {
    const chip: AttachmentChip = {
      localId: "l1",
      file: pdf(),
      fileName: "a.pdf",
      contentType: "application/pdf",
      byteSize: 9,
      status: "ready",
      message: null,
      attachmentId: "x",
    };
    const attachRef = { current: null as HTMLButtonElement | null };
    function Harness({ chips }: { chips: readonly AttachmentChip[] }) {
      return (
        <form>
          <AttachmentChips
            uploads={{ chips, notices: [], remove: () => {}, retry: () => {} }}
            disabled={false}
            attachButtonRef={attachRef as never}
          />
          <textarea aria-label="Message" />
          <button type="button" disabled ref={attachRef}>
            attach
          </button>
        </form>
      );
    }
    const view = render(<Harness chips={[chip]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove a.pdf" }));
    view.rerender(<Harness chips={[]} />);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message" }));
  });
});
