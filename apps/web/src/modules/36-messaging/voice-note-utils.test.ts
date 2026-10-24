import { describe, expect, it } from "vitest";
import {
  VOICE_NOTE_NEEDS_TEXT,
  baseMimeType,
  resolveContentType,
  selectFiles,
  sendBlockedReason,
  voiceNoteNeedsText,
} from "./attachment-utils";
import type { AttachmentChip } from "./messaging-types";
import {
  MAX_VOICE_NOTE_CLOCK,
  classifyMicrophoneError,
  formatClock,
  pickRecorderMimeType,
  voiceNoteFileName,
} from "./voice-note-utils";

const file = (name: string, type: string, size = 10) => {
  const made = new File(["x"], name, { type });
  Object.defineProperty(made, "size", { value: size });
  return made;
};
const chip = (contentType: string): AttachmentChip => ({
  localId: "l1",
  file: file("n", contentType),
  fileName: "n",
  contentType,
  byteSize: 10,
  status: "ready",
  message: null,
  attachmentId: "a1",
});

describe("voice note helpers (WP 6.3)", () => {
  it("prefers Opus in WebM, then WebM, then MP4, and null when the browser supports none", () => {
    const only = (...types: string[]) => ({ isTypeSupported: (t: string) => types.includes(t) });
    expect(pickRecorderMimeType(only("audio/webm;codecs=opus", "audio/mp4"))).toBe(
      "audio/webm;codecs=opus",
    );
    expect(pickRecorderMimeType(only("audio/webm"))).toBe("audio/webm");
    expect(pickRecorderMimeType(only("audio/mp4"))).toBe("audio/mp4");
    expect(pickRecorderMimeType(only("audio/ogg"))).toBeNull();
  });

  it("formats the clock and names the file by time only", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(42.9)).toBe("0:42");
    expect(formatClock(300)).toBe("5:00");
    expect(MAX_VOICE_NOTE_CLOCK).toBe("5:00");
    const at = new Date("2026-10-23T21:08:09.000Z");
    expect(voiceNoteFileName(at, "audio/webm")).toBe("voice-note-20261023-210809.webm");
    expect(voiceNoteFileName(at, "audio/mp4")).toBe("voice-note-20261023-210809.m4a");
  });

  it("tells a blocked microphone from a missing one", () => {
    expect(classifyMicrophoneError({ name: "NotAllowedError" })).toBe("denied");
    expect(classifyMicrophoneError({ name: "SecurityError" })).toBe("denied");
    expect(classifyMicrophoneError({ name: "NotFoundError" })).toBe("unavailable");
    expect(classifyMicrophoneError(null)).toBe("unavailable");
  });

  it("recognises the recorder's codec-qualified type as its container and nothing else audio", () => {
    expect(baseMimeType("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(resolveContentType(file("v.webm", "audio/webm;codecs=opus"))).toBe("audio/webm");
    expect(resolveContentType(file("v.m4a", "audio/mp4"))).toBe("audio/mp4");
    expect(resolveContentType(file("v.wav", "audio/wav"))).toBeNull();
  });

  it("rejects a voice note over 8 MB client-side (the server enforces the same cap)", () => {
    const { accepted, rejections } = selectFiles(
      [file("a.webm", "audio/webm", 8_000_000), file("b.webm", "audio/webm", 8_000_001)],
      0,
    );
    expect(accepted.map((a) => a.file.name)).toEqual(["a.webm"]);
    expect(rejections).toEqual(["b.webm was not attached: voice notes can be at most 8 MB."]);
  });

  it("a voice note needs a typed body; a PDF alone does not", () => {
    expect(voiceNoteNeedsText([chip("audio/webm")], "  ")).toBe(true);
    expect(voiceNoteNeedsText([chip("audio/webm")], "hello")).toBe(false);
    expect(voiceNoteNeedsText([chip("application/pdf")], "")).toBe(false);
    expect(sendBlockedReason([chip("audio/mp4")], "")).toBe(VOICE_NOTE_NEEDS_TEXT);
    expect(sendBlockedReason([chip("audio/mp4")], "hi")).toBeNull();
  });
});
