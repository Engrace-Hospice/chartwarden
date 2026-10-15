// apps/web/src/modules/25-remittance — the M25 WRITE access layer (GAP-074). Before this file the four M25
// screens issued GETs only, although the backend carries the denial ladder, the appeal lifecycle and the ERA
// manual match. Every wire shape is an alias into the generated `operations` map (never a hand-copied
// interface), so a contract change is a compile error here.
//
// WHAT THE SERVER OWNS, WHICH NOTHING HERE RE-DECIDES (ADR-0030 — no frontend authz).
//   • Authorization: a 403 is the answer, shown verbatim. No control is enabled or hidden from a client-side
//     role guess; the only gate this layer applies is the row's own `state` (a server fact) so the screen does
//     not offer an edge the state machine has no arc for. The server still validates every transition.
//   • Optimistic concurrency: the denial/appeal PATCH/POST transitions require `If-Match: <row version>`; a stale
//     version is a 409 and is shown as such (re-open the panel to re-read).
//   • Step-up (§D15): appeal submit, close-with-write-off, manual adjustment override. A 403 `STEP_UP_REQUIRED`
//     is surfaced as `stepUp: true` so the caller can send the user through `/step-up?returnTo=`.
//   • `Idempotency-Key` is attached to every mutating request by the shared client middleware.
import type { ApiClient, operations } from "@wardenx/ui";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Ok<Op> = Op extends { responses: { 200: infer R } } ? Json<R> : never;
type ReqBody<Op> = Op extends { requestBody?: infer RB } ? Json<RB> : never;

export type DenialDetail = Ok<operations["getApiV1DenialsById"]>;
export type AppealDetail = Ok<operations["getApiV1AppealsById"]>;
export type VersionedResult = Ok<operations["patchApiV1DenialsByIdAssign"]>;
export type ManualMatchResult = Ok<operations["postApiV1RemittanceLinesByIdManualmatch"]>;
export type AppealTier = NonNullable<ReqBody<operations["postApiV1DenialsByIdAppeals"]>["tier"]>;
export type AppealOutcome = ReqBody<operations["postApiV1AppealsByIdDecide"]>["outcome"];

/** Server floors, mirrored (m25-typebox.ts) so a button can say WHY it is disabled instead of a 422 after. */
export const MIN_REASON = {
  escalate: 20,
  resolve: 40,
  closeWriteOff: 40,
  reopen: 40,
  decide: 40,
  withdraw: 40,
  manualMatch: 20,
} as const;
export const MAX_MANUAL_MATCH_REASON = 500;
export const MIN_APPEAL_NARRATIVE = 100;

export type WriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: number | null;
      readonly code: string | null;
      readonly message: string;
      /** True only for the 403 STEP_UP_REQUIRED refusal — the user must re-verify, then retry. */
      readonly stepUp: boolean;
    };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string): boolean => UUID_RE.test(v.trim());

const FALLBACK: Record<number, string> = {
  400: "The request was not accepted.",
  403: "You are not permitted to take this action.",
  404: "That record is no longer available to you.",
  409: "This record changed before your action was applied. Close and re-open it to reload.",
  422: "The server rejected the details supplied.",
};

/** Turn an openapi-fetch error into a result. The server's own message wins; it is never paraphrased. */
function failure(status: number | undefined, body: unknown): WriteResult<never> {
  const httpStatus = typeof status === "number" ? status : null;
  const err =
    body && typeof body === "object" && "error" in body
      ? (body as { error?: { code?: unknown; message?: unknown } }).error
      : undefined;
  const code = typeof err?.code === "string" ? err.code : null;
  const detail = typeof err?.message === "string" && err.message ? err.message : null;
  const message =
    detail ??
    (httpStatus !== null ? FALLBACK[httpStatus] : undefined) ??
    "The action could not be completed.";
  return { ok: false, status: httpStatus, code, message, stepUp: code === "STEP_UP_REQUIRED" };
}

const ok = <T>(value: T): WriteResult<T> => ({ ok: true, value });
const ifMatch = (version: number) => ({ "If-Match": String(version) });

// ── reads ──────────────────────────────────────────────────────────────────────────────────────────────

export async function loadDenial(
  client: ApiClient,
  id: string,
): Promise<WriteResult<DenialDetail>> {
  const { data, error, response } = await client.GET("/api/v1/denials/{id}", {
    params: { path: { id } },
  });
  return error || !data ? failure(response?.status, error) : ok(data);
}

export async function loadAppeal(
  client: ApiClient,
  id: string,
): Promise<WriteResult<AppealDetail>> {
  const { data, error, response } = await client.GET("/api/v1/appeals/{id}", {
    params: { path: { id } },
  });
  return error || !data ? failure(response?.status, error) : ok(data);
}

// ── denial ladder ──────────────────────────────────────────────────────────────────────────────────────

export type DenialAction =
  | { kind: "assign"; assigneeMembershipId: string; reason?: string }
  | { kind: "start" }
  | { kind: "escalate"; reason: string }
  | { kind: "resolve"; reason: string }
  | { kind: "close" }
  | { kind: "close-write-off"; reason: string }
  | { kind: "reopen"; reason: string }
  | { kind: "appeal"; tier?: AppealTier; noticeDate?: string };

