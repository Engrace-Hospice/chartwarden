// apps/web/src/modules/08-encounters/findings — the shared harness of the findings DOM tests: one stub `fetch` behind a real typed API client,
// recording every request (method, path, parsed JSON body) so a test can assert the exact PUT body, not just that a PUT happened.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { render } from "@testing-library/react";
import type { JSX } from "react";

export const ENCOUNTER_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
export const PATIENT_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
export const ADL_PATH = `/api/v1/encounters/${ENCOUNTER_ID}/adl`;
export const NUTRITION_PATH = `/api/v1/encounters/${ENCOUNTER_ID}/nutrition`;
export const WEIGHT_HISTORY_PATH = `/api/v1/encounters/${ENCOUNTER_ID}/weight-history`;

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  /** The `If-Match` header the request carried, or null when it carried none. */
  readonly ifMatch: string | null;
}

export interface Reply {
  readonly status?: number;
  readonly json: unknown;
}

/** What the stub answers for one request; "drop" is a connection that fails before any answer. */
export type Handler = (request: RecordedRequest) => Reply | "drop";

/** The standard error envelope the server sends. */
export const errorReply = (
  status: number,
  code: string,
  message: string,
  details?: readonly unknown[],
): Reply => ({ status, json: { error: { code, message, ...(details ? { details } : {}) } } });

async function recorded(input: RequestInfo | URL, init?: RequestInit): Promise<RecordedRequest> {
  const request = typeof input === "object" && "url" in input ? input : null;
  const url = new URL(request ? request.url : String(input));
  const method = (request?.method ?? init?.method ?? "GET").toUpperCase();
  const raw = request
    ? await request.clone().text()
    : typeof init?.body === "string"
      ? init.body
      : "";
  const headers = request ? request.headers : new Headers(init?.headers);
  return {
    method,
    path: url.pathname,
    body: raw === "" ? undefined : JSON.parse(raw),
    ifMatch: headers.get("if-match"),
  };
}

export function mountWithApi(ui: JSX.Element, handler: Handler) {
  const requests: RecordedRequest[] = [];
  const stubFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = await recorded(input, init);
    requests.push(request);
    const reply = handler(request);
    if (reply === "drop") throw new TypeError("connection dropped");
    return new Response(JSON.stringify(reply.json), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createApiClient({ baseUrl: "http://localhost", fetch: stubFetch });
  const view = render(<ApiClientProvider client={client}>{ui}</ApiClientProvider>);
  return { ...view, requests, writes: () => requests.filter((r) => r.method !== "GET") };
}
