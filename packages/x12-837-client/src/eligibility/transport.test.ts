import { describe, expect, it } from "vitest";
import { build270 } from "./build-270";
import { parse271 } from "./parse-271";
import { createSandboxHetsTransport } from "./sandbox-transport";
import {
  type HetsFetch,
  HetsTransportError,
  buildCoreMimeForm,
  coreSenderId,
  createCoreMimeHetsTransport,
} from "./transport";

const MBI = "1EG4TE5MK73";
const request270 = (lastName = "DOE") =>
  build270({
    submitterId: "A123456",
    provider: { npi: "1234567893", organizationName: "Engrace Hospice" },
    subscriber: { mbi: MBI, lastName, firstName: "JANE", dateOfBirth: "1940-04-01" },
    serviceDates: { from: "2026-10-06", to: "2026-10-06" },
    controlNumber: 1,
    traceNumber: "trace-1",
    usage: "T",
    now: new Date("2026-10-06T00:00:00Z"),
  });

const sample271 = async (): Promise<string> =>
  (await createSandboxHetsTransport().exchange({ x12: request270(), payloadId: "p" })).x12;

const config = {
  endpointUrl: "https://hets.example.test/core",
  submitterId: "A123456",
  bearerToken: "token-123",
  timeoutMs: 5000,
};

describe("CORE MIME transport", () => {
  it("pads the CORE SenderID to 10 characters with zeros (CG Table 4)", () => {
    expect(coreSenderId("a123456")).toBe("A123456000");
  });

  it("builds the CORE envelope fields with the X12 as an inline Payload part", () => {
    const form = buildCoreMimeForm(
      { x12: "ISA*...", payloadId: "trace-1" },
      "A123456",
      new Date("2026-10-06T07:34:11.123Z"),
    );
    expect(Object.fromEntries(form.entries())).toEqual({
      PayloadType: "X12_270_Request_005010X279A1",
      ProcessingMode: "RealTime",
      PayloadID: "trace-1",
      TimeStamp: "2026-10-06T07:34:11Z",
      SenderID: "A123456000",
      ReceiverID: "CMS",
      CORERuleVersion: "2.2.0",
      Payload: "ISA*...",
    });
  });

  it("POSTs the form with the bearer token and returns the Payload part of the multipart reply", async () => {
    const x12 = await sample271();
    let seen: { url: string; init: RequestInit & { tls?: unknown } } | undefined;
    const fetchImpl: HetsFetch = async (url, init) => {
      seen = { url, init };
      const reply = new FormData();
      reply.set("PayloadType", "X12_271_Response_005010X279A1");
      reply.set("ErrorCode", "Success");
      reply.set("Payload", x12);
      return new Response(reply);
    };
    const transport = createCoreMimeHetsTransport(config, fetchImpl);
    const res = await transport.exchange({ x12: request270(), payloadId: "trace-1" });
    expect(parse271(res.x12, { asOfServiceDate: "2026-10-06" }).outcome).toBe("active_part_a");
    expect(seen?.url).toBe(config.endpointUrl);
    expect(seen?.init.method).toBe("POST");
    expect(seen?.init.headers).toEqual({ authorization: "Bearer token-123" });
    expect(seen?.init.tls).toBeUndefined();
  });

  it("passes the client certificate for direct CMS mutual TLS", async () => {
    let tls: unknown;
    const transport = createCoreMimeHetsTransport(
      { ...config, bearerToken: undefined, clientCertificate: { certPem: "CERT", keyPem: "KEY" } },
      async (_url, init) => {
        tls = init.tls;
        return new Response(await sample271(), { headers: { "content-type": "text/plain" } });
      },
    );
    await transport.exchange({ x12: request270(), payloadId: "p" });
    expect(tls).toEqual({ cert: "CERT", key: "KEY" });
  });

  it.each([
    ["HETS_HTTP_ERROR", async () => new Response(`secret body with ${MBI}`, { status: 500 })],
    [
      "HETS_CORE_ERROR",
      async () => {
        const f = new FormData();
        f.set("ErrorCode", "PayloadTypeIncorrect");
        return new Response(f);
      },
    ],
    ["HETS_INVALID_RESPONSE", async () => new Response("<html>", { status: 200 })],
    [
      "HETS_INVALID_RESPONSE",
      async () =>
        new Response("ISA", {
          status: 200,
          headers: { "content-type": "text/plain", "content-length": String(64 * 1024 * 1024) },
        }),
    ],
    [
      "HETS_INVALID_RESPONSE",
      async () =>
        new Response(`ISA${"*".repeat(9 * 1024 * 1024)}`, {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    ],
    [
      "HETS_NETWORK_ERROR",
      async () => {
        throw new TypeError("fetch failed");
      },
    ],
  ] as const)("maps a failure to %s with a content-free message", async (code, impl) => {
    const transport = createCoreMimeHetsTransport(config, impl as HetsFetch);
    const err = await transport.exchange({ x12: request270(), payloadId: "p" }).catch((e) => e);
    expect(err).toBeInstanceOf(HetsTransportError);
    expect(err.code).toBe(code);
    expect(err.message).not.toContain(MBI);
    expect(err.message).not.toContain("token-123");
  });

  it("refuses a non-https endpoint", () => {
    expect(() =>
      createCoreMimeHetsTransport({ ...config, endpointUrl: "http://x.test" }),
    ).toThrow();
  });
});

describe("sandbox transport", () => {
  it("echoes the trace number and selects the scenario by last-name keyword", async () => {
    const t = createSandboxHetsTransport();
    const open = await t.exchange({ x12: request270("OPENELECTION"), payloadId: "p" });
    const parsed = parse271(open.x12, { asOfServiceDate: "2026-10-06" });
    expect(parsed.traceNumber).toBe("trace-1");
    expect(
      parsed.hospiceRecords.some((r) => r.kind === "election" && r.revocationCode === "0"),
    ).toBe(true);
    const notFound = await t.exchange({ x12: request270("NOTFOUND"), payloadId: "p" });
    expect(parse271(notFound.x12, { asOfServiceDate: "2026-10-06" }).outcome).toBe("mbi_invalid");
  });

  it("answers with an injected hospice history when one is configured (dev / test fixtures)", async () => {
    const t = createSandboxHetsTransport({
      hospiceHistory: [
        {
          kind: "billed",
          start: "20260801",
          end: "20260830",
          days: 30,
          revocation: "1",
          npi: "1649726464",
        },
      ],
    });
    const { x12 } = await t.exchange({ x12: request270(), payloadId: "p" });
    expect(parse271(x12, { asOfServiceDate: "2026-10-06" }).hospiceRecords).toEqual([
      expect.objectContaining({
        kind: "benefit_period",
        startDate: "2026-08-01",
        endDate: "2026-08-30",
        daysUsed: 30,
        hospiceNpi: "1649726464",
      }),
    ]);
  });

  it("marks every synthetic answer as a test interchange (ISA15 = T)", async () => {
    const x12 = await sample271();
    expect(x12.split("*")[15]).toBe("T");
  });

  it("refuses a payload that is not a HETS 270", async () => {
    await expect(
      createSandboxHetsTransport().exchange({ x12: await sample271(), payloadId: "p" }),
    ).rejects.toThrow();
  });
});
