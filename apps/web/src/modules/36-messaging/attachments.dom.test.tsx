import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_ID,
  PUT_HEADERS,
  PUT_URL,
  SIGNED_URL,
  STORE_PATHS,
  attach,
  authorized,
  calls,
  chipList,
  completed,
  envelope,
  fakeTab,
  fetchMock,
  mountThread,
  pdf,
  sendButton,
  sha,
  status,
} from "./attachments-test-support";

describe("WP 1.5 composer attachments", () => {
  it("hashes, authorizes, PUTs with exactly the returned headers, completes, then sends the attachment id", async () => {
    const { api } = mountThread({
      POST: (path) =>
        path === STORE_PATHS.uploads
          ? authorized
          : path === STORE_PATHS.complete
            ? completed("available")
            : undefined,
    });
    const file = pdf();
    await attach([file]);

    await waitFor(() => expect(within(chipList()!).getByText("Ready")).toBeTruthy());
    const [, authInit] = calls(api, STORE_PATHS.uploads)[0]!;
    expect(authInit.params.header["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(authInit.body).toEqual({
      channelId: "dm-1",
      fileName: "report.pdf",
      contentType: "application/pdf",
      byteSize: 9,
      sha256Hex: sha("hello pdf"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [putUrl, putInit] = fetchMock.mock.calls[0]!;
    expect(putUrl).toBe(PUT_URL);
    expect(putInit.method).toBe("PUT");
    expect(putInit.headers).toEqual(PUT_HEADERS);
    expect(putInit.body).toBe(file);
    const [, completeInit] = calls(api, STORE_PATHS.complete)[0]!;
    expect(completeInit.params.path.id).toBe(ATTACHMENT_ID);
    expect(completeInit.params.header["Idempotency-Key"]).not.toBe(
      authInit.params.header["Idempotency-Key"],
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "see attached" },
    });
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await waitFor(() => expect(calls(api, STORE_PATHS.messages)).toHaveLength(1));
    expect(calls(api, STORE_PATHS.messages)[0]![1].body).toMatchObject({
      body: "see attached",
      attachments: [{ attachmentId: ATTACHMENT_ID }],
    });
    await waitFor(() => expect(chipList()).toBeNull());
  });

  it("rejects wrong type, oversize, empty files and anything past ten, with plain messages", async () => {
    mountThread();
    const big = pdf("huge.pdf");
    Object.defineProperty(big, "size", { value: 25_000_001 });
    const exe = new File(["x"], "run.exe", { type: "application/x-msdownload" });
    const empty = new File([], "empty.pdf", { type: "application/pdf" });
    await attach([exe, big, empty]);
    expect(await screen.findByText(/run\.exe was not attached: use PDF, JPEG/)).toBeTruthy();
    expect(screen.getByText("huge.pdf was not attached: files can be at most 25 MB.")).toBeTruthy();
    expect(screen.getByText("empty.pdf was not attached: the file is empty.")).toBeTruthy();
    expect(chipList()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    await attach(Array.from({ length: 11 }, (_, i) => pdf(`f${i}.pdf`)));
    expect(
      await screen.findByText(/f10\.pdf was not attached: a message can have at most 10/),
    ).toBeTruthy();
    expect(within(chipList()!).getAllByRole("listitem")).toHaveLength(10);
  });

  it("reuses the Idempotency-Key after a lost reply and rotates it after an answered 5xx", async () => {
    let attempt = 0;
    const { api } = mountThread({
      POST: (path) => {
        if (path !== STORE_PATHS.uploads)
          return path === STORE_PATHS.complete ? completed("available") : undefined;
        attempt += 1;
        if (attempt === 1) throw new TypeError("Failed to fetch");
        if (attempt === 2) {
          return envelope("INTERNAL", "boom", 503);
        }
        return authorized;
      },
    });
    await attach([pdf()]);
    await screen.findByText("Failed");
    fireEvent.click(screen.getByRole("button", { name: "Retry report.pdf" }));
    await waitFor(() => expect(calls(api, STORE_PATHS.uploads)).toHaveLength(2));
    await waitFor(() =>
      expect(within(chipList()!).getByText(/The upload could not be started/)).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry report.pdf" }));
    await waitFor(() => expect(within(chipList()!).getByText("Ready")).toBeTruthy());

    const keys = calls(api, STORE_PATHS.uploads).map(
      ([, init]) => init.params.header["Idempotency-Key"],
    );
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("shows a retryable failure when the PUT network request rejects, then resumes at the PUT", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { api } = mountThread({
      POST: (path) =>
        path === STORE_PATHS.uploads
          ? authorized
          : path === STORE_PATHS.complete
            ? completed("available")
            : undefined,
    });
    await attach([pdf()]);
    await screen.findByText("Failed");
    fireEvent.click(screen.getByRole("button", { name: "Retry report.pdf" }));
    await waitFor(() => expect(within(chipList()!).getByText("Ready")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls(api, STORE_PATHS.uploads)).toHaveLength(1);
  });

  it("disables Send while a file is uploading, and lets a still-scanning file be sent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { api } = mountThread({
      POST: (path) =>
        path === STORE_PATHS.uploads
          ? gate.then(() => authorized)
          : path === STORE_PATHS.complete
            ? completed("scanning")
            : undefined,
    });
    fireEvent.change(await screen.findByRole("textbox", { name: "Message" }), {
      target: { value: "note" },
    });
    expect(sendButton().disabled).toBe(false);
    await attach([pdf()]);
    await waitFor(() => expect(sendButton().disabled).toBe(true));
    await act(async () => {
      release();
    });
    await waitFor(() => expect(within(chipList()!).getByText("Scanning…")).toBeTruthy());
    expect(sendButton().disabled).toBe(false);
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await waitFor(() => expect(calls(api, STORE_PATHS.messages)).toHaveLength(1));
    expect(calls(api, STORE_PATHS.messages)[0]![1].body.attachments).toEqual([
      { attachmentId: ATTACHMENT_ID },
    ]);
    // The uploader sees their own scanning file with no open button.
    expect(await screen.findByRole("list", { name: "Attachments" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open report.pdf" })).toBeNull();
  });

  it("keeps the draft and chips, and says so plainly, when the send is refused as not bindable", async () => {
    const { api } = mountThread({
      POST: (path) =>
        path === STORE_PATHS.uploads
          ? authorized
          : path === STORE_PATHS.complete
            ? completed("available")
            : path === STORE_PATHS.messages
              ? envelope("ATTACHMENT_NOT_BINDABLE", "internal detail", 422)
              : undefined,
    });
    await attach([pdf()]);
    await waitFor(() => expect(within(chipList()!).getByText("Ready")).toBeTruthy());
    const composer = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "keep me" } });
    await act(async () => {
      fireEvent.click(sendButton());
    });
    expect(await screen.findByText(/can no longer be attached/)).toBeTruthy();
    expect(screen.queryByText(/internal detail/)).toBeNull();
    expect(composer.value).toBe("keep me");
    expect(chipList()).not.toBeNull();
    expect(calls(api, STORE_PATHS.messages)).toHaveLength(1);
  });

  it("clears chips when the channel changes and ignores a late authorize reply", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { api, view, tree } = mountThread({
      POST: (path) => (path === STORE_PATHS.uploads ? gate.then(() => authorized) : undefined),
    });
    await attach([pdf()]);
    await waitFor(() => expect(chipList()).not.toBeNull());
    view.rerender(tree("dm-2"));
    await waitFor(() => expect(chipList()).toBeNull());
    await act(async () => {
      release();
    });
    expect(chipList()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls(api, STORE_PATHS.complete)).toHaveLength(0);
  });

  it("polls a scanning file until it is available", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let polls = 0;
      mountThread({
        POST: (path) =>
          path === STORE_PATHS.uploads
            ? authorized
            : path === STORE_PATHS.complete
              ? completed("scanning")
              : undefined,
        GET: (path) => {
          if (path !== STORE_PATHS.status) return undefined;
          polls += 1;
          return { data: status(polls < 2 ? "scanning" : "available"), error: undefined };
        },
      });
      await attach([pdf()]);
      await waitFor(() => expect(within(chipList()!).getByText("Scanning…")).toBeTruthy());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_100);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_100);
      });
      await waitFor(() => expect(within(chipList()!).getByText("Ready")).toBeTruthy());
    } finally {
      vi.useRealTimers();
    }
  });
});

