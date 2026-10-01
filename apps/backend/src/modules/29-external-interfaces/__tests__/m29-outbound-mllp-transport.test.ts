// apps/backend/src/modules/29-external-interfaces/__tests__ — LIVE test suite for the outbound MLLP
// transport (F-175, `outbound/mllp-transport.ts`). No mocks: every test spins up a REAL in-process
// `node:net`/`node:tls` server acting as a destination HL7 receiver test double, and drives the real
// `createNodeMllpTransport()` client against it over a real loopback TCP socket.
//
// Run standalone (no Docker/Postgres — pure networking):
//   bun run vitest run apps/backend/src/modules/29-external-interfaces/__tests__/m29-outbound-mllp-transport.test.ts
import { execFileSync } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tls from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { certPinFromPem } from "../feed/cert-pin";
import { MllpFrameBuffer, encodeMllpFrame } from "../listener/mllp-framing";
import { type MllpTransportSendInput, createNodeMllpTransport } from "../outbound/mllp-transport";

// A wire message carrying an obviously-fake-but-distinctive "PHI-shaped" marker, so test 8 (no PHI
// leakage) has something identifying to search for in every captured error string.
const PHI_MARKER = "SSN-999-88-7777-DOE-JOHN-DOB19400101";
const ORM_WIRE = `MSH|^~\\&|WARDENX|ORG1|LABSYS|LAB1|20260929120000||ORM^O01|MC${Date.now()}|P|2.5.1\rPID|1||MRN1^^^H||DOE^JOHN^^^^^L|||${PHI_MARKER}`;
const ACK_WIRE =
  "MSH|^~\\&|LABSYS|LAB1|WARDENX|ORG1|20260929120005||ACK|ACKMC1|P|2.5.1\rMSA|AA|MC1";

function baseInput(overrides: Partial<MllpTransportSendInput>): MllpTransportSendInput {
  return {
    host: "127.0.0.1",
    port: 0,
    protocol: "mllp_plain",
    channelCertPin: null,
    wireMessage: ORM_WIRE,
    connectTimeoutMs: 1_000,
    ackTimeoutMs: 1_000,
    // The suite dials loopback test doubles; the F-181 refusal tests below override this to false.
    allowLoopback: true,
    ...overrides,
  };
}

async function listen(server: net.Server | tls.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind a TCP port");
  }
  return address.port;
}

/** Test-server-side sockets accepted by the server currently under test, tracked so `close()` can force
 *  them shut. `net.Server.close()`/`tls.Server.close()` only stop accepting NEW connections — they wait
 *  for existing ones to end naturally, and a client-side `destroy()` on a socket that never completed a
 *  TLS handshake does not always propagate a timely FIN to the server side (observed directly: the
 *  `connect_timeout` scenario's raw-TCP-accept-then-silence server left its accepted socket open for
 *  10s+ after the client gave up, hanging `server.close()`'s callback). Tests below push into this set
 *  from their `connection`/`secureConnection` handler. */
let liveServerSockets: Set<net.Socket> = new Set();

function trackConnections(server: net.Server | tls.Server): void {
  const event = server instanceof tls.Server ? "secureConnection" : "connection";
  server.on(event as "connection", (socket: net.Socket) => {
    liveServerSockets.add(socket);
    socket.once("close", () => liveServerSockets.delete(socket));
  });
}

async function close(server: net.Server | tls.Server | undefined): Promise<void> {
  if (!server) return;
  for (const socket of liveServerSockets) {
    if (!socket.destroyed) socket.destroy();
  }
  liveServerSockets = new Set();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// ── Self-signed test certificate (generated once via the system `openssl` CLI — no new dependency) ──────

let tlsCertPem: string;
let tlsKeyPem: string;
let correctPinHex: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "m29-mllp-transport-tls-"));
  try {
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=wardenx-test-lab-receiver",
    ]);
    tlsCertPem = readFileSync(certPath, "utf8");
    tlsKeyPem = readFileSync(keyPath, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The transport pins sha256(DER cert) — see mllp-transport.ts's CERT-PIN CONVENTION note. `X509Certificate
  // .raw` is the same DER encoding `tlsSocket.getPeerCertificate().raw` hands the client at handshake time.
  correctPinHex = createHash("sha256").update(new X509Certificate(tlsCertPem).raw).digest("hex");
});

