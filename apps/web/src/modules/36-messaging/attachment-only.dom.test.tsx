import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_ID,
  STORE_PATHS,
  attach,
  authorizedWith,
  calls,
  chipList,
  completed,
  envelope,
  mountThread,
  pdf,
  sendButton,
} from "./attachments-test-support";

const uploadOk = (path: string) =>
  path === STORE_PATHS.uploads
    ? authorizedWith(ATTACHMENT_ID)
    : path === STORE_PATHS.complete
      ? completed("available")
      : undefined;
const textbox = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const clickSend = () =>
  act(async () => {
    fireEvent.click(sendButton());
  });

describe("WP 1.5 attachment-only messages (web)", () => {
  it("keeps Send disabled with no text and no file, and enables it for a Ready file with no text", async () => {
    const { api } = mountThread({ POST: uploadOk });
    await screen.findByRole("textbox", { name: "Message" });
    expect(sendButton().disabled).toBe(true);
    fireEvent.change(textbox(), { target: { value: "   " } });
    expect(sendButton().disabled).toBe(true);

    await attach([pdf()]);
    await waitFor(() => expect(within(chipList()!).getByText("Ready")).toBeTruthy());
    expect(sendButton().disabled).toBe(false);

    await clickSend();
    await waitFor(() => expect(calls(api, STORE_PATHS.messages)).toHaveLength(1));
    const body = calls(api, STORE_PATHS.messages)[0]![1].body;
    expect(body.body).toBeUndefined();
    expect(body.attachments).toEqual([{ attachmentId: ATTACHMENT_ID }]);
    await waitFor(() => expect(chipList()).toBeNull());
  });

  it("still holds Send while a file is uploading, even though it is the only content", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mountThread({
      POST: (path) =>
        path === STORE_PATHS.uploads
          ? gate.then(() => authorizedWith(ATTACHMENT_ID))
          : uploadOk(path),
    });
    await attach([pdf()]);
    await waitFor(() => expect(sendButton().disabled).toBe(true));
    await act(async () => {
      release();
    });
    await waitFor(() => expect(sendButton().disabled).toBe(false));
  });

  it("goes back to disabled when the only file is removed", async () => {
    mountThread({ POST: uploadOk });
    await attach([pdf()]);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Remove report.pdf" }));
    await waitFor(() => expect(sendButton().disabled).toBe(true));
  });

  it("rotates the Idempotency-Key after an answered error but keeps the clientMessageId", async () => {
    let attempts = 0;
    const { api } = mountThread({
      POST: (path) => {
        if (path !== STORE_PATHS.messages) return uploadOk(path);
        attempts += 1;
        return attempts === 1 ? envelope("INTERNAL", "boom", 500) : undefined;
      },
    });
    await attach([pdf()]);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    await clickSend();
    await waitFor(() => expect(calls(api, STORE_PATHS.messages)).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    await clickSend();
    await waitFor(() => expect(calls(api, STORE_PATHS.messages)).toHaveLength(2));
    const [first, second] = calls(api, STORE_PATHS.messages).map(([, init]) => init);
    expect(second!.params.header["Idempotency-Key"]).not.toBe(
      first!.params.header["Idempotency-Key"],
    );
    expect(second!.body.clientMessageId).toBe(first!.body.clientMessageId);
  });

  it("shows the sent attachment-only message without a 'Message deleted' placeholder", async () => {
    mountThread({ POST: uploadOk });
    await attach([pdf()]);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    await clickSend();
    await screen.findByRole("list", { name: "Attachments" });
    expect(screen.queryByText("Message deleted")).toBeNull();
  });

  describe("files the viewer cannot see yet", () => {
    const row = (over: Record<string, unknown>) => ({
      messageId: "m-9",
      channelId: "dm-1",
      authorUserId: "other-user",
      authorDisplayName: "Other",
      body: "",
      bodyKind: "plain",
      createdAt: "2026-10-10T09:00:00.000Z",
      parentMessageId: null,
      references: [],
      attachments: [],
      ...over,
    });
    const listOf = (message: unknown) => (path: string) =>
      path === STORE_PATHS.messages
        ? { data: { messages: [message] }, error: undefined }
        : undefined;

    it("shows a neutral note, not 'Message deleted' and not an empty bubble, for an attachment-only message with hidden files", async () => {
      mountThread({ GET: listOf(row({ hiddenAttachmentCount: 1 })) });
      expect(await screen.findByText("Attachment not available yet")).toBeTruthy();
      expect(screen.queryByText("Message deleted")).toBeNull();
    });

    it("pluralises, and shows the note beside text", async () => {
      mountThread({ GET: listOf(row({ body: "see these", hiddenAttachmentCount: 2 })) });
      expect(await screen.findByText("2 attachments not available yet")).toBeTruthy();
      expect(screen.getByText("see these")).toBeTruthy();
    });

    it("still reads 'Message deleted' for a real tombstone", async () => {
      mountThread({ GET: listOf(row({ hiddenAttachmentCount: 0 })) });
      expect(await screen.findByText("Message deleted")).toBeTruthy();
      expect(screen.queryByText(/not available yet/)).toBeNull();
    });
  });
});
