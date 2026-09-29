// apps/backend/src/modules/29-external-interfaces/outbound — outbound MLLP NETWORK TRANSPORT (F-175).
//
// The pure outbound ORM core (`dispatch-planner.ts` / `orm-o01.ts` / `ack-correlation.ts` /
// `retry-policy.ts`) never touches a socket. This file is the one place in M29's outbound path that
// dials OUT to a destination HL7 receiver, frames the wire message via the listener's own
// `encodeMllpFrame`, and reads back the framed ACK response using the listener's own `MllpFrameBuffer`
// — the SAME stream de-multiplexer `listener/mllp-framing.ts` built for the inbound side, reused
// verbatim here rather than re-implemented (its header comment says as much: "the caller does the
// idempotency check / persist / enqueue / ACK per frame, all OUTSIDE this module" — framing itself is
// symmetric for a byte stream regardless of which end initiated the TCP connection).
//
// SCOPE — THIS FILE ONLY DIALS AND SPEAKS MLLP. It does not resolve an `external_feed` row, does not
// decrypt a per-feed credential, does not apply the D16 BAA gate, and does not drive retry/backoff or
// touch the outbox — those are the T08 worker's job (a parallel, separately tracked build importing
// this file). `MllpTransportSendInput` is deliberately IO-adjacent: the caller supplies exactly the
// fields this file needs (host/port/protocol/pin/wire message/timeouts) and nothing this file has no
// business holding (no credential material, no DB row, no org context).
//
// DEVIATION FROM `docs/modules/module-29-tasks/WARDENX_T-29.08_OUTBOUND_ORM.md` §6 (the
// `MllpOutboundClient` addendum design). That doc additionally does CLIENT-CERTIFICATE mTLS (per-feed
// `clientCertPem`/`clientKeyPem`/`expectedServerCaPem` decrypted out of `external_feed_credential`) and
// an in-memory CRL revocation check. This file implements ONLY the `channelCertPin` server-certificate
// pinning contract that is actually PRESENT in the built schema today (`packages/db/src/schema/
// external-interfaces/feed.ts` — `externalFeed.channelCertPin`, "sha256(certPEM) — null only for
// mllp_plain (test only)"); no `external_feed_credential` payload shape for outbound client-cert
// material exists anywhere else in the built repo (grepped — only inbound MTLS_CERT rotation routes
// exist), so building against that addendum's design here would be building against a shape nothing
// else backs. If the T08 worker later needs client-cert mTLS, extending `MllpTransportSendInput` with
// optional `clientCertPem`/`clientKeyPem` fields is additive and would not break this contract — flagged
// for the coordinator to reconcile against the parallel fork, not decided unilaterally here.
//
// CERT-PIN CONVENTION — FLAGGED ASSUMPTION. The schema doc comment reads `channelCertPin: sha256
// (certPEM)`, but nowhere in the repo is that value actually COMPUTED: every call site (`routes/
// store.ts`, `routes/store-drizzle.ts`, `routes/m29-typebox.ts`) treats it as an opaque admin-supplied
// string, validated only by a `^[a-f0-9]{64}$` TypeBox pattern (grepped `channelCertPin`, `certPEM`,
// `checkServerIdentity`, `getPeerCertificate` repo-wide — no minting site found). Per the coordinator's
// explicit fallback instruction for this exact situation, this file assumes the standard convention —
// **sha256 hex digest of the peer certificate's DER encoding**, i.e.
// `crypto.createHash("sha256").update(cert.raw).digest("hex")` — NOT a hash of a re-serialized PEM
// string. PEM re-encoding is not byte-stable across tools (line-wrap width, trailing newline, CRLF vs
// LF, header/footer whitespace all vary), which would make a PEM-string hash useless as a pin; the DER
// bytes Node's TLS layer hands back on `getPeerCertificate().raw` (and on the `cert` argument to
// `checkServerIdentity`) are the one canonical, tool-independent encoding. **Flagging clearly: if the
// admin UI or another part of the system mints `channelCertPin` as sha256 of a PEM string instead, pins
// minted there will NOT match what this file computes, and every `mllp_tls` send will hard-fail as a
// pin mismatch.** This needs reconciling — either the pin-minting path adopts the DER convention, or
// this file is updated to match whatever the minting path actually does — before this ships live.
//
// TLS POSTURE. `minVersion: "TLSv1.3"` per architecture §8.7's MLLP TLS posture (TLS 1.3 minimum, no
// 1.2 fallback) — the same floor the inbound listener's mTLS posture cites. `rejectUnauthorized: false`:
// partner-issued certs are frequently self-signed or chain to a CA this process has no trust-store entry
// for, and channel trust here is decided BY PIN, not by CA — Node's default chain/hostname verification
// is the wrong check to run at all.
//
// CERT-PIN ENFORCEMENT POINT — an empirically-forced choice, not just a style pick. The task's own
// guidance was to prefer overriding `checkServerIdentity` (it runs mid-handshake, before `secureConnect`
// can fire, so an `Error` returned from it aborts the handshake before any data could be written) over a
// manual post-`secureConnect` check. That was tried first here — and DISCOVERED NOT TO WORK on this
// repo's actual runtime. Reproduced directly (see the scratch repro this finding came from): with
// `rejectUnauthorized: false`, `checkServerIdentity` is never invoked AT ALL on either Node or Bun — the
// chain-verification step that would call it is skipped entirely, so `secureConnect` fires regardless of
// what the function would have returned. Retried with `rejectUnauthorized: true` plus the peer cert
// explicitly trusted via `ca`: Node then DOES call `checkServerIdentity` and correctly aborts on a
// returned `Error` — but Bun (`bun --version` in this repo; the actual runtime, not just the test
// runner) still lets `secureConnect` fire, ignoring the returned `Error` entirely. Since this codebase
// runs on Bun, `checkServerIdentity` cannot be trusted to enforce anything here — using it as the
// enforcement point would pass every test run under Node while silently never pinning anything in
// production. So the pin check below runs as a MANUAL check performed synchronously inside the
// `secureConnect` handler (`getPeerCertificate().raw`, verified reliable and identical on both runtimes),
// BEFORE the outgoing frame is ever built or written — no `await`, no timer, no I/O between
// `secureConnect` firing and the mismatch branch calling `settle()`/destroying the socket, so nothing
// this process controls can race a write in ahead of the check. This is a real, if narrower, guarantee
// than aborting mid-handshake (the TLS session itself has already completed by this point), but it is the
// one that actually holds on the runtime this ships on — the `checkServerIdentity` override the task
// suggested as more "robust" would have been silently inert.
//
// PHI DISCIPLINE. Every typed failure outcome's `errorClass` is built ONLY from a Node error's `.code`
// (an OpenSSL/libuv error constant such as `ECONNREFUSED` / `CERT_HAS_EXPIRED`) or a short fixed string
// this file itself defines (e.g. `"cert_pin_mismatch"`). Nothing here ever reads or forwards
// `wireMessage` or the raw ACK bytes into an error path — `rawAckPayload` is returned ONLY on the `ack`
// outcome, where it is up to the caller (never this file) to decide what of it is safe to log.
import { createHash } from "node:crypto";
import { type Socket, connect as netConnect, isIP } from "node:net";
import { type PeerCertificate, type TLSSocket, connect as tlsConnect } from "node:tls";
import { MllpFrameBuffer, MllpFramingError, encodeMllpFrame } from "../listener/mllp-framing";

