// apps/backend/src/modules/36-messaging/attachments/attachment-scanners.ts — WP 1.5: the two `ScanPort` adapters.
//
//   • `createClamdScanner` — the production path: the clamd INSTREAM protocol over TCP to a ClamAV sidecar. Any
//     transport error, timeout, malformed or `ERROR` reply THROWS, so the attachment stays `pending` (fail closed).
//   • `createBuiltinScanner` — a deterministic, dependency-free check for dev/CI/demo: the EICAR test string and a
//     declared-type-vs-magic-bytes mismatch are infected; everything else is clean. It is NOT an antivirus engine, so
//     the composition root binds it only on an explicit opt-in (MESSAGING_ATTACHMENT_SCANNER=builtin).
import { Socket } from "node:net";
import type { ScanPort, ScanVerdict } from "./attachment-ports";

const EICAR = Buffer.from(
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
  "latin1",
);
/** A clamd verdict is one short line; anything bigger than this is not one. */
const MAX_CLAMD_REPLY_BYTES = 1024;
export const EICAR_SIGNATURE = "Eicar-Test-Signature";
export const TYPE_MISMATCH_SIGNATURE = "content-type-mismatch";

const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
  prefix.every((b, i) => bytes[i] === b);

/** Does the content look like the type it was declared as? Unknown types are not accepted at all (allowlist upstream). */
function matchesDeclaredType(bytes: Uint8Array, mimeType: string): boolean {
  switch (mimeType) {
    case "application/pdf":
      return Buffer.from(bytes.subarray(0, 1024)).includes("%PDF-");
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/tiff":
      return (
        startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])
      );
    case "text/plain":
      return !bytes.includes(0x00);
    default:
      // docx is a zip container
      return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
  }
}

export function createBuiltinScanner(): ScanPort {
  return {
    name: "builtin-signature",
    async scan({ bytes, mimeType }): Promise<ScanVerdict> {
      if (Buffer.from(bytes).includes(EICAR)) {
        return { verdict: "infected", signature: EICAR_SIGNATURE };
      }
      if (!matchesDeclaredType(bytes, mimeType)) {
        return { verdict: "infected", signature: TYPE_MISMATCH_SIGNATURE };
      }
      return { verdict: "clean" };
    },
  };
}

export interface ClamdScannerOptions {
  readonly host: string;
  readonly port: number;
  /** Whole-scan deadline. Default 30 s. */
  readonly timeoutMs?: number;
  /** clamd's StreamMaxLength is the other half of this limit; keep them aligned. */
  readonly chunkBytes?: number;
}

/** Parse a clamd reply (`stream: OK` / `stream: <name> FOUND` / `... ERROR`). Anything else is an error. */
export function parseClamdReply(reply: string): ScanVerdict {
  const text = reply.replace(/\0/g, "").trim();
  if (/^stream:\s+OK$/.test(text)) return { verdict: "clean" };
  const found = /^stream:\s+(.+)\s+FOUND$/.exec(text);
  if (found?.[1]) return { verdict: "infected", signature: found[1] };
  throw new Error(`clamd scan did not produce a verdict: ${text.slice(0, 80) || "(empty reply)"}`);
}

export function createClamdScanner(options: ClamdScannerOptions): ScanPort {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const chunkBytes = options.chunkBytes ?? 64 * 1024;
  return {
    name: "clamd",
    endpoint: `${options.host}:${options.port}`,
    scan({ bytes, signal }) {
      return new Promise<ScanVerdict>((resolve, reject) => {
        const socket = new Socket();
        const chunks: Buffer[] = [];
        let settled = false;
        const onAbort = () =>
          finish(() =>
            reject(
              signal?.reason instanceof Error ? signal.reason : new Error("clamd scan aborted"),
            ),
          );
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          socket.destroy(); // the socket really closes: an aborted scan leaves nothing running
          fn();
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        socket.setTimeout(timeoutMs, () => finish(() => reject(new Error("clamd scan timed out"))));
        // Total deadline too: the socket timeout above is only an idle timeout.
        const deadline = setTimeout(
          () => finish(() => reject(new Error("clamd scan exceeded its deadline"))),
          timeoutMs,
        );
        socket.on("close", () => clearTimeout(deadline));
        socket.on("error", (error) => finish(() => reject(error)));
        let replyBytes = 0;
        socket.on("data", (data) => {
          replyBytes += data.length;
          // A verdict line is tiny; a runaway reply is a misbehaving peer, not something to buffer.
          if (replyBytes > MAX_CLAMD_REPLY_BYTES) {
            finish(() => reject(new Error("clamd reply exceeded its size cap")));
            return;
          }
          chunks.push(data);
        });
        socket.on("end", () =>
          finish(() => {
            try {
              resolve(parseClamdReply(Buffer.concat(chunks).toString("utf8")));
            } catch (error) {
              reject(error);
            }
          }),
        );
        /** Write respecting backpressure: wait for `drain` instead of queueing up to 25 MB in the socket buffer. */
        const writeAll = async () => {
          const send = async (data: Buffer) => {
            if (!socket.write(data)) {
              await new Promise<void>((done, fail) => {
                // Each listener removes the other, so a long upload does not pile up one `close` listener per drain.
                const onDrain = () => {
                  socket.off("close", onClose);
                  done();
                };
                const onClose = () => {
                  socket.off("drain", onDrain);
                  fail(new Error("clamd closed during upload"));
                };
                socket.once("drain", onDrain);
                socket.once("close", onClose);
              });
            }
          };
          await send(Buffer.from("zINSTREAM\0"));
          for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
            const chunk = Buffer.from(bytes.subarray(offset, offset + chunkBytes));
            const size = Buffer.alloc(4);
            size.writeUInt32BE(chunk.length);
            await send(size);
            await send(chunk);
          }
          await send(Buffer.alloc(4)); // zero-length chunk ends the stream
        };
        socket.connect(options.port, options.host, () => {
          writeAll().catch((error) => finish(() => reject(error)));
        });
      });
    },
  };
}
