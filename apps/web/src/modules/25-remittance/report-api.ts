// apps/web/src/modules/25-remittance — the access layer for milestone 9a-2: the leadership medical-review report. The wire
// shape is an alias into the generated `operations` map. Figures only: the server computes every number and every period
// change; nothing here derives a rate, a threshold or a verdict.
import type { ApiClient, operations } from "@chartwarden/ui";
import { type WriteResult, failure, guarded, ok } from "./remittance-api";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Ok<Op> = Op extends { responses: { 200: infer R } } ? Json<R> : never;

export type MedicalReviewReport = Ok<operations["getApiV1MedicalreviewReport"]>;
export type ReportFigure = MedicalReviewReport["adrs"]["received"];

export async function loadMedicalReviewReport(
  client: ApiClient,
  query: { from: string; to: string },
): Promise<WriteResult<MedicalReviewReport>> {
  return guarded(async () => {
    const { data, error, response } = await client.GET("/api/v1/medical-review/report", {
      params: { query },
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}