/** Input to a single outbound MLLP send-and-await-ack attempt. One call == one TCP/TLS connection,
 *  one framed write, one framed read, then the socket is always closed — no connection pooling/reuse
 *  (the T08 worker decides call cadence / retry; this file is stateless per call). */
export interface MllpTransportSendInput {
  readonly host: string;
  readonly port: number;
  readonly protocol: "mllp_tls" | "mllp_plain";
  /** Required (and enforced) for `"mllp_tls"`; ignored for `"mllp_plain"`. sha256(DER cert) hex digest —
   *  see the CERT-PIN CONVENTION note above. A `null`/malformed pin on an `mllp_tls` send is refused
   *  (`tls_error`) before any socket is even opened — never a silent downgrade. */
  readonly channelCertPin: string | null;
  /** The UNFRAMED HL7 wire string (e.g. from `buildOrmO01`) — this function frames it via
   *  `encodeMllpFrame` before writing it to the socket. Never logged by this file. */
  readonly wireMessage: string;
  /** Timeout covering DNS + TCP connect, and for `mllp_tls` the TLS handshake too (there is no
   *  intermediate "TCP connected, still handshaking" outcome kind — both stages share this budget and
   *  both time out as `connect_timeout`, matching a receiver that "accepts the TCP connection but never
   *  completes it"). */
  readonly connectTimeoutMs: number;
  /** Timeout for receiving a COMPLETE framed ACK after the message write succeeds. A distinct budget
   *  from `connectTimeoutMs` — a socket can connect (and TLS-handshake) fine and then the peer simply
   *  never sends anything back. */
  readonly ackTimeoutMs: number;
}

