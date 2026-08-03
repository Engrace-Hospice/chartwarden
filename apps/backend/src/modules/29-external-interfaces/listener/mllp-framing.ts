// apps/backend/src/modules/29-external-interfaces/listener — MLLP frame handling (M29-T03, §4.11.3). PURE.
//
// A single MLLP frame is bounded by `<VT>` (0x0B) at the start and `<FS><CR>` (0x1C 0x0D) at the end
// (Minimal Lower-Layer Protocol, HL7 v2 transport). TCP delivers a byte STREAM, not messages — a frame can
// arrive split across chunks, and two frames can arrive in one chunk. `MllpFrameBuffer` accumulates bytes
// and yields complete frames; the caller (§4.11.3) does the idempotency check / persist / enqueue / ACK per
// frame, all OUTSIDE this module (this is pure buffering + a regex-light MSH pre-parse, no HAPI parse yet).
//
// The pre-parse (`parseMshEnvelope`) is deliberately SHALLOW: MSH-10 (message control id), MSH-9 (message
// type + trigger event), MSH-3/4 (sending application/facility). It is the "fail-fast on obviously
// malformed framing" step of §4.11.3 step 2 — the full typed segment tree comes from the HAPI sidecar in
// the BullMQ worker (a later task), never on the listener path.
import { createHash } from "node:crypto";

/** MLLP start-of-block — `<VT>` vertical tab. */
export const MLLP_VT = 0x0b;
/** MLLP end-of-block — `<FS>` file separator. */
export const MLLP_FS = 0x1c;
/** MLLP carriage return — the byte that follows `<FS>` to close a frame. */
export const MLLP_CR = 0x0d;

/** Malformed framing (no `<VT>` start, or bytes before the start block) — the listener closes the socket. */
export class MllpFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MllpFramingError";
  }
}

/** A malformed MSH header the pre-parse cannot read a control id from — the frame gets an `AE` NAK. */
export class MllpMshParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MllpMshParseError";
  }
}

/**
 * A streaming MLLP frame de-multiplexer. `append(chunk)` feeds raw TCP bytes; `drain()` returns every
 * COMPLETE frame's payload (the bytes BETWEEN `<VT>` and `<FS><CR>`, exclusive) accumulated so far and
 * leaves any partial trailing frame buffered for the next chunk. Not thread-shared — one instance per
 * socket (§4.11.2 gives each connection its own handler).
 */
export class MllpFrameBuffer {
  private buf: Buffer = Buffer.alloc(0);

  /** Append a raw TCP chunk. */
  append(chunk: Buffer | Uint8Array): void {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk)]);
  }

  /**
   * Extract every complete frame currently buffered, as UTF-8 payload strings. Throws `MllpFramingError`
   * if bytes appear before a `<VT>` start block (a stream out of MLLP sync — the caller must close). A
   * partial trailing frame (seen `<VT>` but not yet `<FS><CR>`) stays buffered.
   */
  drain(): string[] {
    const frames: string[] = [];
    for (;;) {
      const start = this.buf.indexOf(MLLP_VT);
      if (start === -1) {
        // No start block. Any leftover non-VT bytes are junk between frames — but real senders never emit
        // them, so treat a non-empty non-VT buffer as a framing error rather than silently dropping bytes.
        if (this.buf.length > 0) {
          this.buf = Buffer.alloc(0);
          throw new MllpFramingError("MLLP stream out of sync: bytes with no <VT> start block");
        }
        return frames;
      }
      if (start > 0) {
        // Bytes precede the <VT> — out of sync.
        this.buf = this.buf.subarray(start);
        throw new MllpFramingError("MLLP stream out of sync: bytes before <VT> start block");
      }
      // Find the <FS><CR> terminator after the start block.
      const fsIdx = this.buf.indexOf(MLLP_FS, 1);
      if (fsIdx === -1 || fsIdx + 1 >= this.buf.length) {
        // Incomplete frame — wait for more bytes.
        return frames;
      }
      if (this.buf[fsIdx + 1] !== MLLP_CR) {
        // <FS> not followed by <CR> — malformed terminator.
        this.buf = Buffer.alloc(0);
        throw new MllpFramingError("MLLP frame terminator <FS> not followed by <CR>");
      }
      const payload = this.buf.subarray(1, fsIdx).toString("utf8");
      frames.push(payload);
      this.buf = this.buf.subarray(fsIdx + 2);
    }
  }

  /** Bytes still buffered (a partial frame). Exposed for the 60s read-timeout close decision (§4.11.3). */
  get pendingBytes(): number {
    return this.buf.length;
  }
}

