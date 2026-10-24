// apps/web/src/modules/25-remittance — the access layer for milestone 8a-1: ADVISORY ADR documentation readiness. Every
// wire shape is an alias into the generated `operations` map (never a hand-copied interface). The server owns every rule
// and refusal; nothing here computes a gap or judges a document, and nothing here touches the packet, checklist,
// sign-off or filing.
import type { ApiClient, operations } from "@chartwarden/ui";
import { type WriteResult, failure, guarded, ok } from "./remittance-api";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Ok<Op> = Op extends { responses: { 200: infer R } } ? Json<R> : never;
type Created<Op> = Op extends { responses: { 201: infer R } } ? Json<R> : never;
type ReqBody<Op> = Op extends { requestBody?: infer RB } ? Json<RB> : never;

export type AdrReadinessView = Ok<operations["getApiV1AdrsByIdReadiness"]>;
export type ReadinessReview = NonNullable<AdrReadinessView["review"]>;
export type ReadinessFinding = ReadinessReview["findings"][number];
export type ReadinessKeyGap = AdrReadinessView["gaps"]["keys"][number];
export type ReadinessRequestResult = Created<operations["postApiV1AdrsByIdReadinessReviews"]>;
export type ReadinessDisposition = ReqBody<
  operations["postApiV1AdrsByIdReadinessFindingsByFindingIdDisposition"]
>["disposition"];

export const READINESS_DISPOSITIONS: readonly { value: ReadinessDisposition; label: string }[] = [
  { value: "acknowledged", label: "Acknowledge" },
  { value: "dismissed", label: "Dismiss" },
  { value: "disputed", label: "Report as wrong" },
];

export async function loadReadiness(
  client: ApiClient,
  adrId: string,
): Promise<WriteResult<AdrReadinessView>> {
  return guarded(async () => {
    const { data, error, response } = await client.GET("/api/v1/adrs/{id}/readiness", {
      params: { path: { id: adrId } },
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function requestReadinessReview(
  client: ApiClient,
  adrId: string,
): Promise<WriteResult<ReadinessRequestResult>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/adrs/{id}/readiness/reviews", {
      params: { path: { id: adrId } },
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function disposeReadinessFinding(
  client: ApiClient,
  adrId: string,
  findingId: string,
  disposition: ReadinessDisposition,
): Promise<WriteResult<{ id: string; disposition: string }>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST(
      "/api/v1/adrs/{id}/readiness/findings/{findingId}/disposition",
      { params: { path: { id: adrId, findingId } }, body: { disposition } },
    );
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}