/** The outcome of one `send()` call. Never thrown for an expected failure mode — pattern-match this
 *  instead of wrapping `send()` in try/catch. */
export type MllpTransportOutcome =
  | { readonly kind: "ack"; readonly rawAckPayload: string }
  | { readonly kind: "connect_error"; readonly errorClass: string }
  /** Includes TLS handshake failure AND a cert-pin mismatch/missing-pin refusal. */
  | { readonly kind: "tls_error"; readonly errorClass: string }
  | { readonly kind: "connect_timeout" }
  | { readonly kind: "ack_timeout" }
  | { readonly kind: "write_error"; readonly errorClass: string }
  /** A response that never forms a complete, in-sync MLLP frame — includes the peer closing the
   *  connection before a frame completed (with zero bytes, or with a partial one). */
  | { readonly kind: "malformed_response"; readonly errorClass: string };

export interface MllpTransport {
  send(input: MllpTransportSendInput): Promise<MllpTransportOutcome>;
}

const CERT_PIN_PATTERN = /^[0-9a-f]{64}$/i;

/** TCP/libuv-level error codes that mean "never reached the peer" — anything else observed on the
 *  socket's `error` event before the TLS handshake completes is treated as a TLS-layer failure (protocol
 *  mismatch, cert verification incl. our own pin check, etc.) rather than a network-reachability one. */
const TCP_LEVEL_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "EAI_AGAIN",
]);

/** A short, PHI-free diagnostic class from a Node error — `.code` when present (an OpenSSL/libuv
 *  constant), else a truncated `.message` (this file only ever throws its OWN short fixed-string
 *  messages from application code, e.g. `"cert_pin_mismatch"`, so the message-fallback path never carries
 *  arbitrary third-party or payload content). */
function classifyError(err: NodeJS.ErrnoException | Error): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code) return code;
  const message = err.message || "unknown_error";
  return message.length > 100 ? `${message.slice(0, 100)}…` : message;
}

/** sha256(DER cert) hex — see the CERT-PIN CONVENTION header note for why DER, not a re-serialized PEM
 *  string. */
function derSha256Hex(cert: PeerCertificate): string | null {
  if (!cert || !cert.raw || cert.raw.length === 0) return null;
  return createHash("sha256").update(cert.raw).digest("hex");
}

/** The manual, synchronous post-`secureConnect` pin check — see the CERT-PIN ENFORCEMENT POINT header
 *  note for why this replaces a `checkServerIdentity` override. `null` means "match" (proceed);
 *  otherwise the short PHI-free `errorClass` to fail with. */
function checkCertPin(socket: TLSSocket, expectedPinHex: string): string | null {
  const expected = expectedPinHex.toLowerCase();
  const peerCert = socket.getPeerCertificate(true);
  const actual = derSha256Hex(peerCert);
  if (actual === null) return "cert_pin_no_peer_certificate";
  if (actual !== expected) return "cert_pin_mismatch";
  return null;
}

/** One outbound MLLP send-and-await-ack attempt: connect (TCP or TLS+pin), write the framed message,
 *  read the framed ACK, always close. Resolves to a typed outcome — never rejects for an expected
 *  failure mode. */