/** The shallow MSH envelope the listener pre-parse extracts (§4.11.3 step 2). */
export interface MshEnvelope {
  /** MSH-10 — the message control id; the §4.11.3 idempotency key half `(feed_id, message_control_id)`. */
  readonly messageControlId: string;
  /** MSH-9 first component — `ADT` / `ORU` / `ACK` etc. */
  readonly messageCode: string;
  /** MSH-9 second component — the trigger event (`A01`, `R01`, …); empty when MSH-9 has no `^`. */
  readonly triggerEvent: string;
  /** MSH-3 — sending application. */
  readonly sendingApplication: string;
  /** MSH-4 — sending facility (the free-text code the M40 BAA gate resolves, §4.11.2). */
  readonly sendingFacility: string;
  /** MSH-5 — receiving application (echoed into the ACK's MSH-3). */
  readonly receivingApplication: string;
  /** MSH-6 — receiving facility (echoed into the ACK's MSH-4). */
  readonly receivingFacility: string;
}

/**
 * Regex-light MSH pre-parse (§4.11.3 step 2). Reads the field separator from MSH-1 (byte 4 of the segment,
 * conventionally `|`) so a non-standard separator still parses. Throws `MllpMshParseError` when the frame
 * does not begin with an `MSH` segment or has no MSH-10 — the listener NAKs (`AE`) those.
 *
 * NOTE: encoding characters (MSH-2, e.g. `^~\&`) are read for the component separator (default `^`) so the
 * message-type trigger event splits correctly; escape sequences and repetition are NOT expanded here (that
 * is the HAPI sidecar's job).
 */
export function parseMshEnvelope(payload: string): MshEnvelope {
  // The first segment must be MSH; segments are CR-delimited but we only need the first line.
  const firstSegmentEnd = payload.indexOf("\r");
  const msh = (firstSegmentEnd === -1 ? payload : payload.slice(0, firstSegmentEnd)).trimEnd();
  if (!msh.startsWith("MSH")) {
    throw new MllpMshParseError("frame does not begin with an MSH segment");
  }
  // MSH-1 is the field separator itself — the 4th character of the segment.
  const fieldSep = msh.charAt(3);
  if (fieldSep === "") {
    throw new MllpMshParseError("MSH segment has no field separator");
  }
  // Split on the field separator. fields[0] = "MSH", fields[1] = encoding chars, fields[2] = MSH-3, ...
  const fields = msh.split(fieldSep);
  // The component separator is MSH-2's first char (encoding characters), default "^".
  const componentSep = (fields[1] ?? "^").charAt(0) || "^";
  const field = (n: number): string => fields[n - 1] ?? "";
  const messageControlId = field(10).trim();
  if (messageControlId === "") {
    throw new MllpMshParseError("MSH-10 message control id is empty");
  }
  const [messageCode = "", triggerEvent = ""] = field(9).split(componentSep);
  return {
    messageControlId,
    messageCode: messageCode.trim(),
    triggerEvent: triggerEvent.trim(),
    sendingApplication: field(3).trim(),
    sendingFacility: field(4).trim(),
    receivingApplication: field(5).trim(),
    receivingFacility: field(6).trim(),
  };
}

/** `sha256(payload)` as lowercase hex — the §4.11.3 step 4 clear-stored audit projection of the frame. */
export function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** Wrap a payload string in the MLLP `<VT> … <FS><CR>` envelope for transmission (used by the ACK path). */
export function encodeMllpFrame(payload: string): Buffer {
  return Buffer.concat([
    Buffer.from([MLLP_VT]),
    Buffer.from(payload, "utf8"),
    Buffer.from([MLLP_FS, MLLP_CR]),
  ]);
}
