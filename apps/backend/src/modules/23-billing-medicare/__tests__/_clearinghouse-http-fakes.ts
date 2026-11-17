import { vi } from "vitest";

export type ClaimMdUploadMode =
  | "up"
  | "lost_after_upload"
  | "network_before_response"
  | "immediate_reject"
  | "credential_reject"
  | "http_401"
  | "http_429"
  | "malformed_success";

export type ClaimMdUploadListMode = "found" | "absent" | "inconclusive" | "failure";

export function createStrictClaimMdFake(input: {
  readonly accountKey: string;
  readonly billingNpi: string;
}) {
  const uploads: string[] = [];
  const filenames: string[] = [];
  const responses: Record<string, unknown>[] = [];
  let mode: ClaimMdUploadMode = "up";
  let uploadListMode: ClaimMdUploadListMode = "found";
  let lastResponseId = 0;
  let uploadCalls = 0;
  let uploadListCalls = 0;
  let responseCalls = 0;
  let interceptedCalls = 0;
  const fetch = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
    interceptedCalls += 1;
    const url = String(request);
    if (!url.startsWith("https://svc.claim.md/services/")) {
      throw new Error(`unexpected outbound URL: ${url}`);
    }
    const operation = url.replace("https://svc.claim.md/services/", "").replace(/\/$/, "");
    const body = init?.body as URLSearchParams | FormData;
    if (String(body.get("AccountKey")) !== input.accountKey) {
      return Response.json({ error: { error_code: "21", error_mesg: "synthetic" } });
    }
    if (operation === "upload") {
      uploadCalls += 1;
      const x12 = await (body.get("File") as Blob).text();
      const filename = String(body.get("Filename"));
      if (mode !== "network_before_response") {
        uploads.push(x12);
        filenames.push(filename);
      }
      const controlNumber = /CLM\*([^*]+)\*/.exec(x12)?.[1] ?? "";
      if (mode === "lost_after_upload" || mode === "network_before_response") {
        throw new TypeError("synthetic socket loss");
      }
      if (mode === "http_401") return new Response(null, { status: 401 });
      if (mode === "http_429") return new Response(null, { status: 429 });
      if (mode === "credential_reject") {
        return Response.json({ error: { error_code: "21", error_mesg: "synthetic" } });
      }
      if (mode === "immediate_reject") {
        return Response.json({ error: { error_code: "42", error_mesg: "synthetic" } });
      }
      if (mode === "malformed_success") return new Response("{", { status: 200 });
      return Response.json({
        claim: [
          {
            pcn: controlNumber,
            bill_npi: input.billingNpi,
            status: "A",
            senderid: "CLMMD",
            fileid: "F1",
          },
        ],
      });
    }
    if (operation === "uploadlist") {
      uploadListCalls += 1;
      if (uploadListMode === "failure") return new Response(null, { status: 503 });
      if (uploadListMode === "inconclusive") return Response.json({ status: "unknown" });
      if (uploadListMode === "absent") return Response.json({ file: [] });
      return Response.json({
        file: filenames.map((filename) => ({ filename, inboundid: "IN1" })),
      });
    }
    if (operation === "response") {
      responseCalls += 1;
      const after = Number(body.get("ResponseID") ?? 0);
      const rows = responses.filter((row) => Number(row.rid) > after);
      return rows.length === 0
        ? Response.json({})
        : Response.json({ last_responseid: String(lastResponseId), claim: rows });
    }
    throw new Error(`unexpected Claim.MD operation: ${operation}`);
  }) as typeof globalThis.fetch;

  return {
    fetch,
    uploads,
    uploadCalls: () => uploadCalls,
    uploadListCalls: () => uploadListCalls,
    responseCalls: () => responseCalls,
    interceptedCalls: () => interceptedCalls,
    setMode(next: ClaimMdUploadMode) {
      mode = next;
    },
    setUploadListMode(next: ClaimMdUploadListMode) {
      uploadListMode = next;
    },
    respond(controlNumber: string, status: "A" | "R", senderid: string) {
      lastResponseId += 1;
      responses.push({
        rid: String(lastResponseId),
        pcn: controlNumber,
        claimid: "SYNTHETIC-CLAIMMD-ID",
        bill_npi: input.billingNpi,
        status,
        senderid,
        sender_icn: senderid === "CLMMD" ? "" : "SYNTHETIC-PAYER-CONTROL",
        response_time: "2026-11-17 10:00:00am",
        messages: [
          {
            responseid: String(lastResponseId),
            status,
            mesgid: status === "R" ? "A7:21" : "ACK",
            message: "synthetic response text must not persist",
          },
        ],
      });
    },
  };
}

export function createStrictStediFake(input: { readonly apiKey: string }) {
  const requests: { readonly url: string; readonly body: unknown }[] = [];
  const fetch = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
    const url = String(request);
    if (
      url !==
      "https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/institutionalclaims/v1/submission"
    ) {
      throw new Error(`unexpected Stedi outbound URL: ${url}`);
    }
    const headers = new Headers(init?.headers);
    if (headers.get("Authorization") !== input.apiKey) {
      return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
    }
    const body = JSON.parse(String(init?.body)) as unknown;
    requests.push({ url, body });
    return Response.json({ meta: { traceId: "synthetic-stedi-trace" } });
  }) as typeof globalThis.fetch;
  return { fetch, requests, requestCalls: () => requests.length };
}
