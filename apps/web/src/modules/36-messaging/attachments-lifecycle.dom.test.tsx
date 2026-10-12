import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_ID,
  STORE_PATHS,
  attach,
  authorizedWith,
  calls,
  chipList,
  completed,
  envelope,
  fetchMock,
  mountThread,
  pdf,
  sendButton,
  status,
} from "./attachments-test-support";

type Api = ReturnType<typeof mountThread>["api"];

const happyPath =
  (completeAs = "available") =>
  (path: string) =>
    path === STORE_PATHS.uploads
      ? authorizedWith(ATTACHMENT_ID)
      : path === STORE_PATHS.complete
        ? completed(completeAs)
        : undefined;

const statusPolls = (api: Api) => api.GET.mock.calls.filter(([p]) => p === STORE_PATHS.status);
const inList = () => within(chipList()!);
const flush = () => act(async () => {});
const setDraft = (value: string) =>
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value } });

describe("WP 1.5 upload pipeline", () => {
  it("fails the chip when the PUT is answered with an error, and Retry authorizes afresh", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });
    const { api } = mountThread({ POST: happyPath() });
    await attach([pdf()]);
    await inList().findByText("Failed");
    expect(inList().getByText(/could not be uploaded/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry report.pdf" }));
    await waitFor(() => expect(inList().getByText("Ready")).toBeTruthy());
    const keys = calls(api, STORE_PATHS.uploads).map(
      ([, init]) => init.params.header["Idempotency-Key"],
    );
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("reuses the complete Idempotency-Key after a lost reply and does not PUT again", async () => {
    let completeAttempts = 0;
    const { api } = mountThread({
      POST: (path) => {
        if (path === STORE_PATHS.uploads) return authorizedWith(ATTACHMENT_ID);
        if (path !== STORE_PATHS.complete) return undefined;
        completeAttempts += 1;
        if (completeAttempts === 1) throw new TypeError("Failed to fetch");
        return completed("available");
      },
    });
    await attach([pdf()]);
    await inList().findByText("Failed");
    fireEvent.click(screen.getByRole("button", { name: "Retry report.pdf" }));
    await waitFor(() => expect(inList().getByText("Ready")).toBeTruthy());
    const keys = calls(api, STORE_PATHS.complete).map(
      ([, init]) => init.params.header["Idempotency-Key"],
    );
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls(api, STORE_PATHS.uploads)).toHaveLength(1);
  });

  it("keeps the same keys across send retries and rotates only the header key after an answered error", async () => {
    let attempts = 0;
    const { api } = mountThread({
      POST: (path) => {
        if (path !== STORE_PATHS.messages) return happyPath()(path);
        attempts += 1;
        if (attempts === 1) throw new TypeError("Failed to fetch");
        if (attempts === 2) return envelope("INTERNAL", "boom", 500);
        return undefined;
      },
    });
    await attach([pdf()]);
    await waitFor(() => expect(inList().getByText("Ready")).toBeTruthy());
    setDraft("with file");
    for (const expected of [1, 2, 3]) {
      await act(async () => {
        fireEvent.click(sendButton());
      });
      await waitFor(() => expect(calls(api, STORE_PATHS.messages)).toHaveLength(expected));
      await flush();
    }
    const sent = calls(api, STORE_PATHS.messages).map(([, init]) => init);
    const headerKeys = sent.map((init) => init.params.header["Idempotency-Key"]);
    expect(headerKeys[1]).toBe(headerKeys[0]);
    expect(headerKeys[2]).not.toBe(headerKeys[1]);
    expect(new Set(sent.map((init) => init.body.clientMessageId)).size).toBe(1);
    for (const init of sent)
      expect(init.body.attachments).toEqual([{ attachmentId: ATTACHMENT_ID }]);
  });

  it("hashes and uploads at most two files at a time", async () => {
    const releases: Array<() => void> = [];
    const { api } = mountThread({
      POST: (path) => {
        if (path === STORE_PATHS.complete) return completed("available");
        if (path !== STORE_PATHS.uploads) return undefined;
        const id = `id-${releases.length}`;
        return new Promise((resolve) => releases.push(() => resolve(authorizedWith(id))));
      },
    });
    await attach([pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf"), pdf("d.pdf")]);
    await waitFor(() => expect(calls(api, STORE_PATHS.uploads)).toHaveLength(2));
    await flush();
    await flush();
    expect(calls(api, STORE_PATHS.uploads)).toHaveLength(2);

    await act(async () => releases[0]!());
    await waitFor(() => expect(calls(api, STORE_PATHS.uploads)).toHaveLength(3));
    expect(calls(api, STORE_PATHS.uploads)).toHaveLength(3);

    await act(async () => releases[1]!());
    await waitFor(() => expect(calls(api, STORE_PATHS.uploads)).toHaveLength(4));
    await act(async () => releases[2]!());
    await act(async () => releases[3]!());
    await waitFor(() => expect(inList().getAllByText("Ready")).toHaveLength(4));
  });
});

describe("WP 1.5 aborts", () => {
  const hangingPut = () =>
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );

  it("aborts the in-flight authorize when the chip is removed", async () => {
    const { api } = mountThread({
      POST: (path) => (path === STORE_PATHS.uploads ? new Promise(() => {}) : undefined),
    });
    await attach([pdf()]);
    await waitFor(() => expect(calls(api, STORE_PATHS.uploads)).toHaveLength(1));
    const signal = calls(api, STORE_PATHS.uploads)[0]![1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Remove report.pdf" }));
    expect(signal.aborted).toBe(true);
    expect(chipList()).toBeNull();
  });

  it("aborts the PUT on remove and never completes", async () => {
    hangingPut();
    const { api } = mountThread({ POST: happyPath() });
    await attach([pdf()]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const signal = fetchMock.mock.calls[0]![1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Remove report.pdf" }));
    expect(signal.aborted).toBe(true);
    await flush();
    expect(calls(api, STORE_PATHS.complete)).toHaveLength(0);
    expect(chipList()).toBeNull();
  });

  it("aborts in-flight requests when the channel changes", async () => {
    hangingPut();
    const { view, tree } = mountThread({ POST: happyPath() });
    await attach([pdf()]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const signal = fetchMock.mock.calls[0]![1].signal as AbortSignal;
    view.rerender(tree("dm-2"));
    expect(signal.aborted).toBe(true);
    await waitFor(() => expect(chipList()).toBeNull());
  });

  it("does nothing after unmount: no request, no timer, no late state update", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { api, view } = mountThread({
      POST: (path) =>
        path === STORE_PATHS.uploads ? gate.then(() => authorizedWith(ATTACHMENT_ID)) : undefined,
    });
    await attach([pdf()]);
    await waitFor(() => expect(calls(api, STORE_PATHS.uploads)).toHaveLength(1));
    const before = api.POST.mock.calls.length + api.GET.mock.calls.length;
    view.unmount();
    await act(async () => release());
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.POST.mock.calls.length + api.GET.mock.calls.length).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("WP 1.5 timers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));

  it("fails the chip when the PUT stalls past its deadline, and Retry resumes at the PUT", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockImplementationOnce(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const { api } = mountThread({ POST: happyPath() });
    await attach([pdf()]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await advance(5 * 60_000 + 1_000);
    await waitFor(() => expect(inList().getByText("Failed")).toBeTruthy());
    expect(inList().getByText(/took too long/)).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry report.pdf" }));
    await waitFor(() => expect(inList().getByText("Ready")).toBeTruthy());
    expect(calls(api, STORE_PATHS.uploads)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ends the poll as Blocked when the scan quarantines the file", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api } = mountThread({
      POST: happyPath("scanning"),
      GET: (path) =>
        path === STORE_PATHS.status ? { data: status("blocked"), error: undefined } : undefined,
    });
    await attach([pdf()]);
    await waitFor(() => expect(inList().getByText("Scanning…")).toBeTruthy());
    await advance(3_100);
    await waitFor(() => expect(inList().getByText("Blocked")).toBeTruthy());
    expect(inList().getByText(/blocked by the security scan/)).toBeTruthy();
    await advance(60_000);
    expect(statusPolls(api)).toHaveLength(1);
    expect(sendButton().disabled).toBe(true);
  });

  it("ends the poll as Failed on an answered 404 and stops asking", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api } = mountThread({
      POST: happyPath("scanning"),
      GET: (path) => (path === STORE_PATHS.status ? envelope("NOT_FOUND", "gone", 404) : undefined),
    });
    await attach([pdf()]);
    await waitFor(() => expect(inList().getByText("Scanning…")).toBeTruthy());
    await advance(3_100);
    await waitFor(() => expect(inList().getByText("Failed")).toBeTruthy());
    await advance(120_000);
    expect(statusPolls(api)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Retry report.pdf" })).toBeTruthy();
  });

  it("keeps polling through a 5xx but fails on an unknown availability", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let polls = 0;
    const { api } = mountThread({
      POST: happyPath("scanning"),
      GET: (path) => {
        if (path !== STORE_PATHS.status) return undefined;
        polls += 1;
        return polls === 1
          ? envelope("INTERNAL", "boom", 503)
          : { data: status("teleported"), error: undefined };
      },
    });
    await attach([pdf()]);
    await waitFor(() => expect(inList().getByText("Scanning…")).toBeTruthy());
    await advance(3_100);
    expect(inList().getByText("Scanning…")).toBeTruthy();
    await advance(6_100);
    await waitFor(() => expect(inList().getByText("Failed")).toBeTruthy());
    expect(statusPolls(api)).toHaveLength(2);
  });

  it("stops polling after the time budget and leaves the file sendable", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api } = mountThread({
      POST: happyPath("scanning"),
      GET: (path) =>
        path === STORE_PATHS.status ? { data: status("scanning"), error: undefined } : undefined,
    });
    await attach([pdf()]);
    await waitFor(() => expect(inList().getByText("Scanning…")).toBeTruthy());
    await advance(11 * 60_000);
    await waitFor(() => expect(inList().getByText(/Still scanning/)).toBeTruthy());
    const settled = statusPolls(api).length;
    await advance(5 * 60_000);
    expect(statusPolls(api)).toHaveLength(settled);
    setDraft("go");
    expect(sendButton().disabled).toBe(false);
  });

  it("clears the poll timer when the chip is removed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api } = mountThread({ POST: happyPath("scanning") });
    await attach([pdf()]);
    await waitFor(() => expect(inList().getByText("Scanning…")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Remove report.pdf" }));
    await advance(60_000);
    expect(statusPolls(api)).toHaveLength(0);
  });

  it("clears the poll timer when the thread unmounts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api, view } = mountThread({ POST: happyPath("scanning") });
    await attach([pdf()]);
    await waitFor(() => expect(inList().getByText("Scanning…")).toBeTruthy());
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(60_000);
    expect(statusPolls(api)).toHaveLength(0);
  });
});

describe("WP 1.5 sent message that is still scanning", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const row = (availability: string) => ({
    messageId: "m-7",
    channelId: "dm-1",
    authorUserId: "11111111-1111-4111-8111-111111111111",
    authorDisplayName: "Me",
    body: "sent file",
    bodyKind: "plain",
    createdAt: "2026-10-10T09:00:00.000Z",
    parentMessageId: null,
    references: [],
    attachments: [
      {
        attachmentId: ATTACHMENT_ID,
        fileName: "plan.pdf",
        mimeType: "application/pdf",
        byteSize: 10,
        availability,
      },
    ],
  });

  it("re-reads the thread on a backoff until the file is openable, then stops", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let reads = 0;
    const { api } = mountThread({
      GET: (path) => {
        if (path !== STORE_PATHS.messages) return undefined;
        reads += 1;
        return {
          data: { messages: [row(reads < 2 ? "scanning" : "available")] },
          error: undefined,
        };
      },
    });
    expect(await screen.findByText("Scanning…")).toBeTruthy();
    expect(reads).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(5_100));
    expect(await screen.findByRole("button", { name: "Open plan.pdf in a new tab" })).toBeTruthy();
    expect(reads).toBe(2);
    await act(async () => vi.advanceTimersByTimeAsync(9_000));
    expect(api.GET.mock.calls.filter(([p]) => p === STORE_PATHS.messages)).toHaveLength(2);
  });
});