/** Run one denial action. `version` is the row version the panel read (sent as If-Match where required). */
export async function runDenialAction(
  client: ApiClient,
  id: string,
  version: number,
  action: DenialAction,
): Promise<WriteResult<VersionedResult>> {
  const params = { path: { id } };
  const headers = ifMatch(version);
  switch (action.kind) {
    case "assign": {
      const { data, error, response } = await client.PATCH("/api/v1/denials/{id}/assign", {
        params,
        headers,
        body: {
          assigneeMembershipId: action.assigneeMembershipId,
          ...(action.reason ? { reason: action.reason } : {}),
        },
      });
      return error || !data ? failure(response?.status, error) : ok(data);
    }
    case "start": {
      const { data, error, response } = await client.PATCH("/api/v1/denials/{id}/start", {
        params,
        headers,
      });
      return error || !data ? failure(response?.status, error) : ok(data);
    }
    case "escalate": {
      const { data, error, response } = await client.PATCH("/api/v1/denials/{id}/escalate", {
        params,
        headers,
        body: { reason: action.reason },
      });
      return error || !data ? failure(response?.status, error) : ok(data);
    }
    case "resolve": {
      const { data, error, response } = await client.PATCH("/api/v1/denials/{id}/resolve", {
        params,
        headers,
        body: { reason: action.reason },
      });
      return error || !data ? failure(response?.status, error) : ok(data);
    }
    case "close": {
      const { data, error, response } = await client.POST("/api/v1/denials/{id}/close", {
        params,
        headers,
      });
      return error || !data ? failure(response?.status, error) : ok(data);
    }
    case "close-write-off": {
      const { data, error, response } = await client.POST("/api/v1/denials/{id}/close-write-off", {
        params,
        headers,
        body: { reason: action.reason },
      });
      return error || !data ? failure(response?.status, error) : ok(data);
    }
    case "reopen": {
      const { data, error, response } = await client.POST("/api/v1/denials/{id}/reopen", {
        params,
        headers,
        body: { reason: action.reason },
      });
      return error || !data ? failure(response?.status, error) : ok(data);
    }
    case "appeal": {
      const { data, error, response } = await client.POST("/api/v1/denials/{id}/appeals", {
        params,
        body: {
          ...(action.tier ? { tier: action.tier } : {}),
          ...(action.noticeDate ? { noticeDate: action.noticeDate } : {}),
        },
      });
      return error || !data ? failure(response?.status, error) : ok(data);
    }
  }
}

// ── appeal lifecycle ───────────────────────────────────────────────────────────────────────────────────

export type AppealAction =
  | { kind: "attach"; documentId: string }
  | { kind: "submit"; appealNarrative: string; attachedDocumentIds: string[] }
  | { kind: "ack" }
  | {
      kind: "decide";
      outcome: AppealOutcome;
      decidedAt: string;
      /** The date printed on the decision letter (YYYY-MM-DD); the next tier's clock runs from it. */
      decisionNoticeDate?: string;
      reason: string;
      macReferenceNumbers?: Record<string, string>;
    }
  | { kind: "withdraw"; reason: string }
  | { kind: "close" };

export async function runAppealAction(
  client: ApiClient,
  id: string,
  version: number,
  action: AppealAction,
): Promise<WriteResult<VersionedResult>> {
  const params = { path: { id } };
  const headers = ifMatch(version);
  switch (action.kind) {
    case "attach": {
      const { data, error, response } = await client.PATCH("/api/v1/appeals/{id}/attach", {
        params,
        headers,
        body: { documentId: action.documentId },
      });
      return error || !data ? failure(response?.status, error) : ok(data);
    }
    case "submit": {
      const { data, error, response } = await client.POST("/api/v1/appeals/{id}/submit", {
        params,
        headers,
        body: {
          appealNarrative: action.appealNarrative,
          attachedDocumentIds: action.attachedDocumentIds,
        },
      });
      return error || !data ? failure(response?.status, error) : ok(data);
    }
    case "ack": {
      const { data, error, response } = await client.PATCH("/api/v1/appeals/{id}/ack", {
        params,
        headers,
      });
      return error || !data ? failure(response?.status, error) : ok(data);
    }
    case "decide": {
      const { data, error, response } = await client.POST("/api/v1/appeals/{id}/decide", {
        params,
        headers,
        body: {
          outcome: action.outcome,
          decidedAt: action.decidedAt,
          ...(action.decisionNoticeDate ? { decisionNoticeDate: action.decisionNoticeDate } : {}),
          reason: action.reason,
          ...(action.macReferenceNumbers
            ? { macReferenceNumbers: action.macReferenceNumbers }
            : {}),
        },
      });
      return error || !data ? failure(response?.status, error) : ok(data);
    }
    case "withdraw": {
      const { data, error, response } = await client.POST("/api/v1/appeals/{id}/withdraw", {
        params,
        headers,
        body: { reason: action.reason },
      });
      return error || !data ? failure(response?.status, error) : ok(data);
    }
    case "close": {
      const { data, error, response } = await client.POST("/api/v1/appeals/{id}/close", {
        params,
        headers,
      });
      return error || !data ? failure(response?.status, error) : ok(data);
    }
  }
}

