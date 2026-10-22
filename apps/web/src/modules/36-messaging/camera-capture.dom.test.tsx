import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  STORE_PATHS,
  attach,
  authorized,
  calls,
  chipList,
  completed,
  fetchMock,
  mountThread,
  sendButton,
  sha,
} from "./attachments-test-support";

const { stripMock } = vi.hoisted(() => ({ stripMock: vi.fn() }));
vi.mock("./image-metadata-strip", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./image-metadata-strip")>()),
  stripImageMetadata: stripMock,
}));

const ORIGINAL_BYTES = "original-with-gps-exif";
const STRIPPED_BYTES = "stripped-pixels-only";

/** jsdom's File has no arrayBuffer(); the hashing helper needs one. */
function image(name: string, body: string, type = "image/jpeg"): File {
  const file = new File([body], name, { type });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode(body).buffer,
  });
  return file;
}

const uploadAndScan = (path: string) =>
  path === STORE_PATHS.uploads
    ? authorized
    : path === STORE_PATHS.complete
      ? completed("scanning")
      : undefined;

const uploadAndClean = (path: string) =>
  path === STORE_PATHS.uploads
    ? authorized
    : path === STORE_PATHS.complete
      ? completed("available")
      : undefined;

async function capture(file: File) {
  const input = (await screen.findByTestId("camera-input")) as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
}

const usePhoto = () =>
  act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Use photo" }));
  });

let revoke: ReturnType<typeof vi.fn<(url: string) => void>>;
let coarse: boolean;
beforeEach(() => {
  coarse = true;
  stripMock.mockReset();
  stripMock.mockImplementation(async (file: File) => image(file.name, STRIPPED_BYTES));
  revoke = vi.fn<(url: string) => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: coarse && query === "(pointer: coarse)",
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  let urlCount = 0;
  URL.createObjectURL = vi.fn(() => `blob:preview-${++urlCount}`);
  URL.revokeObjectURL = revoke;
});

describe("WP 5.3 camera capture", () => {
  it("offers the camera only on coarse-pointer devices, with the camera input attributes", async () => {
    mountThread();
    const input = (await screen.findByTestId("camera-input")) as HTMLInputElement;
    expect(input.getAttribute("accept")).toBe("image/*");
    expect(input.getAttribute("capture")).toBe("environment");
    const button = screen.getByRole("button", { name: "Take photo" });
    expect(button.className).toContain("wx-attach-button");
  });

  it("hides the camera on a desktop pointer and keeps the file picker", async () => {
    coarse = false;
    mountThread();
    await screen.findByTestId("attachment-input");
    expect(screen.queryByRole("button", { name: "Take photo" })).toBeNull();
    expect(screen.queryByTestId("camera-input")).toBeNull();
  });

  it("previews the shot with Retake and Use photo, and states that location data is removed", async () => {
    mountThread();
    await capture(image("IMG_0001.jpg", ORIGINAL_BYTES));

    const preview = screen.getByRole("region", { name: "Photo preview" });
    expect(within(preview).getByText("Location data is removed")).toBeTruthy();
    expect(within(preview).getByRole("button", { name: "Retake" })).toBeTruthy();
    expect(stripMock).not.toHaveBeenCalled(); // nothing is attached until Use photo

    await usePhoto();
    expect(screen.queryByRole("region", { name: "Photo preview" })).toBeNull();
    expect(revoke).toHaveBeenCalledWith("blob:preview-1");
  });

  it("revokes the preview URL when a retake replaces the shot", async () => {
    mountThread();
    await capture(image("a.jpg", ORIGINAL_BYTES));
    await capture(image("b.jpg", ORIGINAL_BYTES));
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:preview-1");
  });

  it("strips before hashing: the stripped bytes are hashed, sized, PUT, and the original never leaves", async () => {
    const { api } = mountThread({ POST: uploadAndClean });
    const original = image("IMG_0001.jpg", ORIGINAL_BYTES);
    await capture(original);
    await usePhoto();

    await waitFor(() => expect(within(chipList()!).getByText("Ready")).toBeTruthy());
    expect(stripMock).toHaveBeenCalledWith(original, "image/jpeg");
    const [, authInit] = calls(api, STORE_PATHS.uploads)[0]!;
    expect(authInit.body.sha256Hex).toBe(sha(STRIPPED_BYTES));
    expect(authInit.body.sha256Hex).not.toBe(sha(ORIGINAL_BYTES));
    expect(authInit.body.byteSize).toBe(STRIPPED_BYTES.length);
    const [, putInit] = fetchMock.mock.calls[0]!;
    expect(putInit.body).not.toBe(original);
    expect((putInit.body as File).size).toBe(STRIPPED_BYTES.length);
  });

  it("strips a JPEG chosen with the paperclip too, but leaves a TIFF alone", async () => {
    mountThread({ POST: uploadAndClean });
    await attach([image("scan.tif", "tiff-bytes", "image/tiff")]);
    await waitFor(() => expect(within(chipList()!).getByText("Ready")).toBeTruthy());
    expect(stripMock).not.toHaveBeenCalled();

    await attach([image("photo.png", ORIGINAL_BYTES, "image/png")]);
    await waitFor(() => expect(stripMock).toHaveBeenCalledTimes(1));
    expect(stripMock.mock.calls[0]![1]).toBe("image/png");
  });

  it("keeps the photo scanning, never Ready, until the server says clean, and hides it from everyone else", async () => {
    const { api } = mountThread({ POST: uploadAndScan });
    await capture(image("IMG_0001.jpg", ORIGINAL_BYTES));
    await usePhoto();

    await waitFor(() => expect(within(chipList()!).getByText("Scanning…")).toBeTruthy());
    expect(within(chipList()!).queryByText("Ready")).toBeNull();
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    await act(async () => {
      fireEvent.click(sendButton());
    });
    // The send only binds the id; visibility is the server's decision.
    await waitFor(() => expect(calls(api, STORE_PATHS.messages)).toHaveLength(1));
  });

  it("shows other viewers a neutral note, with no file name or link, while the photo is not clean", async () => {
    mountThread({
      GET: (path) =>
        path === STORE_PATHS.messages
          ? {
              data: {
                messages: [
                  {
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
                    hiddenAttachmentCount: 1,
                  },
                ],
              },
              error: undefined,
            }
          : undefined,
    });
    expect(await screen.findByText("Attachment not available yet")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
  });

  it("refuses a photo that is still over 25 MB after stripping and never authorizes it", async () => {
    stripMock.mockResolvedValue({ size: 25_000_001 } as File);
    const { api } = mountThread({ POST: uploadAndClean });
    await capture(image("IMG_0001.jpg", ORIGINAL_BYTES));
    await usePhoto();

    await waitFor(() => expect(within(chipList()!).getByText(/too large to attach/)).toBeTruthy());
    expect(calls(api, STORE_PATHS.uploads)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the image cannot be decoded: no hash, no authorize, no upload of the original", async () => {
    stripMock.mockRejectedValue(new Error("image-strip-failed"));
    const { api } = mountThread({ POST: uploadAndClean });
    await capture(image("IMG_0001.jpg", ORIGINAL_BYTES));
    await usePhoto();

    await waitFor(() =>
      expect(
        within(chipList()!).getByText(/could not be prepared, so it was not uploaded/),
      ).toBeTruthy(),
    );
    expect(calls(api, STORE_PATHS.uploads)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendButton().disabled).toBe(true);
  });
});
