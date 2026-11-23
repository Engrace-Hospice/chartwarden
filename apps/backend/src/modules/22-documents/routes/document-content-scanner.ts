// M22-owned clamd adapter for document uploads. M36 owns message-attachment scanning and is not
// imported here: the two modules keep their ports and lifecycle decisions independent while using
// the same production clamd sidecar and wire protocol.
import { Socket } from "node:net";

const MAX_CLAMD_REPLY_BYTES = 1024;

export type ContentScanVerdict = { readonly verdict: "clean" | "infected" };

/** M22's malware-scanner port over bytes that already passed the deterministic content gate. */
export interface DocumentContentScanner {
  scan(input: {
    readonly bytes: Uint8Array;
    readonly mimeType: string;
    /** Aborts a scan whose caller has stopped waiting. */
    readonly signal?: AbortSignal;
  }): Promise<ContentScanVerdict>;
}

export interface ClamdDocumentScannerOptions {
  readonly host: string;
  readonly port: number;
  /** Whole-scan and idle deadline. */
  readonly timeoutMs?: number;
  readonly chunkBytes?: number;
}

/** Accept only the two verdict shapes clamd documents for INSTREAM. */
export function parseClamdDocumentReply(reply: string): { verdict: "clean" | "infected" } {
  const text = reply.replace(/\0/g, "").trim();
  if (/^stream:\s+OK$/.test(text)) return { verdict: "clean" };
  if (/^stream:\s+.+\s+FOUND$/.test(text)) return { verdict: "infected" };
  throw new Error(`clamd scan did not produce a verdict: ${text.slice(0, 80) || "(empty reply)"}`);
}

export function createClamdDocumentScanner(
  options: ClamdDocumentScannerOptions,
): DocumentContentScanner {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const chunkBytes = options.chunkBytes ?? 64 * 1024;
  return {
    scan({ bytes, signal }) {
      return new Promise((resolve, reject) => {
        const socket = new Socket();
        const replies: Buffer[] = [];
        let replyBytes = 0;
        let settled = false;

        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          signal?.removeEventListener("abort", onAbort);
          socket.destroy();
          fn();
        };
        const onAbort = () =>
          finish(() =>
            reject(
              signal?.reason instanceof Error ? signal.reason : new Error("clamd scan aborted"),
            ),
          );

        const deadline = setTimeout(
          () => finish(() => reject(new Error("clamd scan exceeded its deadline"))),
          timeoutMs,
        );
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        socket.setTimeout(timeoutMs, () => finish(() => reject(new Error("clamd scan timed out"))));
        socket.on("error", (error) => finish(() => reject(error)));
        socket.on("data", (data) => {
          replyBytes += data.length;
          if (replyBytes > MAX_CLAMD_REPLY_BYTES) {
            finish(() => reject(new Error("clamd reply exceeded its size cap")));
            return;
          }
          replies.push(data);
        });
        socket.on("end", () =>
          finish(() => {
            try {
              resolve(parseClamdDocumentReply(Buffer.concat(replies).toString("utf8")));
            } catch (error) {
              reject(error);
            }
          }),
        );

        const writeAll = async () => {
          const send = async (data: Buffer) => {
            if (socket.write(data)) return;
            await new Promise<void>((done, fail) => {
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
          };
          await send(Buffer.from("zINSTREAM\0"));
          for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
            const chunk = Buffer.from(bytes.subarray(offset, offset + chunkBytes));
            const size = Buffer.alloc(4);
            size.writeUInt32BE(chunk.length);
            await send(size);
            await send(chunk);
          }
          await send(Buffer.alloc(4));
        };

        socket.connect(options.port, options.host, () => {
          writeAll().catch((error) => finish(() => reject(error)));
        });
      });
    },
  };
}

/** A host is the explicit binding switch; an absent host leaves the existing fail-closed port unbound. */
export function documentContentScannerFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): DocumentContentScanner | null {
  const host = env.CLAMD_HOST?.trim();
  if (!host) return null;
  const rawPort = env.CLAMD_PORT?.trim() || "3310";
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CLAMD_PORT must be an integer from 1 to 65535");
  }
  return createClamdDocumentScanner({ host, port });
}

/** Production can never opt out; dev/test enable the control explicitly for production-path acceptance. */
export function documentUploadScanRequired(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env.NODE_ENV === "production" || env.DOCUMENT_UPLOAD_SCAN_REQUIRED === "true";
}
