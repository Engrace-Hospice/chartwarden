import type { ApiClient, operations } from "@wardenx/ui";

type Json<T> = T extends { content: { "application/json": infer Body } } ? Body : never;
type Ok<Operation> = Operation extends { responses: { 200: infer Response } }
  ? Json<Response>
  : never;
type Request<Operation> = Operation extends { requestBody: infer Body } ? Json<Body> : never;

export type MemberView = Ok<operations["getApiV1OrgsByIdMembers"]>["members"][number];
export type RoleOption = Ok<operations["getApiV1Roles"]>["roles"][number];
export type LocationOption = Ok<operations["getApiV1Locations"]>["items"][number];
export type ProvisionUserInput = Request<operations["postApiV1OrgsByOrgIdUsers"]>;
export type ProvisionedUser = Ok<operations["postApiV1OrgsByOrgIdUsers"]>;
export type AdminResetInput = Request<operations["postApiV1OrgsByOrgIdUsersByUserIdPasswordreset"]>;
export type AdminResetResult = Ok<operations["postApiV1OrgsByOrgIdUsersByUserIdPasswordreset"]>;

export interface ApiFailure {
  readonly status: number | null;
  readonly code: string | null;
  readonly message: string;
}

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ApiFailure };

const FALLBACK: Record<number, string> = {
  400: "The submitted details were not accepted.",
  401: "Your session has expired. Sign in again.",
  403: "You are not authorized to perform this action.",
  404: "The user is no longer available in this organization.",
  409: "The action conflicts with the user's current account state.",
  422: "Review the highlighted account details and try again.",
  429: "Too many attempts. Wait a moment and try again.",
};

function failure(status: number | undefined, body: unknown): ApiResult<never> {
  const envelope = body as
    | { error?: { code?: unknown; message?: unknown }; code?: unknown; message?: unknown }
    | null
    | undefined;
  const codeValue = envelope?.error?.code ?? envelope?.code;
  const messageValue = envelope?.error?.message ?? envelope?.message;
  const httpStatus = typeof status === "number" ? status : null;
  return {
    ok: false,
    failure: {
      status: httpStatus,
      code: typeof codeValue === "string" ? codeValue : null,
      message:
        typeof messageValue === "string" && messageValue.length > 0
          ? messageValue
          : httpStatus !== null && FALLBACK[httpStatus]
            ? FALLBACK[httpStatus]
            : "The action could not be completed.",
    },
  };
}

export async function provisionUser(
  client: ApiClient,
  organizationId: string,
  input: ProvisionUserInput,
): Promise<ApiResult<ProvisionedUser>> {
  const { data, error, response } = await client.POST("/api/v1/orgs/{orgId}/users", {
    params: { path: { orgId: organizationId } },
    body: input,
  });
  return error || !data ? failure(response?.status, error) : { ok: true, value: data };
}

export async function resetUserPassword(
  client: ApiClient,
  organizationId: string,
  userId: string,
  input: AdminResetInput,
): Promise<ApiResult<AdminResetResult>> {
  const { data, error, response } = await client.POST(
    "/api/v1/orgs/{orgId}/users/{userId}/password-reset",
    {
      params: { path: { orgId: organizationId, userId } },
      body: input,
    },
  );
  return error || !data ? failure(response?.status, error) : { ok: true, value: data };
}