let currentServer: net.Server | tls.Server | undefined;

afterEach(async () => {
  await close(currentServer);
  currentServer = undefined;
});

afterAll(() => {
  // Nothing global left open — every test closes its own server in afterEach. This suite completing
  // without vitest hanging is itself evidence the transport leaks no sockets/timers (a leaked open
  // handle keeps the process alive past the last test).
});

// ── 1. mllp_plain round trip ───────────────────────────────────────────────────────────────────────────

describe("mllp_plain round trip", () => {
  it("frames the outgoing message, and unframes a correctly-framed ACK reply", async () => {
    const receivedFrames: string[] = [];
    const server = net.createServer((socket) => {
      const buf = new MllpFrameBuffer();
      socket.on("data", (chunk) => {
        buf.append(chunk);
        for (const frame of buf.drain()) {
          receivedFrames.push(frame);
          socket.write(encodeMllpFrame(ACK_WIRE));
        }
      });
    });
    trackConnections(server);
    currentServer = server;
    const port = await listen(server);

    const transport = createNodeMllpTransport();
    const outcome = await transport.send(baseInput({ port }));

    expect(receivedFrames).toEqual([ORM_WIRE]);
    expect(outcome).toEqual({ kind: "ack", rawAckPayload: ACK_WIRE });
  });
});

// ── 2 & 3. mllp_tls round trip: correct pin succeeds, wrong pin is refused ───────────────────────────────

describe("mllp_tls with channel cert pinning", () => {
  function startTlsAckServer(): { server: tls.Server; receivedFrames: string[] } {
    const receivedFrames: string[] = [];
    const server = tls.createServer(
      { cert: tlsCertPem, key: tlsKeyPem, minVersion: "TLSv1.3" },
      (socket) => {
        const buf = new MllpFrameBuffer();
        socket.on("data", (chunk) => {
          buf.append(chunk);
          for (const frame of buf.drain()) {
            receivedFrames.push(frame);
            socket.write(encodeMllpFrame(ACK_WIRE));
          }
        });
      },
    );
    return { server, receivedFrames };
  }

  it("succeeds when the presented cert matches channelCertPin", async () => {
    const { server, receivedFrames } = startTlsAckServer();
    trackConnections(server);
    currentServer = server;
    const port = await listen(server);

    const transport = createNodeMllpTransport();
    const outcome = await transport.send(
      baseInput({ protocol: "mllp_tls", channelCertPin: correctPinHex, port }),
    );

    expect(receivedFrames).toEqual([ORM_WIRE]);
    expect(outcome).toEqual({ kind: "ack", rawAckPayload: ACK_WIRE });
  });

  it("REFUSES the connection and never sends when channelCertPin does not match (the critical negative test)", async () => {
    const { server, receivedFrames } = startTlsAckServer();
    trackConnections(server);
    currentServer = server;
    const port = await listen(server);

    // A well-formed-looking but WRONG pin (sha256 of an arbitrary different buffer, not the server's cert).
    const wrongPin = createHash("sha256").update("not-the-real-certificate").digest("hex");
    expect(wrongPin).not.toBe(correctPinHex);

    const transport = createNodeMllpTransport();
    const outcome = await transport.send(
      baseInput({ protocol: "mllp_tls", channelCertPin: wrongPin, port }),
    );

    expect(outcome).toEqual({ kind: "tls_error", errorClass: "cert_pin_mismatch" });
    // The whole point of the pin check: the message must never reach the peer on a mismatched cert.
    expect(receivedFrames).toEqual([]);
  });

  it("REFUSES an mllp_tls send with a null channelCertPin without opening a socket", async () => {
    const { server, receivedFrames } = startTlsAckServer();
    trackConnections(server);
    currentServer = server;
    const port = await listen(server);

    const transport = createNodeMllpTransport();
    const outcome = await transport.send(
      baseInput({ protocol: "mllp_tls", channelCertPin: null, port }),
    );

    expect(outcome).toEqual({ kind: "tls_error", errorClass: "cert_pin_missing" });
    expect(receivedFrames).toEqual([]);
  });
});

