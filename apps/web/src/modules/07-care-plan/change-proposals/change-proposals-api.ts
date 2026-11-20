// apps/web/src/modules/07-care-plan/change-proposals — the typed access layer for the plan-of-care change proposals a visit records (WF09)
// and for the visit <-> plan-element links beside them. Every function answers a `ProposalResult` and never throws: a request that got
// no answer is `{ ok: false, status: null }`, so a caller has one shape to read.
//
// Idempotency: `POST .../change-proposals` DECLARES an `Idempotency-Key`, so the key comes from the shared attempt keys, one per intent
// (route + plan + body). The same key is kept across a lost reply, a gateway page and the in-flight 409, so a retry cannot record a
// second proposal; any other answer renews it. Accept and dismiss are idempotent on the server and carry no key.
//
// Proposal text is clinical free text: it travels in request bodies only, never in a URL, a log line or an error message.
import { type ApiClient, sharedAttemptKeys } from "@chartwarden/ui";
import type { CarePlan } from "../care-plan-api";
import {
  LINK_NOT_ALLOWED_COPY,
  LINK_NOT_FOUND_COPY,
  proposalErrorMessage,
} from "./proposal-labels";
import type {
  ChangeProposal,
  CreateProposalBody,
  DismissalReason,
  ProposalChange,
  ProposalList,
  ReviewStatus,
  VisitLink,
  VisitLinkTarget,
} from "./proposal-types";

export type ProposalResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      /** The HTTP status, or null when the request got no answer. */
      readonly status: number | null;
      readonly message: string;
      /** The parsed error body exactly as the server sent it (the platform envelope), for field and code reading. */
      readonly body: unknown;
    };

interface RawResult {
  readonly data?: unknown;
  readonly error?: unknown;
  readonly response?: Response;
}

/** An openapi-fetch result: a refusal is `error` set OR a non-2xx response; success does not require a body (a DELETE has none). */
function settle<T>(res: RawResult, notFoundCopy?: string): ProposalResult<T> {
  if (res.error === undefined && res.response?.ok !== false) {
    return { ok: true, value: res.data as T };
  }
  const status = res.response?.status ?? null;
  return {
    ok: false,
    status,
    message: proposalErrorMessage(res.error, status, notFoundCopy),
    body: res.error,
  };
}

/** Run one request; a request that throws (no answer at all) becomes a result, never a rejection. */
async function attempt<T>(
  send: () => Promise<RawResult>,
  notFoundCopy?: string,
): Promise<ProposalResult<T>> {
  try {
    return settle<T>(await send(), notFoundCopy);
  } catch {
    return { ok: false, status: null, message: proposalErrorMessage(undefined, null), body: null };
  }
}

// ── the plan the visit is documented against ────────────────────────────────────────────────────────────

/** The patient's current plan, or `null` when there is none yet (the read answers `{ carePlan: null }`). */
export async function loadCarePlan(
  client: ApiClient,
  patientId: string,
): Promise<ProposalResult<CarePlan | null>> {
  const res = await attempt<unknown>(() =>
    client.GET("/api/v1/patients/{patientId}/care-plan", { params: { path: { patientId } } }),
  );
  if (!res.ok) return res;
  const data = res.value as Partial<CarePlan> | null | undefined;
  if (!data || typeof data.id !== "string") return { ok: true, value: null };
  // The lists are read defensively: a plan answer that omits one reads as an empty list, never a crash.
  return {
    ok: true,
    value: {
      ...(data as CarePlan),
      problems: data.problems ?? [],
      goals: data.goals ?? [],
      interventions: data.interventions ?? [],
      versions: data.versions ?? [],
    },
  };
}

// ── proposals ───────────────────────────────────────────────────────────────────────────────────────────

/** A list read answers `{ proposals, redacted }`; a malformed body reads as an empty list rather than a crash. */
function listOf(value: ProposalList | null | undefined): ProposalList {
  return {
    patientId: value?.patientId ?? "",
    proposals: value?.proposals ?? [],
    redacted: value?.redacted === true,
  };
}

/** The plan's review list: released proposals only, `pending` by default. */
export async function listPlanProposals(
  client: ApiClient,
  planId: string,
  status: ReviewStatus,
): Promise<ProposalResult<ProposalList>> {
  const res = await attempt<ProposalList>(() =>
    client.GET("/api/v1/care-plans/{planId}/change-proposals", {
      params: { path: { planId }, query: { status } },
    }),
  );
  return res.ok ? { ok: true, value: listOf(res.value) } : res;
}

