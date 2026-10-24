// apps/web/src/modules/25-remittance — the access layer for milestone 7a-1: the claim case view, later-tier (ALJ /
// Council / federal court) records, recorded deadlines, and audit-request intake. Every wire shape is an alias into
// the generated `operations` map (never a hand-copied interface). The server owns every rule and refusal: every date
// here is typed by the user from a notice; nothing is computed or defaulted on this side.
import type { ApiClient, operations } from "@chartwarden/ui";
import { type WriteResult, failure, guarded, ifMatch, ok } from "./remittance-api";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Ok<Op> = Op extends { responses: { 200: infer R } } ? Json<R> : never;
type ReqBody<Op> = Op extends { requestBody?: infer RB } ? Json<RB> : never;

export type CaseView = Ok<operations["getApiV1ClaimsByClaimIdCaseview"]>;
export type TimelineItem = CaseView["items"][number];
export type LaterTierView = Ok<operations["getApiV1AppealsByIdLatertier"]>;
export type LaterTierDetailInput = ReqBody<operations["putApiV1AppealsByIdLatertierDetail"]>;
export type RecordedDeadlineInput = ReqBody<
  operations["postApiV1AuditrequestsByIdRecordeddeadlines"]
>;
export type RecordedDeadlinePatch = ReqBody<
  operations["patchApiV1AuditrequestsByIdRecordeddeadlinesByDeadlineId"]
>;
export type AuditRequestSummary = Ok<operations["getApiV1Auditrequests"]>["items"][number];
export type AuditRequestDetail = Ok<operations["getApiV1AuditrequestsById"]>;
/** The looser (audit detail) shape; the later-tier view's narrower enums are assignable to it. */
export type RecordedDeadlineView = Ok<
  operations["getApiV1AppealsByIdRecordeddeadlines"]
>["items"][number];
export type AuditRequestInput = ReqBody<operations["postApiV1Auditrequests"]>;
export type AuditRequestPatch = ReqBody<operations["patchApiV1AuditrequestsById"]>;
export type AuditRequestState = ReqBody<operations["postApiV1AuditrequestsByIdState"]>["to"];
export type Versioned = Ok<operations["postApiV1AuditrequestsByIdState"]>;
export type AuditResponseView = AuditRequestDetail["response"];
export type AuditResponseItem = ReqBody<
  operations["putApiV1AuditrequestsByIdResponseitems"]
>["items"][number];
export type AuditFilingInput = ReqBody<operations["postApiV1AuditrequestsByIdSubmit"]>;

export const AUDIT_AUTHORITY_KINDS = ["rac", "upic", "smrc", "other"] as const;
export const LATER_TIERS = ["alj", "council", "federal_court"] as const;
export const DISPOSITION_KINDS = ["decision", "remand", "dismissal", "other"] as const;
/** A later-tier appeal tier (the three that carry a LaterTierPanel). */
export const isLaterTier = (tier: string): boolean =>
  (LATER_TIERS as readonly string[]).includes(tier);

/** A 409 on a versioned write means the record moved: reload it so the next attempt carries the fresh version. */
export const isConflict = (res: { readonly status: number | null }): boolean => res.status === 409;

/** The two subjects a recorded deadline can hang off; each has its own route family and permission. */
export type DeadlineSubject = { kind: "appeal" | "audit" | "payer_appeal"; id: string };

