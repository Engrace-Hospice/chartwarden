// M36 WP 6.3 (ADR-0094): a voice note rides the ordinary attachment pipeline. The composer asks for a typed message with it, and a sent note
// plays in the native audio control through the per-open presigned GET (only while the tenant flag is on).
import { type ApiClient, ApiClientProvider, FeatureFlagProvider } from "@chartwarden/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_ID,
  SIGNED_URL,
  STORE_PATHS,
  attach,
  authorized,
  calls,
  chipList,
  completed,
  mountThread,
  sendButton,
} from "./attachments-test-support";
import { MessageAttachments } from "./message-attachments";
import type { MessageAttachment } from "./messaging-types";

function voiceFile(): File {
  const file = new File(["opus"], "voice-note-20261023-210809.webm", { type: "audio/webm" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode("opus").buffer,
  });
  return file;
}

const uploadAndClean = (path: string) =>
  path === STORE_PATHS.uploads
    ? authorized
    : path === STORE_PATHS.complete
      ? completed("available")
      : undefined;

describe("voice note in the composer", () => {
  it("holds Send until a typed message is added, says why, then sends the note as an ordinary attachment", async () => {
    const { api } = mountThread({ POST: uploadAndClean });
    await attach([voiceFile()]);
    await waitFor(() => expect(chipList()?.textContent).toContain("Ready"));
    expect(calls(api, STORE_PATHS.uploads)[0]![1].body).toMatchObject({
      contentType: "audio/webm",
      fileName: "voice-note-20261023-210809.webm",
    });
    expect(sendButton().disabled).toBe(true);
    expect(
      screen.getByText(
        "Add a short typed message so everyone can read what the voice note is about.",
      ),
    ).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Pain better since 9" } });
    expect(sendButton().disabled).toBe(false);
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await waitFor(() => expect(calls(api, STORE_PATHS.messages)).toHaveLength(1));
    expect(calls(api, STORE_PATHS.messages)[0]![1].body).toMatchObject({
      body: "Pain better since 9",
      attachments: [{ attachmentId: ATTACHMENT_ID }],
    });
  });
});

const note: MessageAttachment = {
  attachmentId: ATTACHMENT_ID,
  fileName: "voice-note.webm",
  mimeType: "audio/webm",
  byteSize: 120_000,
  availability: "available",
};

function mountNote(flagOn: boolean, get = vi.fn()) {
  const client = { GET: get } as unknown as ApiClient;
  render(
    <ApiClientProvider client={client}>
      <FeatureFlagProvider flags={{ "messaging.voice_notes": flagOn }}>
        <MessageAttachments attachments={[note]} />
      </FeatureFlagProvider>
    </ApiClientProvider>,
  );
  return get;
}

describe("voice note playback", () => {
  it("fetches the signed URL only on Play and plays it in the native audio control", async () => {
    const get = vi.fn().mockResolvedValue({ data: { url: SIGNED_URL }, error: undefined });
    mountNote(true, get);
    expect(get).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Play voice note" }));
    });
    expect(get).toHaveBeenCalledWith(
      STORE_PATHS.access,
      expect.objectContaining({ params: { path: { id: ATTACHMENT_ID } } }),
    );
    const audio = await screen.findByLabelText("Voice note");
    expect(audio.tagName).toBe("AUDIO");
    expect(audio.getAttribute("src")).toBe(SIGNED_URL);
    cleanup();
  });

  it("an expired link drops the player and offers Play again; a refusal reads as unavailable", async () => {
    const get = vi.fn().mockResolvedValue({ data: { url: SIGNED_URL }, error: undefined });
    mountNote(true, get);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Play voice note" }));
    });
    fireEvent.error(await screen.findByLabelText("Voice note"));
    expect(await screen.findByText(/The link timed out/)).toBeTruthy();
    get.mockResolvedValue({ data: undefined, error: { error: { code: "NOT_FOUND" } } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Play voice note" }));
    });
    expect(await screen.findByText("Voice note unavailable")).toBeTruthy();
    cleanup();
  });

  it("with the flag off a stored note is an ordinary file row (no inline player)", () => {
    mountNote(false);
    expect(screen.queryByRole("button", { name: "Play voice note" })).toBeNull();
    expect(screen.getByRole("button", { name: /Open voice-note\.webm in a new tab/ })).toBeTruthy();
    cleanup();
  });
});