/** One visit's proposals, including the caller's own drafts. */
export async function listVisitProposals(
  client: ApiClient,
  patientId: string,
  sourceEncounterId: string,
): Promise<ProposalResult<ProposalList>> {
  const res = await attempt<ProposalList>(() =>
    client.GET("/api/v1/patients/{patientId}/care-plan-change-proposals", {
      params: { path: { patientId }, query: { sourceEncounterId } },
    }),
  );
  return res.ok ? { ok: true, value: listOf(res.value) } : res;
}

/** Record a DRAFT only its author sees. The Idempotency-Key is held per intent, so a retry replays rather than records twice. */
export async function createProposal(
  client: ApiClient,
  planId: string,
  body: CreateProposalBody,
): Promise<ProposalResult<ChangeProposal>> {
  return attempt<ChangeProposal>(() =>
    sharedAttemptKeys.run(JSON.stringify(["change-proposal:create", planId, body]), (key) =>
      client.POST("/api/v1/care-plans/{planId}/change-proposals", {
        params: { path: { planId }, header: { "Idempotency-Key": key } },
        body,
      }),
    ),
  );
}

/** Replace the change of the caller's own draft wholesale (the visit it belongs to never changes). */
export async function replaceProposal(
  client: ApiClient,
  planId: string,
  proposalId: string,
  body: ProposalChange,
): Promise<ProposalResult<ChangeProposal>> {
  return attempt<ChangeProposal>(() =>
    client.PUT("/api/v1/care-plans/{planId}/change-proposals/{proposalId}", {
      params: { path: { planId, proposalId } },
      body,
    }),
  );
}

/** Withdraw the caller's own draft (and, on the server, the drafts that depend on it). */
export async function withdrawProposal(
  client: ApiClient,
  planId: string,
  proposalId: string,
): Promise<ProposalResult<{ proposalId: string; status: "withdrawn" }>> {
  return attempt(() =>
    client.DELETE("/api/v1/care-plans/{planId}/change-proposals/{proposalId}", {
      params: { path: { planId, proposalId } },
    }),
  );
}

/** Apply a pending proposal to the plan under the accepter's discipline scope. Idempotent: a second accept reports the first result. */
export async function acceptProposal(
  client: ApiClient,
  planId: string,
  proposalId: string,
): Promise<
  ProposalResult<{ proposalId: string; resultElementType: string; resultElementId: string }>
> {
  return attempt(() =>
    client.POST("/api/v1/care-plans/{planId}/change-proposals/{proposalId}/accept", {
      params: { path: { planId, proposalId } },
    }),
  );
}

/** Decline a pending proposal, optionally with a coded reason. */
export async function dismissProposal(
  client: ApiClient,
  planId: string,
  proposalId: string,
  reason?: DismissalReason,
): Promise<ProposalResult<{ proposalId: string; status: "dismissed" }>> {
  return attempt(() =>
    client.POST("/api/v1/care-plans/{planId}/change-proposals/{proposalId}/dismiss", {
      params: { path: { planId, proposalId } },
      body: reason ? { reason } : {},
    }),
  );
}

// ── the visit <-> plan-element links ────────────────────────────────────────────────────────────────────

/** The live links on a visit. */
export async function listVisitLinks(
  client: ApiClient,
  encounterId: string,
): Promise<ProposalResult<VisitLink[]>> {
  const res = await attempt<{ links?: VisitLink[] }>(() =>
    client.GET("/api/v1/encounters/{encounterId}/care-plan-links", {
      params: { path: { encounterId } },
    }),
  );
  return res.ok ? { ok: true, value: res.value?.links ?? [] } : res;
}

/** Say this visit addressed one plan element. Idempotent on the server: linking the same element again returns the live link. */
export async function addVisitLink(
  client: ApiClient,
  encounterId: string,
  target: VisitLinkTarget,
): Promise<ProposalResult<VisitLink>> {
  const res = await attempt<VisitLink>(() =>
    client.POST("/api/v1/encounters/{encounterId}/care-plan-links", {
      params: { path: { encounterId } },
      body: target,
    }),
  );
  // The server answers 422 for an element that does not fit this visit's type and discipline.
  return !res.ok && res.status === 422 ? { ...res, message: LINK_NOT_ALLOWED_COPY } : res;
}

/** Take the link off (a soft remove while the note is a draft). */
export async function removeVisitLink(
  client: ApiClient,
  encounterId: string,
  linkId: string,
): Promise<ProposalResult<undefined>> {
  return attempt(
    () =>
      client.DELETE("/api/v1/encounters/{encounterId}/care-plan-links/{linkId}", {
        params: { path: { encounterId, linkId } },
      }),
    LINK_NOT_FOUND_COPY,
  );
}