// ── 4. Connect refused ─────────────────────────────────────────────────────────────────────────────────

describe("connect_error", () => {
  it("returns connect_error when nothing is listening on the port", async () => {
    // Bind a server to get a genuinely free loopback port, then close it immediately so the port is
    // guaranteed unbound but was just proven routable.
    const probe = net.createServer();
    const freePort = await listen(probe);
    await close(probe);

    const transport = createNodeMllpTransport();
    const outcome = await transport.send(baseInput({ port: freePort, connectTimeoutMs: 2_000 }));

    expect(outcome.kind).toBe("connect_error");
    if (outcome.kind === "connect_error") {
      expect(outcome.errorClass).toBe("ECONNREFUSED");
    }
  });
});

// ── 5. Connect timeout ─────────────────────────────────────────────────────────────────────────────────

describe("connect_timeout", () => {
  it("times out when the peer accepts the TCP connection but never completes the TLS handshake", async () => {
    // A raw TCP server (no TLS at all) that accepts the connection and then sends nothing — from the
    // client's TLS perspective this is "connected but the handshake never completes", exactly the
    // scenario connectTimeoutMs is meant to bound.
    const server = net.createServer((socket) => {
      socket.on("error", () => {
        /* swallow the eventual client-side destroy */
      });
    });
    trackConnections(server);
    currentServer = server;
    const port = await listen(server);

    const transport = createNodeMllpTransport();
    const outcome = await transport.send(
      baseInput({
        protocol: "mllp_tls",
        channelCertPin: correctPinHex,
        port,
        connectTimeoutMs: 200,
      }),
    );

    expect(outcome).toEqual({ kind: "connect_timeout" });
  });
});

// ── 6. ACK timeout ─────────────────────────────────────────────────────────────────────────────────────

describe("ack_timeout", () => {
  it("times out when the peer accepts + reads the message but never replies", async () => {
    const receivedFrames: string[] = [];
    const server = net.createServer((socket) => {
      const buf = new MllpFrameBuffer();
      socket.on("data", (chunk) => {
        buf.append(chunk);
        receivedFrames.push(...buf.drain());
        // Deliberately never writes an ACK back.
      });
    });
    trackConnections(server);
    currentServer = server;
    const port = await listen(server);

    const transport = createNodeMllpTransport();
    const outcome = await transport.send(baseInput({ port, ackTimeoutMs: 200 }));

    expect(receivedFrames).toEqual([ORM_WIRE]);
    expect(outcome).toEqual({ kind: "ack_timeout" });
  });
});

// ── 7. Malformed / incomplete response ─────────────────────────────────────────────────────────────────

describe("malformed_response", () => {
  it("classifies bytes that never form a valid MLLP frame (no <VT> start) as malformed_response", async () => {
    const server = net.createServer((socket) => {
      socket.on("data", () => {
        socket.write(Buffer.from("not-an-mllp-frame-at-all"));
      });
    });
    trackConnections(server);
    currentServer = server;
    const port = await listen(server);

    const transport = createNodeMllpTransport();
    const outcome = await transport.send(baseInput({ port }));

    expect(outcome.kind).toBe("malformed_response");
  });

  it("classifies the peer closing mid-frame as malformed_response", async () => {
    const server = net.createServer((socket) => {
      socket.on("data", () => {
        // Write a <VT>-started frame that never terminates, then close.
        socket.end(Buffer.from([0x0b, 0x4d, 0x53, 0x48])); // <VT> "MSH" — no <FS><CR> terminator
      });
    });
    trackConnections(server);
    currentServer = server;
    const port = await listen(server);

    const transport = createNodeMllpTransport();
    const outcome = await transport.send(baseInput({ port }));

    expect(outcome).toEqual({
      kind: "malformed_response",
      errorClass: "connection_closed_mid_frame",
    });
  });
});

