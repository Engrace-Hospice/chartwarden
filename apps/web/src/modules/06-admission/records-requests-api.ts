// apps/web/src/modules/06-admission/records-requests-api.ts — F-238: a referral's outbound records requests
// (older PCP / hospital records for a prospect). Wire shapes are DERIVED from the generated `operations`, so
// a contract change is a compile error here. Writes return a discriminated result: the panel renders the
// server's refusal in place.
import type { ApiClient, operations } from "@chartwarden/ui";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Ok<Op, S extends number = 200> = Op extends { responses: { [K in S]: infer R } }
  ? Json<R>
  : never;
type ReqBody<Op> = Op extends { requestBody?: infer RB } ? Json<RB> : never;

export type RecordsRequest = Ok<
  operations["getApiV1ReferralsByIdRecordsrequests"]
>["items"][number];
export type RecordsRequestStatus = RecordsRequest["status"];
export type RecordsRequestKind = RecordsRequest["recordsRequested"][number];
export type CreateRecordsRequestBody = ReqBody<operations["postApiV1ReferralsByIdRecordsrequests"]>;

export type RecordsRequestResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number | null; readonly message: string };

export const RECORDS_REQUEST_KIND_LABEL: Readonly<Record<RecordsRequestKind, string>> = {
  history_and_physical: "H&P",
  discharge_summary: "Discharge summary",
  progress_notes: "Progress notes",
  consult_notes: "Consult notes",
  labs: "Labs",
  imaging: "Imaging",
  medication_list: "Medication list",
  problem_list: "Problem list",
};

export const RECORDS_REQUEST_STATUS_LABEL: Readonly<Record<RecordsRequestStatus, string>> = {
  requested: "Requested",
  received: "Received",
  partially_received: "Partially received",
  cancelled: "Cancelled",
  expired: "Expired",
};

/** Same-origin URL of the printable cover sheet (cookie session, like every API call). */
export const coverSheetUrl = (referralId: string, requestId: string): string =>
  `/api/v1/referrals/${encodeURIComponent(referralId)}/records-requests/${encodeURIComponent(requestId)}/cover-sheet`;

function failure<T>(status: number | undefined, body: unknown): RecordsRequestResult<T> {
  const inner =
    body && typeof body === "object" && "error" in body
      ? (body as { error?: unknown }).error
      : null;
  const message =
    inner &&
    typeof inner === "object" &&
    typeof (inner as { message?: unknown }).message === "string"
      ? (inner as { message: string }).message
      : null;
  const s = typeof status === "number" ? status : null;
  return {
    ok: false,
    status: s,
    message:
      s === 403
        ? "You are not permitted to request records."
        : s === 404
          ? "This referral is no longer available to you."
          : (message ?? "The request could not be completed."),
  };
}

export async function listRecordsRequests(
  client: ApiClient,
  referralId: string,
): Promise<RecordsRequestResult<RecordsRequest[]>> {
  const { data, error, response } = await client.GET("/api/v1/referrals/{id}/records-requests", {
    params: { path: { id: referralId } },
  });
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data.items };
}

export async function createRecordsRequest(
  client: ApiClient,
  referralId: string,
  body: CreateRecordsRequestBody,
): Promise<RecordsRequestResult<RecordsRequest>> {
  const { data, error, response } = await client.POST("/api/v1/referrals/{id}/records-requests", {
    params: { path: { id: referralId } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as RecordsRequest };
}

export async function cancelRecordsRequest(
  client: ApiClient,
  referralId: string,
  requestId: string,
): Promise<RecordsRequestResult<RecordsRequest>> {
  const { data, error, response } = await client.POST(
    "/api/v1/referrals/{id}/records-requests/{requestId}/cancel",
    { params: { path: { id: referralId, requestId } }, body: {} },
  );
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as RecordsRequest };
}

export type ExtendRecordsRequestBody = ReqBody<
  operations["postApiV1ReferralsByIdRecordsrequestsByRequestIdExtend"]
>;

/** Push the expiry out — an expired request re-opens with the same code and cover sheet. */
export async function extendRecordsRequest(
  client: ApiClient,
  referralId: string,
  requestId: string,
  body: ExtendRecordsRequestBody,
): Promise<RecordsRequestResult<RecordsRequest>> {
  const { data, error, response } = await client.POST(
    "/api/v1/referrals/{id}/records-requests/{requestId}/extend",
    { params: { path: { id: referralId, requestId } }, body },
  );
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as RecordsRequest };
}

/** The latest fax send of a request, as the list carries it (null = never faxed). */
export type RecordsRequestFax = NonNullable<RecordsRequest["fax"]>;
export type SendRecordsRequestFaxResult = Ok<
  operations["postApiV1ReferralsByIdRecordsrequestsByRequestIdSendfax"]
>;

/** E.164 → how staff read it: NANP as (503) 555-0100, anything else unchanged. */
export const displayFaxNumber = (e164: string): string =>
  /^\+1\d{10}$/.test(e164) ? `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}` : e164;

/** Fax the cover sheet + letter (idempotent per request: a repeat to the same number replays). */
export async function sendRecordsRequestFax(
  client: ApiClient,
  referralId: string,
  requestId: string,
  faxNumber: string,
): Promise<RecordsRequestResult<SendRecordsRequestFaxResult>> {
  const { data, error, response } = await client.POST(
    "/api/v1/referrals/{id}/records-requests/{requestId}/send-fax",
    { params: { path: { id: referralId, requestId } }, body: { faxNumber } },
  );
  if (error || !data) {
    const res = failure<SendRecordsRequestFaxResult>(response?.status, error);
    return !res.ok && res.status === 503
      ? {
          ...res,
          message:
            "Faxing is not set up for this organization. Print the cover sheet and fax it instead.",
        }
      : res;
  }
  return { ok: true, value: data };
}