function sendOverMllp(input: MllpTransportSendInput): Promise<MllpTransportOutcome> {
  if (input.protocol === "mllp_tls") {
    if (!input.channelCertPin) {
      return Promise.resolve({ kind: "tls_error", errorClass: "cert_pin_missing" });
    }
    if (!CERT_PIN_PATTERN.test(input.channelCertPin)) {
      return Promise.resolve({ kind: "tls_error", errorClass: "cert_pin_malformed" });
    }
  }

  return new Promise<MllpTransportOutcome>((resolve) => {
    let settled = false;
    /** True once the connection is ready to write to: TCP `connect` for `mllp_plain`, TLS
     *  `secureConnect` for `mllp_tls`. Used to classify an `error` event that fires before this point as
     *  connect/TLS-stage, and after this point as a mid-response transport failure. */
    let readyToWrite = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    let socket: Socket | TLSSocket | undefined;
    const frameBuffer = new MllpFrameBuffer();

    const cleanup = (): void => {
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      if (ackTimer !== undefined) clearTimeout(ackTimer);
      connectTimer = undefined;
      ackTimer = undefined;
      if (socket) {
        socket.removeAllListeners();
        if (!socket.destroyed) socket.destroy();
      }
    };

    const settle = (outcome: MllpTransportOutcome): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    connectTimer = setTimeout(() => settle({ kind: "connect_timeout" }), input.connectTimeoutMs);

    const onReadyToWrite = (): void => {
      readyToWrite = true;
      if (connectTimer !== undefined) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }

      // TLS pin check — synchronous, BEFORE the frame is built or written. See the CERT-PIN ENFORCEMENT
      // POINT header note: this (not `checkServerIdentity`) is the actual enforcement point.
      if (input.protocol === "mllp_tls") {
        const pinFailure = checkCertPin(socket as TLSSocket, input.channelCertPin as string);
        if (pinFailure !== null) {
          settle({ kind: "tls_error", errorClass: pinFailure });
          return;
        }
      }

      const frame = encodeMllpFrame(input.wireMessage);
      socket!.write(frame, (err) => {
        if (err) {
          settle({ kind: "write_error", errorClass: classifyError(err) });
          return;
        }
        ackTimer = setTimeout(() => settle({ kind: "ack_timeout" }), input.ackTimeoutMs);
      });
    };

    const onData = (chunk: Buffer): void => {
      try {
        frameBuffer.append(chunk);
        const frames = frameBuffer.drain();
        if (frames.length > 0) {
          settle({ kind: "ack", rawAckPayload: frames[0]! });
        }
      } catch (err) {
        if (err instanceof MllpFramingError) {
          settle({ kind: "malformed_response", errorClass: "mllp_framing_error" });
          return;
        }
        settle({ kind: "malformed_response", errorClass: "response_parse_error" });
      }
    };

    const onClose = (): void => {
      settle({
        kind: "malformed_response",
        errorClass: frameBuffer.pendingBytes > 0 ? "connection_closed_mid_frame" : "connection_closed_no_response",
      });
    };

    const onError = (err: NodeJS.ErrnoException): void => {
      if (!readyToWrite) {
        if (input.protocol === "mllp_tls" && !TCP_LEVEL_ERROR_CODES.has(err.code ?? "")) {
          settle({ kind: "tls_error", errorClass: classifyError(err) });
        } else {
          settle({ kind: "connect_error", errorClass: classifyError(err) });
        }
        return;
      }
      // Past the connect/handshake stage, waiting on (or mid-way through) the ACK read — a socket-level
      // error here means the peer dropped the connection, not a fresh connect/TLS failure.
      settle({ kind: "malformed_response", errorClass: classifyError(err) });
    };

    if (input.protocol === "mllp_plain") {
      socket = netConnect({ host: input.host, port: input.port });
      socket.once("connect", onReadyToWrite);
    } else {
      const tlsSocket = tlsConnect({
        host: input.host,
        port: input.port,
        // SNI `servername` must be a hostname, never a literal IP (Node throws otherwise) — omit it
        // when `host` is an IP literal. This only affects which cert a multi-tenant/SNI-routing receiver
        // presents, never our trust decision (that's `checkCertPin`, run from `onReadyToWrite`).
        ...(isIP(input.host) === 0 ? { servername: input.host } : {}),
        minVersion: "TLSv1.3",
        // Node's default CA-chain/hostname verification is the wrong check for a pinned channel (partner
        // certs are frequently self-signed) — trust is decided entirely by `checkCertPin` post-connect.
        rejectUnauthorized: false,
      });
      socket = tlsSocket;
      tlsSocket.once("secureConnect", onReadyToWrite);
    }
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

/** The real `node:net`/`node:tls`-backed transport. */
export function createNodeMllpTransport(): MllpTransport {
  return { send: sendOverMllp };
}