// ── 8. No PHI / payload leakage across every failure path exercised above ─────────────────────────────

describe("PHI discipline", () => {
  it("never includes the wire message's identifying content in any typed error outcome", async () => {
    const transport = createNodeMllpTransport();
    const errorClasses: string[] = [];

    // connect_error
    {
      const probe = net.createServer();
      const freePort = await listen(probe);
      await close(probe);
      const outcome = await transport.send(baseInput({ port: freePort }));
      if ("errorClass" in outcome) errorClasses.push(outcome.errorClass);
    }

    // tls_error (pin mismatch)
    {
      const server = tls.createServer(
        { cert: tlsCertPem, key: tlsKeyPem, minVersion: "TLSv1.3" },
        () => {},
      );
      trackConnections(server);
      currentServer = server;
      const port = await listen(server);
      const wrongPin = createHash("sha256").update("wrong").digest("hex");
      const outcome = await transport.send(
        baseInput({ protocol: "mllp_tls", channelCertPin: wrongPin, port }),
      );
      if ("errorClass" in outcome) errorClasses.push(outcome.errorClass);
      await close(server);
      currentServer = undefined;
    }

    // malformed_response
    {
      const server = net.createServer((socket) => {
        socket.on("data", () => socket.write(Buffer.from("garbage")));
      });
      trackConnections(server);
      currentServer = server;
      const port = await listen(server);
      const outcome = await transport.send(baseInput({ port }));
      if ("errorClass" in outcome) errorClasses.push(outcome.errorClass);
      await close(server);
      currentServer = undefined;
    }

    expect(errorClasses.length).toBeGreaterThan(0);
    for (const errorClass of errorClasses) {
      expect(errorClass).not.toContain(PHI_MARKER);
      expect(errorClass.toLowerCase()).not.toContain("doe");
      expect(errorClass).not.toContain("999-88-7777");
    }
  });
});

// ── F-181 — canonical pin (PEM → DER sha256) through the REAL transport ────────────────────────────────────

describe("F-181 channelCertPin canonical convention through the real transport", () => {
  function tlsAckServer(): tls.Server {
    const server = tls.createServer(
      { key: tlsKeyPem, cert: tlsCertPem, minVersion: "TLSv1.3" },
      (socket) => {
        const buf = new MllpFrameBuffer();
        socket.on("data", (chunk) => {
          buf.append(chunk);
          for (const _ of buf.drain()) socket.write(encodeMllpFrame(ACK_WIRE));
        });
        socket.on("error", () => undefined);
      },
    );
    trackConnections(server);
    return server;
  }

  it("a pin derived from the PEM by the admin helper is the pin the transport accepts", async () => {
    const server = tlsAckServer();
    currentServer = server;
    const port = await listen(server);
    const outcome = await createNodeMllpTransport().send(
      baseInput({ protocol: "mllp_tls", channelCertPin: certPinFromPem(tlsCertPem), port }),
    );
    expect(outcome.kind).toBe("ack");
  });

  it("the same certificate re-wrapped (CRLF, 76-col, blank lines) yields the identical pin — a PEM-text hash would not", async () => {
    const der = new X509Certificate(tlsCertPem).raw.toString("base64");
    const rewrapped = `\r\n-----BEGIN CERTIFICATE-----\r\n${der.match(/.{1,76}/g)!.join("\r\n")}\r\n\r\n-----END CERTIFICATE-----\r\n`;
    expect(certPinFromPem(rewrapped)).toBe(correctPinHex);
    // and a hash of the PEM TEXT differs between the two spellings, which is why it can never be the pin:
    const textHash = (t: string) => createHash("sha256").update(t).digest("hex");
    expect(textHash(rewrapped)).not.toBe(textHash(tlsCertPem));
    const server = tlsAckServer();
    currentServer = server;
    const port = await listen(server);
    const outcome = await createNodeMllpTransport().send(
      baseInput({ protocol: "mllp_tls", channelCertPin: certPinFromPem(rewrapped), port }),
    );
    expect(outcome.kind).toBe("ack");
  });

  it("a pin of the PEM TEXT (the old schema-comment convention) is refused as a mismatch and sends zero bytes", async () => {
    let bytesReceived = 0;
    const server = tls.createServer(
      { key: tlsKeyPem, cert: tlsCertPem, minVersion: "TLSv1.3" },
      (socket) => {
        socket.on("data", (c) => {
          bytesReceived += c.length;
        });
        socket.on("error", () => undefined);
      },
    );
    trackConnections(server);
    currentServer = server;
    const port = await listen(server);
    const pemTextPin = createHash("sha256").update(tlsCertPem).digest("hex");
    const outcome = await createNodeMllpTransport().send(
      baseInput({ protocol: "mllp_tls", channelCertPin: pemTextPin, port }),
    );
    expect(outcome).toEqual({ kind: "tls_error", errorClass: "cert_pin_mismatch" });
    expect(bytesReceived).toBe(0);
  });
});

