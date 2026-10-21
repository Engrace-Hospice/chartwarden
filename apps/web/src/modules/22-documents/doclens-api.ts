// apps/web/src/modules/22-documents — the DocLens review access layer (F-237, ADR-0048): the intake
// review queue, the side-by-side workspace read, and the six review writes (start, release, decide,
// bulk-approve, SUD confirm/reject, complete).
//
// Wire shapes are DERIVED from the generated `operations` — including the completion's write-back summary
// and the bulk-approve route — so a contract change is a compile error here rather than a silently wrong
// screen. Starting a review returns the new review row, but the screen reloads the workspace after it
// anyway: the workspace read is the one place the lock, `isMine` and every decision are projected together.
//
// Every write returns a discriminated result rather than throwing, because each caller renders the
// failure in place, and because the SERVER's error `code` decides the copy (`VISION_DISAGREEMENT_
// REASON_REQUIRED`, `SUD_DETECTION_UNRESOLVED`, a 403 licence refusal). `Idempotency-Key` is attached to
// every mutating request by the client middleware (`createApiClient`); the two routes that REQUIRE one
// (SUD review, complete) also get an explicit key so the requirement is visible at the call site.
import type { ApiClient, operations } from "@chartwarden/ui";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Ok<Op> = Op extends { responses: { 200: infer R } } ? Json<R> : never;
type ReqBody<Op> = Op extends { requestBody?: infer RB } ? Json<RB> : never;

export type QueuePage = Ok<operations["getApiV1IntakeUploads"]>;
export type QueueItem = QueuePage["items"][number];
export type Workspace = Ok<operations["getApiV1IntakeUploadsByIdWorkspace"]>;
export type WorkspacePage = Workspace["pages"][number];
export type WorkspaceJob = Workspace["jobs"][number];
export type Candidate = Workspace["candidates"][number];
export type SudStatus = Workspace["sud"]["status"];
export type SudIndicator = Workspace["sud"]["indicators"][number];
export type Bbox = Candidate["bbox"];
export type DecisionBody = ReqBody<operations["postApiV1IntakeReviewsByIdDecisions"]>;
export type DecisionKind = DecisionBody["decision"];

/** What `POST …/complete` returns; `writeback` is absent when the server reports none. */
export type CompleteResult = Ok<operations["postApiV1IntakeReviewsByIdComplete"]>;

export type ReviewResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: number | null;
      readonly code: string | null;
      readonly message: string;
    };

/** The WardenX error envelope is `{ error: { code, message } }`; anything else yields nulls. */
function envelope(body: unknown): { code: string | null; message: string | null } {
  const inner =
    body && typeof body === "object" && "error" in body
      ? (body as { error?: unknown }).error
      : null;
  if (!inner || typeof inner !== "object") return { code: null, message: null };
  const { code, message } = inner as { code?: unknown; message?: unknown };
  return {
    code: typeof code === "string" ? code : null,
    message: typeof message === "string" ? message : null,
  };
}

/** The licence copy for a 403: §4.7 reserves high-risk fields and SUD resolution for RN-or-above. */
export const LICENCE_REQUIRED = "High-risk fields need an RN, NP, PA or physician reviewer.";

function failure<T>(status: number | undefined, body: unknown, forbidden: string): ReviewResult<T> {
  const { code, message } = envelope(body);
  const s = typeof status === "number" ? status : null;
  const copy =
    code === "VISION_DISAGREEMENT_REASON_REQUIRED"
      ? "The page reads differently from the extracted value. Give a reason (at least 5 characters) to accept it as extracted."
      : code === "SUD_DETECTION_UNRESOLVED"
        ? "Resolve the substance use disorder flag (confirm or reject it) before completing the review."
        : s === 403
          ? forbidden
          : s === 404
            ? "This intake batch is no longer available to you."
            : s === 409
              ? (message ?? "Someone else changed this review. Reload and try again.")
              : (message ?? "The action could not be completed.");
  return { ok: false, status: s, code, message: copy };
}

/** A fresh idempotency key; the client middleware adds one too, but these routes REQUIRE it. */
const idemKey = (): Record<string, string> =>
  typeof globalThis.crypto?.randomUUID === "function"
    ? { "Idempotency-Key": globalThis.crypto.randomUUID() }
    : {};

