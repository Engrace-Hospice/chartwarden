// apps/web/src/modules/25-remittance — client calls for the QIC reconsideration (hospice ADR/TPE/QIC PRD, milestone 4):
// the QIC view, the cited-evidence list, the QIC clock, and the OMHA escalation request and confirmation. Every
// refusal is returned verbatim as a WriteResult (the server owns each rule); `stepUp` marks the 403 the escalation
// request answers with when the session needs re-verifying.
import type { ApiClient, operations } from "@chartwarden/ui";
import { type WriteResult, failure, guarded, ifMatch, ok } from "./remittance-api";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Ok<Op> = Op extends { responses: { 200: infer R } } ? Json<R> : never;
type ReqBody<Op> = Op extends { requestBody?: infer RB } ? Json<RB> : never;

export type QicView = Ok<operations["getApiV1AppealsByIdQic"]>;
export type CitedEvidenceInput = ReqBody<operations["patchApiV1AppealsByIdCitedevidence"]>;
export type QicVersioned = Ok<operations["patchApiV1AppealsByIdQicclock"]>;
export type EscalationRequestInput = ReqBody<operations["postApiV1AppealsByIdRequestescalation"]>;
export type EscalationConfirmed = Ok<operations["postApiV1AppealsByIdConfirmescalation"]>;
export type EscalationChannel = EscalationRequestInput["channel"];

/** The shortest reason that is not a placeholder when a cited item cannot be enclosed (server floor, mirrored). */
export const MIN_UNAVAILABLE_REASON = 10;
/** The most one late-evidence submission can extend the QIC clock (PRD: up to 14 days each). */
export const MAX_QIC_EXTENSION_DAYS = 14;

export async function loadQic(client: ApiClient, id: string): Promise<WriteResult<QicView>> {
  return guarded(async () => {
    const { data, error, response } = await client.GET("/api/v1/appeals/{id}/qic", {
      params: { path: { id } },
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function saveCitedEvidence(
  client: ApiClient,
  id: string,
  version: number,
  body: CitedEvidenceInput,
): Promise<WriteResult<QicVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.PATCH("/api/v1/appeals/{id}/cited-evidence", {
      params: { path: { id } },
      headers: ifMatch(version),
      body,
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function recordQicClock(
  client: ApiClient,
  id: string,
  version: number,
  body: { receivedOn: string } | { extensionDays: number },
): Promise<WriteResult<QicVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.PATCH("/api/v1/appeals/{id}/qic-clock", {
      params: { path: { id } },
      headers: ifMatch(version),
      body,
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function requestEscalation(
  client: ApiClient,
  id: string,
  version: number,
  body: EscalationRequestInput,
): Promise<WriteResult<QicVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/appeals/{id}/request-escalation", {
      params: { path: { id } },
      headers: ifMatch(version),
      body,
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function confirmEscalation(
  client: ApiClient,
  id: string,
  version: number,
  forwardedOn: string,
): Promise<WriteResult<EscalationConfirmed>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/appeals/{id}/confirm-escalation", {
      params: { path: { id } },
      headers: ifMatch(version),
      body: { forwardedOn },
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}