const messageWith = (attachments: unknown[]) => ({
  messageId: "m-9",
  channelId: "dm-1",
  authorUserId: "someone-else",
  authorDisplayName: "Nurse Two",
  body: "files",
  bodyKind: "plain",
  createdAt: "2026-10-10T09:00:00.000Z",
  parentMessageId: null,
  references: [],
  attachments,
});
const listWith = (attachments: unknown[]) => (path: string) =>
  path === STORE_PATHS.messages
    ? { data: { messages: [messageWith(attachments)] }, error: undefined }
    : undefined;
const FILE_ROW = {
  attachmentId: ATTACHMENT_ID,
  fileName: "plan.pdf",
  mimeType: "application/pdf",
  byteSize: 2_500_000,
  availability: "available",
};

describe("WP 1.5 message attachments", () => {
  const accessReply = (url: string) => ({
    data: {
      url,
      expiresAt: "2026-10-10T09:02:00.000Z",
      fileName: "plan.pdf",
      mimeType: "application/pdf",
      byteSize: 2_500_000,
    },
    error: undefined,
  });
  const accessCalls = (api: { GET: ReturnType<typeof vi.fn> }) =>
    api.GET.mock.calls.filter(([p]) => p === STORE_PATHS.access);

  it("opens the tab inside the click, then points it at a fresh URL that never reaches the DOM", async () => {
    const tab = fakeTab();
    const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { api, view } = mountThread({
      GET: (path) =>
        path === STORE_PATHS.access
          ? gate.then(() => accessReply(SIGNED_URL))
          : listWith([FILE_ROW])(path),
    });
    const button = await screen.findByRole("button", { name: "Open plan.pdf in a new tab" });
    expect(screen.getByText(/2\.5 MB/)).toBeTruthy();

    fireEvent.click(button);
    // Synchronously, before the access reply: a popup blocker only allows this inside the gesture.
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(tab.opener).toBeNull();
    expect(tab.location.replace).not.toHaveBeenCalled();
    await act(async () => {
      release();
    });
    await waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith(SIGNED_URL));
    expect(tab.close).not.toHaveBeenCalled();
    await waitFor(() => expect(button.getAttribute("aria-disabled")).not.toBe("true"));

    fireEvent.click(button);
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(accessCalls(api)).toHaveLength(2));
    expect(view.container.innerHTML).not.toContain("secret-signed-url");
    expect(view.container.innerHTML).not.toContain("sig=abc123");
  });

  it("makes one access call for a double click and keeps focus on the button", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(fakeTab() as unknown as Window);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { api } = mountThread({
      GET: (path) =>
        path === STORE_PATHS.access
          ? gate.then(() => accessReply(SIGNED_URL))
          : listWith([FILE_ROW])(path),
    });
    const button = await screen.findByRole("button", { name: "Open plan.pdf in a new tab" });
    button.focus();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(button);
    await act(async () => {
      release();
    });
    await waitFor(() => expect(button.getAttribute("aria-disabled")).not.toBe("true"));
    expect(accessCalls(api)).toHaveLength(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("makes no access call and says so when the browser blocks the new tab", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { api } = mountThread({ GET: listWith([FILE_ROW]) });
    fireEvent.click(await screen.findByRole("button", { name: "Open plan.pdf in a new tab" }));
    expect(await screen.findByText("Allow pop-ups to open files")).toBeTruthy();
    expect(open).toHaveBeenCalledTimes(1);
    expect(accessCalls(api)).toHaveLength(0);
  });

  it("closes the tab and shows only 'File unavailable' when access fails, 404 or thrown", async () => {
    const tab = fakeTab();
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    let mode: "404" | "throw" = "404";
    mountThread({
      GET: (path) => {
        if (path !== STORE_PATHS.access) return listWith([FILE_ROW])(path);
        if (mode === "throw") throw new TypeError("Failed to fetch");
        return envelope("NOT_FOUND", "no such thing", 404);
      },
    });
    const button = await screen.findByRole("button", { name: "Open plan.pdf in a new tab" });
    fireEvent.click(button);
    expect(await screen.findByText("File unavailable")).toBeTruthy();
    expect(screen.queryByText(/no such thing/)).toBeNull();
    expect(tab.close).toHaveBeenCalledTimes(1);
    mode = "throw";
    fireEvent.click(button);
    await waitFor(() => expect(tab.close).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText("File unavailable")).toHaveLength(1);
    expect(tab.location.replace).not.toHaveBeenCalled();
  });

  it.each([["javascript:alert(1)"], ["http://objects.example.test/plain-http"]])(
    "refuses the access URL %s",
    async (url) => {
      const tab = fakeTab();
      vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
      mountThread({
        GET: (path) =>
          path === STORE_PATHS.access ? accessReply(url) : listWith([FILE_ROW])(path),
      });
      fireEvent.click(await screen.findByRole("button", { name: "Open plan.pdf in a new tab" }));
      expect(await screen.findByText("File unavailable")).toBeTruthy();
      expect(tab.location.replace).not.toHaveBeenCalled();
      expect(tab.close).toHaveBeenCalled();
    },
  );

  it("allows plain http to a loopback object store (dev)", async () => {
    const tab = fakeTab();
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    mountThread({
      GET: (path) =>
        path === STORE_PATHS.access
          ? accessReply("http://localhost:9000/bucket/key?sig=1")
          : listWith([FILE_ROW])(path),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Open plan.pdf in a new tab" }));
    await waitFor(() =>
      expect(tab.location.replace).toHaveBeenCalledWith("http://localhost:9000/bucket/key?sig=1"),
    );
  });

  it("does not navigate a tab after the row unmounted", async () => {
    const tab = fakeTab();
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { view } = mountThread({
      GET: (path) =>
        path === STORE_PATHS.access
          ? gate.then(() => accessReply(SIGNED_URL))
          : listWith([FILE_ROW])(path),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Open plan.pdf in a new tab" }));
    view.unmount();
    await act(async () => {
      release();
    });
    expect(tab.location.replace).not.toHaveBeenCalled();
    expect(tab.close).toHaveBeenCalled();
  });

  it("strips bidi controls from the shown file name and keeps the full name in a title", async () => {
    mountThread({
      GET: listWith([{ ...FILE_ROW, fileName: "invoice\u202Egnp.pdf" }]),
    });
    const name = await screen.findByText("invoicegnp.pdf");
    expect(name.getAttribute("title")).toBe("invoicegnp.pdf");
    expect(name.textContent).not.toContain("\u202E");
  });

  it("renders the uploader's scanning file without an open button, and nothing for a recipient with no entry", async () => {
    const first = mountThread({ GET: listWith([{ ...FILE_ROW, availability: "scanning" }]) });
    expect(await screen.findByText("plan.pdf")).toBeTruthy();
    expect(screen.getByText("Scanning…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Open/ })).toBeNull();
    first.view.unmount();

    mountThread({ GET: listWith([]) });
    expect(await screen.findByText("files")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
    expect(screen.queryByText("plan.pdf")).toBeNull();
  });
});