// ── F-181 — destination policy: no socket to a refused destination ─────────────────────────────────────────

describe("F-181 destination policy in the transport", () => {
  it("refuses a link-local (cloud metadata) IP literal even when loopback is allowed — and opens no socket", async () => {
    const outcome = await createNodeMllpTransport().send(
      baseInput({ host: "169.254.169.254", port: 80, allowLoopback: true }),
    );
    expect(outcome).toEqual({ kind: "destination_refused", errorClass: "destination_link_local" });
  });

  it("refuses the well-known metadata hostnames", async () => {
    const outcome = await createNodeMllpTransport().send(
      baseInput({ host: "metadata.google.internal", port: 80, allowLoopback: true }),
    );
    expect(outcome).toEqual({
      kind: "destination_refused",
      errorClass: "destination_metadata_host",
    });
  });

  it("refuses an IPv4-mapped IPv6 spelling of a link-local address", async () => {
    const outcome = await createNodeMllpTransport().send(
      baseInput({ host: "::ffff:169.254.169.254", port: 80, allowLoopback: true }),
    );
    expect(outcome.kind).toBe("destination_refused");
  });

  it("refuses loopback when allowLoopback is false (production) — the listening test double sees NO connection", async () => {
    let connections = 0;
    const server = net.createServer((socket) => {
      connections++;
      socket.destroy();
    });
    currentServer = server;
    const port = await listen(server);
    const outcome = await createNodeMllpTransport().send(baseInput({ port, allowLoopback: false }));
    expect(outcome).toEqual({ kind: "destination_refused", errorClass: "destination_loopback" });
    await new Promise((r) => setTimeout(r, 50));
    expect(connections).toBe(0);
  });

  it("refuses a hostname that RESOLVES to loopback when loopback is not allowed (localhost)", async () => {
    const outcome = await createNodeMllpTransport().send(
      baseInput({ host: "localhost", port: 1, allowLoopback: false }),
    );
    expect(outcome.kind).toBe("destination_refused");
  });

  it("still dials a private (RFC1918-style) or loopback receiver when policy allows — the refusal is targeted, not blanket", async () => {
    const server = net.createServer((socket) => {
      const buf = new MllpFrameBuffer();
      socket.on("data", (chunk) => {
        buf.append(chunk);
        for (const _ of buf.drain()) socket.write(encodeMllpFrame(ACK_WIRE));
      });
    });
    trackConnections(server);
    currentServer = server;
    const port = await listen(server);
    const outcome = await createNodeMllpTransport().send(baseInput({ port, allowLoopback: true }));
    expect(outcome.kind).toBe("ack");
  });
});
