// apps/web/src/modules/25-remittance — the access layer for milestone 9a-1: the denial-reason PLAYBOOK library and the
// per-denial panel. Every wire shape is an alias into the generated `operations` map (never a hand-copied interface). The
// server owns every rule and refusal (review before publish, source note, frozen versions); nothing here writes guidance
// or states what a MAC requires, and a tick is advisory.
import type { ApiClient, operations } from "@chartwarden/ui";
import { type WriteResult, failure, guarded, ifMatch, ok } from "./remittance-api";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Ok<Op> = Op extends { responses: { 200: infer R } } ? Json<R> : never;
type Created<Op> = Op extends { responses: { 201: infer R } } ? Json<R> : never;
type ReqBody<Op> = Op extends { requestBody?: infer RB } ? Json<RB> : never;

export type PlaybookList = Ok<operations["getApiV1Playbooks"]>;
export type PlaybookListItem = PlaybookList["items"][number];
export type PlaybookDetail = Ok<operations["getApiV1PlaybooksById"]>;
export type PlaybookVersion = PlaybookDetail["versions"][number];
export type DenialPlaybook = Ok<operations["getApiV1DenialsByIdPlaybook"]>;
export type DenialPlaybookBody = NonNullable<DenialPlaybook["playbook"]>;
export type PlaybookCreateInput = ReqBody<operations["postApiV1Playbooks"]>;
export type PlaybookContentInput = ReqBody<operations["patchApiV1PlaybookversionsById"]>;
export type PlaybookStepStatus = ReqBody<
  operations["putApiV1DenialsByIdPlaybookstepsByStepKey"]
>["status"];

export const PLAYBOOK_CODE_KIND_LABEL: Readonly<Record<string, string>> = {
  mac_reason: "MAC reason code",
  rarc: "RARC",
  carc: "CARC",
};
export const PLAYBOOK_STEP_STATUS_LABEL: Readonly<Record<string, string>> = {
  open: "Not started",
  done: "Done",
  not_applicable: "Not applicable",
};

export async function loadPlaybooks(client: ApiClient): Promise<WriteResult<PlaybookList>> {
  return guarded(async () => {
    const { data, error, response } = await client.GET("/api/v1/playbooks", {});
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function loadPlaybook(
  client: ApiClient,
  id: string,
): Promise<WriteResult<PlaybookDetail>> {
  return guarded(async () => {
    const { data, error, response } = await client.GET("/api/v1/playbooks/{id}", {
      params: { path: { id } },
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function createPlaybook(
  client: ApiClient,
  body: PlaybookCreateInput,
): Promise<WriteResult<Created<operations["postApiV1Playbooks"]>>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/playbooks", { body });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function createDraftVersion(
  client: ApiClient,
  playbookId: string,
  body: PlaybookContentInput,
): Promise<WriteResult<Created<operations["postApiV1PlaybooksByIdVersions"]>>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/playbooks/{id}/versions", {
      params: { path: { id: playbookId } },
      body,
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function saveDraft(
  client: ApiClient,
  versionId: string,
  rowVersion: number,
  body: PlaybookContentInput,
): Promise<WriteResult<Ok<operations["patchApiV1PlaybookversionsById"]>>> {
  return guarded(async () => {
    const { data, error, response } = await client.PATCH("/api/v1/playbook-versions/{id}", {
      params: { path: { id: versionId } },
      headers: ifMatch(rowVersion),
      body,
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function publishVersion(
  client: ApiClient,
  versionId: string,
  rowVersion: number,
): Promise<WriteResult<Ok<operations["postApiV1PlaybookversionsByIdPublish"]>>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/playbook-versions/{id}/publish", {
      params: { path: { id: versionId } },
      headers: ifMatch(rowVersion),
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function retireVersion(
  client: ApiClient,
  versionId: string,
  rowVersion: number,
): Promise<WriteResult<Ok<operations["postApiV1PlaybookversionsByIdRetire"]>>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/playbook-versions/{id}/retire", {
      params: { path: { id: versionId } },
      headers: ifMatch(rowVersion),
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function loadDenialPlaybook(
  client: ApiClient,
  denialId: string,
): Promise<WriteResult<DenialPlaybook>> {
  return guarded(async () => {
    const { data, error, response } = await client.GET("/api/v1/denials/{id}/playbook", {
      params: { path: { id: denialId } },
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function setPlaybookStep(
  client: ApiClient,
  denialId: string,
  stepKey: string,
  status: PlaybookStepStatus,
): Promise<WriteResult<Ok<operations["putApiV1DenialsByIdPlaybookstepsByStepKey"]>>> {
  return guarded(async () => {
    const { data, error, response } = await client.PUT(
      "/api/v1/denials/{id}/playbook-steps/{stepKey}",
      { params: { path: { id: denialId, stepKey } }, body: { status } },
    );
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}
