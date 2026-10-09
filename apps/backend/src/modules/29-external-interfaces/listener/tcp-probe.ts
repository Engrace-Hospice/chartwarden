// apps/backend/src/modules/29-external-interfaces/listener/tcp-probe.ts - GAP-043.
//
// An active TCP connect probe of a feed's listener port, run by the worker-process watcher. It answers ONE question:
// does something accept connections on `host:port`. It deliberately does NOT attempt a TLS handshake: the listener
// requires a client certificate (mTLS, TLSv1.3 minimum), which the watcher does not hold, and weakening mTLS to make a
// probe work is out of the question. The socket is closed the instant it connects, sends nothing, and the host comes from
// deployment config (`M29_LISTENER_PROBE_HOST`), never from the feed row - `external_feed.host` is the PARTNER's address
// (the outbound destination), not where our listener binds.
import net from "node:net";

export const TCP_PROBE_TIMEOUT_MS = 2_000;

export type TcpProbe = (host: string, port: number) => Promise<boolean>;

/** Resolve `true` when a TCP connection to `host:port` is accepted within `timeoutMs`, else `false`. Never rejects. */
export function probeTcpPort(
  host: string,
  port: number,
  timeoutMs: number = TCP_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
