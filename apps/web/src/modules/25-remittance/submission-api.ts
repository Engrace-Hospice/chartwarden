// apps/web/src/modules/25-remittance — client calls for the submission attempt (hospice ADR/TPE/QIC PRD, milestone 6a):
// the attempts of an ADR response, an appeal (incl. a QIC escalation request) or a reopening request, recording the
// receipt of a filing made outside WardenX, (cancel exists on the server as 6b scaffolding and is not called from the UI). Every refusal is returned
// verbatim as a WriteResult (the server owns each rule); `stepUp` marks the 403 the receipt answers with when the
// session needs re-verifying. Nothing here sends anything outside WardenX.
import type { ApiClient, operations } from "@wardenx/ui";
import { type WriteResult, failure, guarded, ifMatch, ok } from "./remittance-api";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Ok<Op> = Op extends { responses: { 200: infer R } } ? Json<R> : never;
type ReqBody<Op> = Op extends { requestBody?: infer RB } ? Json<RB> : never;

export type SubmissionView = Ok<operations["getApiV1AppealsByIdSubmission"]>;
export type SubmissionAttempt = SubmissionView["attempts"][number];
export type ReceiptInput = ReqBody<operations["postApiV1AppealsByIdSubmissionreceipt"]>;
export type ReceiptResult = Ok<operations["postApiV1AppealsByIdSubmissionreceipt"]>;

export type SubmissionSubject = "adr" | "appeal" | "reopening";

export async function loadSubmission(
  client: ApiClient,
  kind: SubmissionSubject,
  id: string,
): Promise<WriteResult<SubmissionView>> {
  return guarded(async () => {
    const params = { params: { path: { id } } };
    const { data, error, response } =
      kind === "adr"
        ? await client.GET("/api/v1/adrs/{id}/submission", params)
        : kind === "appeal"
          ? await client.GET("/api/v1/appeals/{id}/submission", params)
          : await client.GET("/api/v1/reopenings/{id}/submission", params);
    return error || !data ? failure(response?.status, error) : ok(data as SubmissionView);
  });
}

export async function recordReceipt(
  client: ApiClient,
  kind: SubmissionSubject,
  id: string,
  version: number,
  body: ReceiptInput,
): Promise<WriteResult<ReceiptResult>> {
  return guarded(async () => {
    const req = { params: { path: { id } }, headers: ifMatch(version), body };
    const { data, error, response } =
      kind === "adr"
        ? await client.POST("/api/v1/adrs/{id}/submission-receipt", req)
        : kind === "appeal"
          ? await client.POST("/api/v1/appeals/{id}/submission-receipt", req)
          : await client.POST("/api/v1/reopenings/{id}/submission-receipt", req);
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}
