// apps/web/src/modules/25-remittance — the access layer for milestone 12a-1: payer (commercial / Medicare Advantage)
// appeals and the organization's payer appeal paths. Every wire shape is an alias into the generated `operations` map.
// The server owns every rule and refusal; no deadline, level or window is computed or defaulted on this side.
import type { ApiClient, operations } from "@chartwarden/ui";
import { type WriteResult, failure, guarded, ifMatch, ok } from "./remittance-api";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Ok<Op> = Op extends { responses: { 200: infer R } } ? Json<R> : never;
type Ok201<Op> = Op extends { responses: { 201: infer R } } ? Json<R> : never;
type ReqBody<Op> = Op extends { requestBody?: infer RB } ? Json<RB> : never;

export type DenialCaseView = Ok<operations["getApiV1DenialsByDenialCaseIdCaseview"]>;
export type PayerAppealDenialView = Ok<operations["getApiV1DenialsByDenialCaseIdPayerappeals"]>;
export type PayerAppealCase = PayerAppealDenialView["cases"][number];
export type PayerAppealOpenInput = ReqBody<
  operations["postApiV1DenialsByDenialCaseIdPayerappeals"]
>;
export type PayerAppealOpened = Ok201<operations["postApiV1DenialsByDenialCaseIdPayerappeals"]>;
export type PayerAppealNoticed = Ok<operations["putApiV1PayerappealsByIdNotice"]>;
export type PayerAppealMoveInput = ReqBody<operations["postApiV1PayerappealsByIdState"]>;
export type PayerAppealVersioned = Ok<operations["postApiV1PayerappealsByIdState"]>;
export type PayerPathsPage = Ok<operations["getApiV1Payerappealpaths"]>;
export type PayerPath = PayerPathsPage["items"][number];
export type PayerPathInput = ReqBody<operations["postApiV1Payerappealpaths"]>;
export type PayerPathLevelInput = PayerPathInput["levels"][number];
export type PayerPathVersioned = Ok<operations["postApiV1PayerappealpathsByIdVerify"]>;

export const LEVEL_KINDS = ["internal", "external_review", "other"] as const;
export const WHO_FILES = ["provider", "member", "either", "unknown"] as const;
export const ANCHOR_KINDS = [
  "notice_date",
  "notice_receipt",
  "remittance_date",
  "prior_decision_date",
  "other_typed",
] as const;
export const DAY_BASES = ["calendar", "business_us_federal"] as const;
export const ROLLS = ["none", "back", "forward"] as const;
export const PAYER_PROGRAMS = ["commercial", "medicare_advantage"] as const;

export async function loadDenialCaseView(
  client: ApiClient,
  denialCaseId: string,
): Promise<WriteResult<DenialCaseView>> {
  return guarded(async () => {
    const { data, error, response } = await client.GET("/api/v1/denials/{denialCaseId}/case-view", {
      params: { path: { denialCaseId } },
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function loadPayerAppeals(
  client: ApiClient,
  denialCaseId: string,
): Promise<WriteResult<PayerAppealDenialView>> {
  return guarded(async () => {
    const { data, error, response } = await client.GET(
      "/api/v1/denials/{denialCaseId}/payer-appeals",
      { params: { path: { denialCaseId } } },
    );
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function openPayerAppeal(
  client: ApiClient,
  denialCaseId: string,
  body: PayerAppealOpenInput,
): Promise<WriteResult<PayerAppealOpened>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST(
      "/api/v1/denials/{denialCaseId}/payer-appeals",
      { params: { path: { denialCaseId } }, body },
    );
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function recordPayerNotice(
  client: ApiClient,
  c: Pick<PayerAppealCase, "id" | "version">,
  noticeDate: string,
): Promise<WriteResult<PayerAppealNoticed>> {
  return guarded(async () => {
    const { data, error, response } = await client.PUT("/api/v1/payer-appeals/{id}/notice", {
      params: { path: { id: c.id } },
      headers: ifMatch(c.version),
      body: { noticeDate },
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function movePayerAppeal(
  client: ApiClient,
  c: Pick<PayerAppealCase, "id" | "version">,
  body: PayerAppealMoveInput,
): Promise<WriteResult<PayerAppealVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/payer-appeals/{id}/state", {
      params: { path: { id: c.id } },
      headers: ifMatch(c.version),
      body,
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function loadPayerPaths(client: ApiClient): Promise<WriteResult<PayerPathsPage>> {
  return guarded(async () => {
    const { data, error, response } = await client.GET("/api/v1/payer-appeal-paths", {});
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function createPayerPath(
  client: ApiClient,
  body: PayerPathInput,
): Promise<WriteResult<PayerPathVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/payer-appeal-paths", { body });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function verifyPayerPath(
  client: ApiClient,
  p: Pick<PayerPath, "id" | "version">,
): Promise<WriteResult<PayerPathVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/payer-appeal-paths/{id}/verify", {
      params: { path: { id: p.id } },
      headers: ifMatch(p.version),
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function retirePayerPath(
  client: ApiClient,
  p: Pick<PayerPath, "id" | "version">,
): Promise<WriteResult<PayerPathVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/payer-appeal-paths/{id}/retire", {
      params: { path: { id: p.id } },
      headers: ifMatch(p.version),
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}
