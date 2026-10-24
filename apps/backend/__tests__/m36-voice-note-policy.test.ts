// M36 WP 6.3 (ADR-0094 decision 1): voice notes are ordinary scanned attachments. The policy admits the two browser audio types only
// behind the per-tenant flag, caps them at 8 MB, and the built-in scanner checks their container signature.
import {
  MAX_VOICE_NOTE_BYTES,
  VOICE_NOTES_FLAG_KEY,
  VOICE_NOTE_MIME_TYPES,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_MIME_ALLOWLIST,
  validateAuthorizeInput,
} from "../src/modules/36-messaging/attachments/attachment-policy";
import {
  TYPE_MISMATCH_SIGNATURE,
  createBuiltinScanner,
} from "../src/modules/36-messaging/attachments/attachment-scanners";

const base = { fileName: "voice-note.webm", byteSize: 4096, sha256Hex: "a".repeat(64) };
const WEBM = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
const MP4 = Uint8Array.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

describe("voice note policy (flag, types, cap)", () => {
  it("names the flag and the two allowed types", () => {
    expect(VOICE_NOTES_FLAG_KEY).toBe("messaging.voice_notes");
    expect([...VOICE_NOTE_MIME_TYPES]).toEqual(["audio/webm", "audio/mp4"]);
    for (const type of VOICE_NOTE_MIME_TYPES) {
      expect(ATTACHMENT_MIME_ALLOWLIST.has(type)).toBe(true);
    }
  });

  it.each(VOICE_NOTE_MIME_TYPES)(
    "%s is refused (415) when the tenant flag is off or unspecified",
    (type) => {
      const input = { ...base, contentType: type };
      expect(() => validateAuthorizeInput(input)).toThrow(/not allowed/);
      expect(() => validateAuthorizeInput(input, { voiceNotesEnabled: false })).toThrow(
        /not allowed/,
      );
    },
  );

  it.each(VOICE_NOTE_MIME_TYPES)("%s is accepted when the flag is on", (type) => {
    const valid = validateAuthorizeInput(
      { ...base, contentType: type },
      { voiceNotesEnabled: true },
    );
    expect(valid.contentType).toBe(type);
  });

  it("caps a voice note at 8 MB even though the general ceiling is 25 MB", () => {
    const on = { voiceNotesEnabled: true };
    expect(MAX_VOICE_NOTE_BYTES).toBe(8_000_000);
    expect(
      validateAuthorizeInput(
        { ...base, contentType: "audio/webm", byteSize: MAX_VOICE_NOTE_BYTES },
        on,
      ).byteSize,
    ).toBe(MAX_VOICE_NOTE_BYTES);
    expect(() =>
      validateAuthorizeInput(
        { ...base, contentType: "audio/webm", byteSize: MAX_VOICE_NOTE_BYTES + 1 },
        on,
      ),
    ).toThrow(/between 1 and 8000000/);
  });

  it("no other audio type is ever allowed, flag or not", () => {
    for (const contentType of ["audio/wav", "audio/mpeg", "audio/ogg", "audio/amr", "video/webm"]) {
      expect(() =>
        validateAuthorizeInput({ ...base, contentType }, { voiceNotesEnabled: true }),
      ).toThrow(/not allowed/);
    }
  });
});

describe("built-in scanner on audio", () => {
  const scanner = createBuiltinScanner();

  it("passes a webm (EBML) and an mp4 (ftyp at offset 4) of the declared type", async () => {
    expect(await scanner.scan({ bytes: WEBM, mimeType: "audio/webm" })).toEqual({
      verdict: "clean",
    });
    expect(await scanner.scan({ bytes: MP4, mimeType: "audio/mp4" })).toEqual({ verdict: "clean" });
  });

  it("quarantines audio whose bytes are another type (never falls into the zip default)", async () => {
    const mismatch = { verdict: "infected", signature: TYPE_MISMATCH_SIGNATURE };
    expect(await scanner.scan({ bytes: MP4, mimeType: "audio/webm" })).toEqual(mismatch);
    expect(await scanner.scan({ bytes: WEBM, mimeType: "audio/mp4" })).toEqual(mismatch);
    const exe = new TextEncoder().encode("MZ\x90\x00 pretend executable ftyp");
    expect(await scanner.scan({ bytes: exe, mimeType: "audio/mp4" })).toEqual(mismatch);
  });
});