// ── ERA manual match (GAP-073 contract) ────────────────────────────────────────────────────────────────

/**
 * Match one unmatched 835 line to a claim. The server validates that the claim exists in the line's provider
 * entity (404 otherwise) and REQUIRES a rationale (20–500 chars) which it records on the audit row. Nothing
 * else is sent: not the payer, not the amount — the server derives the posting from the line itself.
 */
export async function manualMatchLine(
  client: ApiClient,
  lineId: string,
  body: { proposedClaimId: string; reason: string },
): Promise<WriteResult<ManualMatchResult>> {
  const { data, error, response } = await client.POST(
    "/api/v1/remittance/lines/{id}/manual-match",
    { params: { path: { id: lineId } }, body },
  );
  return error || !data ? failure(response?.status, error) : ok(data);
}

// ── ADR intake (hospice ADR/TPE/QIC PRD, milestone 2a) ─────────────────────────────────────────────────

export type AdrDetail = Ok<operations["getApiV1AdrsById"]>;
export type AdrCreateInput = ReqBody<operations["postApiV1Adrs"]>;
export type AdrTransitionTarget = ReqBody<operations["postApiV1AdrsByIdTransition"]>["to"];
export type MacRuleInput = ReqBody<operations["putApiV1Macrules"]>;
export type MacRulesPage = Ok<operations["getApiV1Macrules"]>;
export type AdrReviewType = AdrCreateInput["reviewType"];

/** A thrown request (network down, aborted) becomes a refusal result instead of an unhandled rejection. */
async function guarded<T>(run: () => Promise<WriteResult<T>>): Promise<WriteResult<T>> {
  try {
    return await run();
  } catch {
    return failure(undefined, undefined);
  }
}

export async function loadAdr(client: ApiClient, id: string): Promise<WriteResult<AdrDetail>> {
  return guarded(async () => {
    const { data, error, response } = await client.GET("/api/v1/adrs/{id}", {
      params: { path: { id } },
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function createAdr(
  client: ApiClient,
  body: AdrCreateInput,
): Promise<WriteResult<VersionedResult>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/adrs", { body });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function transitionAdr(
  client: ApiClient,
  id: string,
  version: number,
  to: AdrTransitionTarget,
): Promise<WriteResult<VersionedResult>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/adrs/{id}/transition", {
      params: { path: { id } },
      headers: ifMatch(version),
      body: { to },
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

// ── ADR response packet (milestone 2b): attachments, checklist, sign-off, recorded filing ────────────────

export type AdrChecklistState = ReqBody<operations["putApiV1AdrsByIdChecklistByKey"]>["state"];
export type AdrAttachInput = ReqBody<operations["postApiV1AdrsByIdDocuments"]>;
export type AdrFilingInput = ReqBody<operations["postApiV1AdrsByIdSubmit"]>;

export async function attachAdrDocument(
  client: ApiClient,
  id: string,
  version: number,
  body: AdrAttachInput,
): Promise<WriteResult<VersionedResult>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/adrs/{id}/documents", {
      params: { path: { id } },
      headers: ifMatch(version),
      body,
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function detachAdrDocument(
  client: ApiClient,
  id: string,
  version: number,
  documentId: string,
): Promise<WriteResult<VersionedResult>> {
  return guarded(async () => {
    const { data, error, response } = await client.DELETE(
      "/api/v1/adrs/{id}/documents/{documentId}",
      { params: { path: { id, documentId } }, headers: ifMatch(version) },
    );
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function setAdrChecklist(
  client: ApiClient,
  id: string,
  version: number,
  key: string,
  state: AdrChecklistState,
): Promise<WriteResult<VersionedResult>> {
  return guarded(async () => {
    const { data, error, response } = await client.PUT("/api/v1/adrs/{id}/checklist/{key}", {
      params: { path: { id, key } },
      headers: ifMatch(version),
      body: { state },
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function signOffAdr(
  client: ApiClient,
  id: string,
  version: number,
): Promise<WriteResult<VersionedResult>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/adrs/{id}/sign-off", {
      params: { path: { id } },
      headers: ifMatch(version),
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function submitAdr(
  client: ApiClient,
  id: string,
  version: number,
  body: AdrFilingInput,
): Promise<WriteResult<VersionedResult>> {
  return guarded(async () => {
    const { data, error, response } = await client.POST("/api/v1/adrs/{id}/submit", {
      params: { path: { id } },
      headers: ifMatch(version),
      body,
    });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function loadMacRules(client: ApiClient): Promise<WriteResult<MacRulesPage>> {
  return guarded(async () => {
    const { data, error, response } = await client.GET("/api/v1/mac-rules");
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}

export async function saveMacRule(
  client: ApiClient,
  body: MacRuleInput,
): Promise<WriteResult<VersionedResult>> {
  return guarded(async () => {
    const { data, error, response } = await client.PUT("/api/v1/mac-rules", { body });
    return error || !data ? failure(response?.status, error) : ok(data);
  });
}