export async function loadCaseView(
  client: ApiClient,
  claimId: string,
): Promise<WriteResult<CaseView>> {
  return guarded(async () => {
    const { data, error, response } = await client.GET("/api/v1/claims/{claimId}/case-view", {
      params: { path: { claimId } },
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function loadLaterTier(
  client: ApiClient,
  appealId: string,
): Promise<WriteResult<LaterTierView>> {
  return guarded(async () => {
    const { data, error, response } = await client.GET("/api/v1/appeals/{id}/later-tier", {
      params: { path: { id: appealId } },
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

/** `version` is 0 to create the detail, else the detail's current version. */
export async function saveLaterTierDetail(
  client: ApiClient,
  appealId: string,
  version: number,
  body: LaterTierDetailInput,
): Promise<WriteResult<Versioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.PUT("/api/v1/appeals/{id}/later-tier/detail", {
      params: { path: { id: appealId } },
      headers: ifMatch(version),
      body,
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function addRecordedDeadline(
  client: ApiClient,
  subject: DeadlineSubject,
  body: RecordedDeadlineInput,
): Promise<WriteResult<Versioned>> {
  return guarded(async () => {
    const params = { params: { path: { id: subject.id } }, body };
    const res =
      subject.kind === "appeal"
        ? await client.POST("/api/v1/appeals/{id}/recorded-deadlines", params)
        : subject.kind === "payer_appeal"
          ? await client.POST("/api/v1/payer-appeals/{id}/recorded-deadlines", params)
          : await client.POST("/api/v1/audit-requests/{id}/recorded-deadlines", params);
    return res.error || !res.data ? failure(res.response?.status, res.error) : ok(res.data);
  });
}

export async function editRecordedDeadline(
  client: ApiClient,
  subject: DeadlineSubject,
  deadline: Pick<RecordedDeadlineView, "id" | "version">,
  body: RecordedDeadlinePatch,
): Promise<WriteResult<Versioned>> {
  return guarded(async () => {
    const params = { path: { id: subject.id, deadlineId: deadline.id } };
    const headers = ifMatch(deadline.version);
    const args = { params, headers, body };
    const res =
      subject.kind === "appeal"
        ? await client.PATCH("/api/v1/appeals/{id}/recorded-deadlines/{deadlineId}", args)
        : subject.kind === "payer_appeal"
          ? await client.PATCH("/api/v1/payer-appeals/{id}/recorded-deadlines/{deadlineId}", args)
          : await client.PATCH("/api/v1/audit-requests/{id}/recorded-deadlines/{deadlineId}", args);
    return res.error || !res.data ? failure(res.response?.status, res.error) : ok(res.data);
  });
}

export async function satisfyRecordedDeadline(
  client: ApiClient,
  subject: DeadlineSubject,
  deadline: Pick<RecordedDeadlineView, "id" | "version">,
  satisfiedOn?: string,
): Promise<WriteResult<Versioned>> {
  return guarded(async () => {
    const params = { path: { id: subject.id, deadlineId: deadline.id } };
    const headers = ifMatch(deadline.version);
    const body = satisfiedOn ? { satisfiedOn } : {};
    const args = { params, headers, body };
    const res =
      subject.kind === "appeal"
        ? await client.POST("/api/v1/appeals/{id}/recorded-deadlines/{deadlineId}/satisfy", args)
        : subject.kind === "payer_appeal"
          ? await client.POST(
              "/api/v1/payer-appeals/{id}/recorded-deadlines/{deadlineId}/satisfy",
              args,
            )
          : await client.POST(
              "/api/v1/audit-requests/{id}/recorded-deadlines/{deadlineId}/satisfy",
              args,
            );
    return res.error || !res.data ? failure(res.response?.status, res.error) : ok(res.data);
  });
}

export async function loadAuditRequests(
  client: ApiClient,
): Promise<WriteResult<readonly AuditRequestSummary[]>> {
  return guarded(async () => {
    const { data, error, response } = await client.GET("/api/v1/audit-requests", {});
    return error || !data ? failure(response?.status, error) : ok(data.items);
  });
}

export async function loadAuditRequest(
  client: ApiClient,
  id: string,
): Promise<WriteResult<AuditRequestDetail>> {
  return guarded(async () => {
    const { data, error, response } = await client.GET("/api/v1/audit-requests/{id}", {
      params: { path: { id } },
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function createAuditRequest(
  client: ApiClient,
  body: AuditRequestInput,
): Promise<WriteResult<Versioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/audit-requests", { body });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function patchAuditRequest(
  client: ApiClient,
  id: string,
  version: number,
  body: AuditRequestPatch,
): Promise<WriteResult<Versioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.PATCH("/api/v1/audit-requests/{id}", {
      params: { path: { id } },
      headers: ifMatch(version),
      body,
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function linkAuditClaim(
  client: ApiClient,
  id: string,
  version: number,
  claimId: string,
  dateOfServiceNote?: string,
): Promise<WriteResult<{ id: string }>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/audit-requests/{id}/claims", {
      params: { path: { id } },
      headers: ifMatch(version),
      body: { claimId, ...(dateOfServiceNote ? { dateOfServiceNote } : {}) },
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function unlinkAuditClaim(
  client: ApiClient,
  id: string,
  version: number,
  claimId: string,
): Promise<WriteResult<{ id: string }>> {
  return guarded(async () => {
    const { data, error, response } = await client.DELETE(
      "/api/v1/audit-requests/{id}/claims/{claimId}",
      { params: { path: { id, claimId } }, headers: ifMatch(version) },
    );
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function moveAuditRequest(
  client: ApiClient,
  id: string,
  version: number,
  to: AuditRequestState,
): Promise<WriteResult<Versioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/audit-requests/{id}/state", {
      params: { path: { id } },
      headers: ifMatch(version),
      body: { to },
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

// ── milestone 7a-2: the audit response packet ───────────────────────────────────────────────────────────────

/** The checklist is typed by the user from the request letter; the whole list is replaced. */
export async function saveAuditResponseItems(
  client: ApiClient,
  id: string,
  version: number,
  items: readonly AuditResponseItem[],
): Promise<WriteResult<Versioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.PUT(
      "/api/v1/audit-requests/{id}/response-items",
      { params: { path: { id } }, headers: ifMatch(version), body: { items: [...items] } },
    );
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function attachAuditDocument(
  client: ApiClient,
  id: string,
  version: number,
  body: { claimId: string; documentId: string },
): Promise<WriteResult<Versioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/audit-requests/{id}/documents", {
      params: { path: { id } },
      headers: ifMatch(version),
      body,
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function detachAuditDocument(
  client: ApiClient,
  id: string,
  version: number,
  documentId: string,
): Promise<WriteResult<Versioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.DELETE(
      "/api/v1/audit-requests/{id}/documents/{documentId}",
      { params: { path: { id, documentId } }, headers: ifMatch(version) },
    );
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

/** "The request letter states no due date": a person's explicit attestation, never inferred. */
export async function attestNoDeadlineStated(
  client: ApiClient,
  id: string,
  version: number,
): Promise<WriteResult<Versioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST(
      "/api/v1/audit-requests/{id}/deadline-none-stated",
      { params: { path: { id } }, headers: ifMatch(version) },
    );
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function signOffAudit(
  client: ApiClient,
  id: string,
  version: number,
): Promise<WriteResult<Versioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/audit-requests/{id}/sign-off", {
      params: { path: { id } },
      headers: ifMatch(version),
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function submitAuditResponse(
  client: ApiClient,
  id: string,
  version: number,
  body: AuditFilingInput,
): Promise<WriteResult<Versioned>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/audit-requests/{id}/submit", {
      params: { path: { id } },
      headers: ifMatch(version),
      body,
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}
