import { MAX_VOICE_NOTE_BYTES, isVoiceNoteMimeType } from "@chartwarden/types";
import type { AttachmentChip, MessageAttachment } from "./messaging-types";

/** WP 1.5 pure helpers: client-side pre-validation, hashing and error-code reading for chat attachments. */

export const MAX_ATTACHMENT_BYTES = 25_000_000;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  tif: "image/tiff",
  tiff: "image/tiff",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
};

const ALLOWED_TYPES: ReadonlySet<string> = new Set(Object.values(EXTENSION_TYPES));

/** Value for `<input accept>`: both the MIME types and the extensions, so pickers filter on either. */
export const ATTACHMENT_ACCEPT = [
  ...ALLOWED_TYPES,
  ...Object.keys(EXTENSION_TYPES).map((extension) => `.${extension}`),
].join(",");

export const ATTACHMENT_TYPES_LABEL = "PDF, JPEG, PNG, TIFF, Word (.docx) or plain text";

/** `audio/webm;codecs=opus` -> `audio/webm`: MediaRecorder reports its codec, the server's allowlist is by container. */
export const baseMimeType = (type: string): string =>
  type.split(";")[0]?.trim().toLowerCase() ?? "";

/**
 * The browser's type if it is allowed; else the type implied by the extension (some platforms leave it empty). The two voice-note
 * container types (WP 6.3) are recognised here but are not in the picker's `accept` list; the server refuses them unless the tenant
 * has voice notes on.
 */
export function resolveContentType(file: Pick<File, "name" | "type">): string | null {
  const base = baseMimeType(file.type);
  if (isVoiceNoteMimeType(base)) return base;
  if (ALLOWED_TYPES.has(file.type)) return file.type;
  if (file.type) return null;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TYPES[extension] ?? null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export interface AcceptedFile {
  readonly file: File;
  readonly contentType: string;
}

export interface FileSelection {
  readonly accepted: AcceptedFile[];
  readonly rejections: string[];
}

/** Split a picked set into files worth uploading and plain-language reasons for the rest. */
export function selectFiles(files: readonly File[], existingCount: number): FileSelection {
  const accepted: AcceptedFile[] = [];
  const rejections: string[] = [];
  for (const file of files) {
    const contentType = resolveContentType(file);
    if (!contentType) {
      rejections.push(`${file.name} was not attached: use ${ATTACHMENT_TYPES_LABEL}.`);
    } else if (file.size === 0) {
      rejections.push(`${file.name} was not attached: the file is empty.`);
    } else if (isVoiceNoteMimeType(contentType) && file.size > MAX_VOICE_NOTE_BYTES) {
      rejections.push(`${file.name} was not attached: voice notes can be at most 8 MB.`);
    } else if (file.size > MAX_ATTACHMENT_BYTES) {
      rejections.push(`${file.name} was not attached: files can be at most 25 MB.`);
    } else if (existingCount + accepted.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      rejections.push(
        `${file.name} was not attached: a message can have at most ${MAX_ATTACHMENTS_PER_MESSAGE} files.`,
      );
    } else {
      accepted.push({ file, contentType });
    }
  }
  return { accepted, rejections };
}

/** Lowercase hex SHA-256 of the file. Whole file in memory; the 25 MB cap is the ceiling. */
export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The API error code, whichever envelope shape carried it. */
export function apiErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; error?: { code?: unknown } };
  if (typeof candidate.code === "string") return candidate.code;
  if (typeof candidate.error?.code === "string") return candidate.error.code;
  return null;
}

/**
 * The signed URL comes from the server, but it is navigated to, so never hand `javascript:` to the browser.
 * https always; plain http only to a loopback host (the dev object store), never to a real origin.
 */
export function isSafeAccessUrl(value: string): boolean {
  try {
    const { protocol, hostname } = new URL(value);
    if (protocol === "https:") return true;
    return protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}

const BIDI_CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** A file name safe to show: bidi control characters can reorder the extension (`gpj.exe` spoofing). */
export function displayFileName(name: string): string {
  return name.replace(BIDI_CONTROLS, "");
}

/** Optimistic message rows for the chips that will be bound: ready and still-scanning files. */
export function toSentAttachments(chips: readonly AttachmentChip[]): MessageAttachment[] {
  return chips.flatMap((chip) =>
    chip.attachmentId && (chip.status === "ready" || chip.status === "scanning")
      ? [
          {
            attachmentId: chip.attachmentId,
            fileName: chip.fileName,
            mimeType: chip.contentType,
            byteSize: chip.byteSize,
            availability: chip.status === "ready" ? ("available" as const) : ("scanning" as const),
          },
        ]
      : [],
  );
}

export const VOICE_NOTE_NEEDS_TEXT =
  "Add a short typed message so everyone can read what the voice note is about.";

/** WP 6.3 (ADR-0094 5.1): a voice note alone is not accessible to everyone, so a message that carries one needs a typed body. */
export function voiceNoteNeedsText(chips: readonly AttachmentChip[], draft: string): boolean {
  return !draft.trim() && chips.some((chip) => isVoiceNoteMimeType(chip.contentType));
}

/** Why Send is held back by the attachments, in words; null when they do not block it. */
export function sendBlockedReason(chips: readonly AttachmentChip[], draft = ""): string | null {
  if (
    chips.some(
      (chip) => chip.status === "failed" || chip.status === "blocked" || chip.status === "reattach",
    )
  ) {
    return "Retry or remove the files marked Failed, Blocked or Re-attach to send.";
  }
  if (chips.some((chip) => chip.status === "hashing" || chip.status === "uploading")) {
    return "Send is available once the files finish uploading.";
  }
  return voiceNoteNeedsText(chips, draft) ? VOICE_NOTE_NEEDS_TEXT : null;
}

/** Deadline for one attachment API request (authorize, complete, status, access). */
export const ATTACHMENT_REQUEST_TIMEOUT_MS = 30_000;

/** `base` plus a request deadline; `expired()` tells a timeout from a user/teardown abort. */
export function withRequestDeadline(base?: AbortSignal): {
  signal: AbortSignal;
  expired: () => boolean;
} {
  const deadline = AbortSignal.timeout(ATTACHMENT_REQUEST_TIMEOUT_MS);
  return {
    signal: base ? AbortSignal.any([base, deadline]) : deadline,
    expired: () => deadline.aborted,
  };
}