/** Same-origin URL of one rendered source page (cookie session, like every API call — vite proxies `/api`). */
export const pageImageUrl = (batchId: string, page: number): string =>
  `/api/v1/intake/uploads/${encodeURIComponent(batchId)}/pages/${page}/image`;

export async function startReview(client: ApiClient, batchId: string): Promise<ReviewResult<null>> {
  const { error, response } = await client.POST("/api/v1/intake/uploads/{id}/review", {
    params: { path: { id: batchId } },
    body: {},
  });
  if (error) return failure(response?.status, error, "You are not permitted to review intake.");
  return { ok: true, value: null };
}

export async function releaseReview(
  client: ApiClient,
  reviewId: string,
): Promise<ReviewResult<null>> {
  const { error, response } = await client.POST("/api/v1/intake/reviews/{id}/abandon", {
    params: { path: { id: reviewId } },
    body: {},
  });
  if (error) return failure(response?.status, error, "Only the reviewer can release this review.");
  return { ok: true, value: null };
}

export async function decide(
  client: ApiClient,
  reviewId: string,
  body: DecisionBody,
): Promise<ReviewResult<null>> {
  const { error, response } = await client.POST("/api/v1/intake/reviews/{id}/decisions", {
    params: { path: { id: reviewId } },
    body,
  });
  if (error) return failure(response?.status, error, LICENCE_REQUIRED);
  return { ok: true, value: null };
}

export async function bulkApprove(
  client: ApiClient,
  reviewId: string,
  candidateIds: string[],
): Promise<ReviewResult<null>> {
  const { error, response } = await client.POST(
    "/api/v1/intake/reviews/{id}/decisions:bulk-approve",
    { params: { path: { id: reviewId } }, body: { candidateIds } },
  );
  if (error) return failure(response?.status, error, LICENCE_REQUIRED);
  return { ok: true, value: null };
}

export async function resolveSud(
  client: ApiClient,
  batchId: string,
  outcome: "confirmed" | "rejected",
  reason?: string,
): Promise<ReviewResult<SudStatus>> {
  const { data, error, response } = await client.POST("/api/v1/intake/uploads/{id}/sud-review", {
    params: { path: { id: batchId } },
    body: reason ? { outcome, reason } : { outcome },
    headers: idemKey(),
  });
  if (error || !data)
    return failure(
      response?.status,
      error,
      "Resolving a substance use disorder flag needs an RN, NP, PA or physician reviewer.",
    );
  return { ok: true, value: data.sudStatus };
}

export type WorkspaceDocument = Workspace["documents"][number];
export type IdentityResolution = "same_patient" | "other_patient";

/** F-238 — a reviewer's answer for one document whose identity check flagged it. */
export async function resolveIdentity(
  client: ApiClient,
  batchId: string,
  pageFrom: number,
  resolution: IdentityResolution,
  reason: string,
): Promise<ReviewResult<string>> {
  const { data, error, response } = await client.POST(
    "/api/v1/intake/uploads/{id}/identity-review",
    {
      params: { path: { id: batchId } },
      body: { pageFrom, resolution, reason },
      headers: idemKey(),
    },
  );
  if (error || !data)
    return failure(
      response?.status,
      error,
      "Resolving a document's patient needs intake review access.",
    );
  return { ok: true, value: data.identityStatus };
}

/** F-238 — move a misfiled fax to the right patient (and/or referral) before its review completes. */
export async function relinkBatch(
  client: ApiClient,
  batchId: string,
  to: { patientId?: string; referralId?: string },
  reason: string,
): Promise<ReviewResult<string>> {
  const { data, error, response } = await client.POST("/api/v1/intake/uploads/{id}/relink", {
    params: { path: { id: batchId } },
    body: { ...to, reason },
    headers: idemKey(),
  });
  if (error || !data)
    return failure(response?.status, error, "Moving a fax needs intake review access.");
  return { ok: true, value: data.identityStatus };
}

export async function completeReview(
  client: ApiClient,
  reviewId: string,
): Promise<ReviewResult<CompleteResult>> {
  const { data, error, response } = await client.POST("/api/v1/intake/reviews/{id}/complete", {
    params: { path: { id: reviewId } },
    body: { attestationConfirmed: true },
    headers: idemKey(),
  });
  if (error || !data)
    return failure(response?.status, error, "You are not permitted to complete this review.");
  return { ok: true, value: data };
}
