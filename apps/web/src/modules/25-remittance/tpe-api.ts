// apps/web/src/modules/25-remittance — the TPE program tracker access layer (hospice ADR/TPE/QIC PRD, milestone 5).
// Every wire shape is an alias into the generated `operations` map (never a hand-copied interface). The server owns
// every rule and refusal (ADR-0030): this layer only sends the facts typed from the MAC's letters, attaches If-Match
// where the server requires it, and returns the server's own message on a refusal.
import type { ApiClient, operations } from "@wardenx/ui";
import { type WriteResult, failure, guarded, ifMatch, ok } from "./remittance-api";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Ok<Op> = Op extends { responses: { 200: infer R } } ? Json<R> : never;
type Created<Op> = Op extends { responses: { 201: infer R } } ? Json<R> : never;
type ReqBody<Op> = Op extends { requestBody?: infer RB } ? Json<RB> : never;

export type TpeProgramSummary = Ok<operations["getApiV1Tpeprograms"]>["items"][number];
export type TpeProgramDetail = Ok<operations["getApiV1TpeprogramsById"]>;
export type TpeRound = TpeProgramDetail["rounds"][number];
export type TpeRulesPage = Ok<operations["getApiV1Tperules"]>;
export type TpeVersioned = Ok<operations["putApiV1TperoundsByIdResults"]>;
export type TpeRoundCreated = Created<operations["postApiV1TpeprogramsByIdRounds"]>;
export type TpeResultsInput = ReqBody<operations["putApiV1TperoundsByIdResults"]>;
export type TpeOutcomeInput = ReqBody<operations["postApiV1TpeprogramsByIdOutcome"]>;
export type TpeRuleInput = ReqBody<operations["putApiV1Tperules"]>;
export type TpeClaimInput = ReqBody<operations["putApiV1TperoundsByIdClaimsByClaimId"]>;

export const TPE_REFERRAL_KINDS = ["prepay_review", "extrapolation", "rac", "other"] as const;
export const TPE_CLAIM_RESULTS = ["pending", "no_error", "error"] as const;

export async function loadTpePrograms(
  client: ApiClient,
): Promise<WriteResult<readonly TpeProgramSummary[]>> {
  return guarded(async () => {
    const { data, error, response } = await client.GET("/api/v1/tpe-programs", {});
    return error || !data ? failure(response?.status, error) : ok(data.items);
  });
}

export async function loadTpeProgram(
  client: ApiClient,
  id: string,
): Promise<WriteResult<TpeProgramDetail>> {
  return guarded(async () => {
    const { data, error, response } = await client.GET("/api/v1/tpe-programs/{id}", {
      params: { path: { id } },
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function createTpeProgram(
  client: ApiClient,
  body: { providerEntityId: string; macName: string; openedOn: string },
): Promise<WriteResult<TpeVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/tpe-programs", { body });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function createTpeRound(
  client: ApiClient,
  programId: string,
  version: number,
  noticeOn: string,
): Promise<WriteResult<TpeRoundCreated>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/tpe-programs/{id}/rounds", {
      params: { path: { id: programId } },
      headers: ifMatch(version),
      body: { noticeOn },
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function saveTpeResults(
  client: ApiClient,
  roundId: string,
  version: number,
  body: TpeResultsInput,
): Promise<WriteResult<TpeVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.PUT("/api/v1/tpe-rounds/{id}/results", {
      params: { path: { id: roundId } },
      headers: ifMatch(version),
      body,
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function saveTpeEducation(
  client: ApiClient,
  roundId: string,
  version: number,
  body: { educationOn: string | null; note?: string | null },
): Promise<WriteResult<TpeVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.PUT("/api/v1/tpe-rounds/{id}/education", {
      params: { path: { id: roundId } },
      headers: ifMatch(version),
      body,
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function saveTpeClaim(
  client: ApiClient,
  roundId: string,
  version: number,
  claimId: string,
  body: TpeClaimInput,
): Promise<WriteResult<TpeVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.PUT("/api/v1/tpe-rounds/{id}/claims/{claimId}", {
      params: { path: { id: roundId, claimId } },
      headers: ifMatch(version),
      body,
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function recordTpeOutcome(
  client: ApiClient,
  programId: string,
  version: number,
  body: TpeOutcomeInput,
): Promise<WriteResult<TpeVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/tpe-programs/{id}/outcome", {
      params: { path: { id: programId } },
      headers: ifMatch(version),
      body,
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function closeTpeProgram(
  client: ApiClient,
  programId: string,
  version: number,
): Promise<WriteResult<TpeVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/tpe-programs/{id}/close", {
      params: { path: { id: programId } },
      headers: ifMatch(version),
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function loadTpeRules(client: ApiClient): Promise<WriteResult<TpeRulesPage>> {
  return guarded(async () => {
    const { data, error, response } = await client.GET("/api/v1/tpe-rules", {});
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function saveTpeRule(
  client: ApiClient,
  body: TpeRuleInput,
): Promise<WriteResult<TpeVersioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.PUT("/api/v1/tpe-rules", { body });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}