describe("WP 1.5 refused send", () => {
  it("marks the chips that can no longer be sent and keeps the others", async () => {
    const ids: Record<string, string> = { "a.pdf": "id-a", "b.pdf": "id-b" };
    const { api } = mountThread({
      POST: (path, init) => {
        if (path === STORE_PATHS.uploads) {
          return authorizedWith(ids[(init.body as { fileName: string }).fileName] ?? "id-x");
        }
        if (path === STORE_PATHS.complete) return completed("available");
        if (path === STORE_PATHS.messages) return envelope("ATTACHMENT_NOT_BINDABLE", "x", 422);
        return undefined;
      },
      GET: (path, init) => {
        if (path !== STORE_PATHS.status) return undefined;
        const id = (init.params as { path: { id: string } }).path.id;
        return { data: status(id === "id-a" ? "blocked" : "available"), error: undefined };
      },
    });
    await attach([pdf("a.pdf"), pdf("b.pdf")]);
    await waitFor(() => expect(inList().getAllByText("Ready")).toHaveLength(2));
    setDraft("keep me");
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await waitFor(() => expect(inList().getByText("Blocked")).toBeTruthy());
    expect(inList().getAllByText("Ready")).toHaveLength(1);
    expect(statusPolls(api)).toHaveLength(2);
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByText(/Retry or remove the files/)).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe(
      "keep me",
    );
  });
});

