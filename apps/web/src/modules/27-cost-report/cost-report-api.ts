// apps/web/src/modules/27-cost-report — GAP-082: the M27 WRITE access layer for the cost-report workspace
// (import, compute, validate, approve-for-submit, submit). Until this file the six M27 screens issued no
// writes against 29 write routes, so the CMS-1984 filing could not be prepared in the app.
//
// WHAT THE SERVER OWNS, WHICH NOTHING HERE RE-DECIDES (ADR-0030 — no frontend authz).
//   • Permissions, the provider-scoped ABAC predicates and the §D14 step-up freshness: a 403 is the answer
//     and its message is shown verbatim. `STEP_UP_REQUIRED` is returned as a code so the caller can route to
//     the step-up ceremony.
//   • The two-person control (GAP-081): the approver and the submitter are derived from the session. The
//     submit body carries NO membership id and no timestamp — `submit` is sent `{}`.
//   • The lifecycle state machine: a 409 means the report is not in the state the action needs.
// `Idempotency-Key` is attached to every mutation by the shared api client.
import type { ApiClient } from "@chartwarden/ui";

export type WriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: number | null;
      readonly code: string | null;
      readonly message: string;
      /** The raw error body, so the caller can hand it to `stepUpRedirectFor`. */
      readonly raw: unknown;
    };

export interface JobAccepted {
  readonly jobId: string;
}

const FALLBACK: Record<number, string> = {
  403: "The server did not permit this action.",
  404: "That cost report is no longer available to you.",
  409: "The cost report is not in a state that allows this action. Reload and try again.",
  422: "The server rejected the details supplied.",
};

/** Server refusals are shown verbatim: the server's own `error.message` wins over every fallback. */
export function failure(status: number | undefined, body: unknown): WriteResult<never> {
  const httpStatus = typeof status === "number" ? status : null;
  const err =
    body && typeof body === "object" && "error" in body
      ? (body as { error?: { code?: unknown; message?: unknown } }).error
      : undefined;
  const detail = typeof err?.message === "string" && err.message !== "" ? err.message : null;
  const code = typeof err?.code === "string" ? err.code : null;
  const message =
    detail ??
    (httpStatus !== null ? FALLBACK[httpStatus] : undefined) ??
    "The action could not be completed.";
  return { ok: false, status: httpStatus, code, message, raw: body };
}

const ok = <T>(value: T): WriteResult<T> => ({ ok: true, value });

type Id = { params: { path: { id: string } } };
const byId = (id: string): Id => ({ params: { path: { id } } });

/** Trigger an immediate Xero trial-balance pull (202, job id). */
export async function pullTrialBalance(
  client: ApiClient,
  id: string,
): Promise<WriteResult<JobAccepted>> {
  const { data, error, response } = await client.POST(
    "/api/v1/cost-reports/{id}/imports/trial-balance",
    byId(id),
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data as JobAccepted);
}

/** Trigger an immediate Gusto wage-data pull (202, job id). */
export async function pullWageData(
  client: ApiClient,
  id: string,
): Promise<WriteResult<JobAccepted>> {
  const { data, error, response } = await client.POST(
    "/api/v1/cost-reports/{id}/imports/wage-data",
    byId(id),
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data as JobAccepted);
}

/** Manual trial-balance upload (source `manual_csv`). Row shape is validated by the server. */
export async function importTrialBalanceManual(
  client: ApiClient,
  id: string,
  normalizedAccounts: unknown[],
): Promise<WriteResult<{ importId: string; accountCount: number }>> {
  const { data, error, response } = await client.POST(
    "/api/v1/cost-reports/{id}/imports/trial-balance/manual",
    { ...byId(id), body: { normalizedAccounts } },
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data as { importId: string; accountCount: number });
}

/** Manual wage-data upload (source `manual_csv`). Row shape is validated by the server. */
export async function importWageDataManual(
  client: ApiClient,
  id: string,
  normalizedWageRows: unknown[],
): Promise<WriteResult<{ importId: string }>> {
  const { data, error, response } = await client.POST(
    "/api/v1/cost-reports/{id}/imports/wage-data/manual",
    { ...byId(id), body: { normalizedWageRows } },
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data as { importId: string });
}

/** Enqueue the B/C derived-worksheet recompute for one worksheet (202). */
export async function computeWorksheet(
  client: ApiClient,
  id: string,
  code: string,
): Promise<WriteResult<JobAccepted>> {
  const { data, error, response } = await client.POST(
    "/api/v1/cost-reports/{id}/worksheets/{code}/compute",
    { params: { path: { id, code } } },
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data as JobAccepted);
}

/** Enqueue the full step-down allocation + apportionment recompute (202). */
export async function allocate(client: ApiClient, id: string): Promise<WriteResult<JobAccepted>> {
  const { data, error, response } = await client.POST(
    "/api/v1/cost-reports/{id}/allocate",
    byId(id),
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data as JobAccepted);
}

/** Enqueue a validation run (202; the report moves to `validating`). */
export async function runValidation(
  client: ApiClient,
  id: string,
): Promise<WriteResult<JobAccepted>> {
  const { data, error, response } = await client.POST(
    "/api/v1/cost-reports/{id}/validate",
    byId(id),
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data as JobAccepted);
}

/** First half of the two-person control: ready_for_review -> approved_for_submit. Server derives the approver. */
export async function approveForSubmit(
  client: ApiClient,
  id: string,
  validationId: string | undefined,
): Promise<WriteResult<{ state: string }>> {
  const { data, error, response } = await client.POST(
    "/api/v1/cost-reports/{id}/approve-for-submit",
    { ...byId(id), body: validationId ? { validationId } : {} },
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data as { state: string });
}

/**
 * Second half: approved_for_submit -> submitted. The body is intentionally EMPTY — GAP-081 made the
 * attester and the approver server-derived, so the UI never sends `approvedByMembershipId`.
 */
export async function submitReport(
  client: ApiClient,
  id: string,
): Promise<WriteResult<{ state: string }>> {
  const { data, error, response } = await client.POST("/api/v1/cost-reports/{id}/submit", {
    ...byId(id),
    body: {},
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data as { state: string });
}