describe("WP 1.5 composer accessibility", () => {
  const two = () =>
    mountThread({
      POST: (path, init) =>
        path === STORE_PATHS.uploads
          ? authorizedWith(`id-${(init.body as { fileName: string }).fileName}`)
          : path === STORE_PATHS.complete
            ? completed("available")
            : undefined,
    });

  it("moves focus to the next chip, then to the Attach button, after Remove", async () => {
    two();
    await attach([pdf("a.pdf"), pdf("b.pdf")]);
    await waitFor(() => expect(inList().getAllByText("Ready")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Remove a.pdf" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove b.pdf" })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove b.pdf" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Attach file" })),
    );
  });

  it("keeps focus inside the chip after Retry", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    mountThread({ POST: happyPath() });
    await attach([pdf()]);
    await inList().findByText("Failed");
    fireEvent.click(screen.getByRole("button", { name: "Retry report.pdf" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Remove report.pdf" }),
      ),
    );
  });

  it("mounts both live regions up front and fills them", async () => {
    const { view } = mountThread({ POST: happyPath() });
    await screen.findByTestId("attachment-input");
    const status = view.container.querySelector("output.sr-only");
    const notices = view.container.querySelector('[aria-live="assertive"]');
    expect(status?.textContent).toBe("");
    expect(notices?.textContent).toBe("");
    await attach([pdf(), new File(["x"], "run.exe", { type: "application/x-msdownload" })]);
    await waitFor(() => expect(status?.textContent).toContain("report.pdf: Ready"));
    expect(notices?.textContent).toContain("run.exe was not attached");
    expect(view.container.querySelector("output.sr-only")).toBe(status);
  });

  it("lists two same-named rejections without a React key collision", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mountThread();
    const exe = () => new File(["x"], "run.exe", { type: "application/x-msdownload" });
    await attach([exe(), exe()]);
    expect(await screen.findAllByText(/run\.exe was not attached/)).toHaveLength(2);
    expect(errors).not.toHaveBeenCalled();
  });

  it("says why Send is held back and ties the reason to the button", async () => {
    mountThread({
      POST: (path) => (path === STORE_PATHS.uploads ? new Promise(() => {}) : undefined),
    });
    setDraft("hello");
    expect(sendButton().getAttribute("aria-describedby")).toBeNull();
    await attach([pdf()]);
    const hintId = await waitFor(() => {
      const id = sendButton().getAttribute("aria-describedby");
      expect(id).toBeTruthy();
      return id as string;
    });
    expect(document.getElementById(hintId)?.textContent).toMatch(/finish uploading/);
  });

  it("puts the label and message box before the attach controls in the DOM", async () => {
    const { view } = mountThread();
    const box = await screen.findByRole("textbox", { name: "Message" });
    const attachButton = screen.getByRole("button", { name: "Attach file" });
    expect(
      box.compareDocumentPosition(attachButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const label = view.container.querySelector('label[for="messaging-composer"]');
    expect(label).not.toBeNull();
    expect(label!.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows a bidi-stripped file name with the full name in a title", async () => {
    mountThread({ POST: happyPath() });
    await attach([pdf("invoice‮gnp.pdf")]);
    const name = await inList().findByText("invoicegnp.pdf");
    expect(name.getAttribute("title")).toBe("invoicegnp.pdf");
  });
});
