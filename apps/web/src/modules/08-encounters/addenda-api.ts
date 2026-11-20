// apps/web/src/modules/08-encounters — the addendum access layer (GAP-027).
//
// The UI could OPEN an addendum (`POST .../addenda`) and then nothing could carry it further: the
// selections, finalize and sign routes had no caller, so an addendum opened in the UI stayed a draft
// forever. This file is those three callers plus the selections read they need.
//
// WHAT THE SERVER OWNS, WHICH NOTHING HERE RE-DECIDES.
//   • Who may act. `IS_ADDENDUM_AUTHOR` (GAP-028) compares the caller's membership to the addendum's
//     author. The client sends NO author or signer identity — only the attestation flag the sign route
//     validates — and enables an action from the addendum's server-returned `status`, never from a role.
//   • Step-up (D13). `STEP_UP_REQUIRED` is surfaced with its code so the panel can offer the real
//     `/step-up` screen; the message the server sent is shown, not replaced.
//   • The Layer-3 gate at finalize/sign. A 409/422 names what is missing and is shown verbatim.
import type { ApiClient, operations } from "@chartwarden/ui";
import { amendCreateRefusal } from "./amendment-model";
import type { AmendmentCosignStatus } from "./cosign-model";
import type { UpdateSelectionsBody } from "./encounters-api";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Ok<Op> = Op extends { responses: { 200: infer R } } ? Json<R> : never;

export type AddendumSelectionsView = Ok<
  operations["getApiV1EncountersByEncounterIdAddendaByAddendumIdSelections"]
>;

export type AddendumStatus = "draft" | "finalized" | "signed";

/** One addendum as `GET /encounters/:id` returns it. */
export interface AddendumRow {
  readonly id: string;
  readonly status: AddendumStatus;
  readonly reason: string;
  /** The author's membership id — displayed read-only, never sent back. */
  readonly authoredByUserId: string;
  readonly createdAt: string;
  readonly signedAt: string | null;
  readonly version: number;
  /** The sections of the signed note this addendum amends (ADR-0114 VN-D30); absent or empty = a free addendum. */
  readonly amendsSectionIds?: readonly string[];
  /** Where the cosignature of this amendment stands, when the API sends it (`not_required` unless its note needed a cosigner). */
  readonly cosignStatus?: AmendmentCosignStatus | null;
}

export type AddendumResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: number | null;
      readonly code: string | null;
      /** The server's message, verbatim; a generic fallback only when it sent none. */
      readonly message: string;
      /** The envelope's own `details` (the sections a stale sign names), when it sent any. */
      readonly details?: unknown;
    };

function failure(status: number | undefined, body: unknown): AddendumResult<never> {
  const err =
    body && typeof body === "object" && "error" in body
      ? (body as { error?: { code?: unknown; message?: unknown; details?: unknown } }).error
      : undefined;
  return {
    ok: false,
    status: typeof status === "number" ? status : null,
    code: typeof err?.code === "string" ? err.code : null,
    message:
      typeof err?.message === "string" && err.message.length > 0
        ? err.message
        : "The action could not be completed.",
    ...(err?.details === undefined ? {} : { details: err.details }),
  };
}

type Ids = { readonly encounterId: string; readonly addendumId: string };
const pathOf = ({ encounterId, addendumId }: Ids) => ({ path: { encounterId, addendumId } });

export async function loadAddendumSelections(
  client: ApiClient,
  ids: Ids,
): Promise<AddendumResult<AddendumSelectionsView>> {
  const { data, error, response } = await client.GET(
    "/api/v1/encounters/{encounterId}/addenda/{addendumId}/selections",
    { params: pathOf(ids) },
  );
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data };
}

/** The state of the cosignature request an amending addendum opened: `null` before any routing (404 for an addendum of another encounter or tenant). */
export async function loadAddendumCosignature(
  client: ApiClient,
  ids: Ids,
): Promise<AddendumResult<{ status: string | null }>> {
  const { data, error, response } = await client.GET(
    "/api/v1/encounters/{encounterId}/addenda/{addendumId}/cosignature",
    { params: pathOf(ids) },
  );
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data };
}

/** The WHOLE tree, with the `If-Match` version of the last read/save (the server requires the header but does not compare it: the last save wins; a finalized or signed addendum is 409 ILLEGAL_TRANSITION). */
export async function saveAddendumSelections(
  client: ApiClient,
  ids: Ids,
  version: number,
  body: UpdateSelectionsBody,
): Promise<AddendumResult<{ version: number; layer1Preview: string }>> {
  const { data, error, response } = await client.PATCH(
    "/api/v1/encounters/{encounterId}/addenda/{addendumId}/selections",
    { params: { ...pathOf(ids), header: { "If-Match": String(version) } }, body },
  );
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data };
}

export async function finalizeAddendum(
  client: ApiClient,
  ids: Ids,
): Promise<AddendumResult<{ status: "finalized" }>> {
  const { data, error, response } = await client.POST(
    "/api/v1/encounters/{encounterId}/addenda/{addendumId}/finalize",
    { params: pathOf(ids) },
  );
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data };
}

/**
 * Open an addendum on a signed note. With `amendsSectionIds` (1 to 12 sections of the note's own sealed rows) it is an amending addendum:
 * its author then confirms the redrafted sections before it can sign. A refusal that has a next step of its own (the draft switched off,
 * a section the note does not carry) comes back worded for the person; any other comes back as the server sent it.
 */
export async function openAddendum(
  client: ApiClient,
  encounterId: string,
  reason: string,
  amendsSectionIds: readonly string[],
): Promise<{ data?: unknown; error?: unknown; response: Response }> {
  const { data, error, response } = await client.POST("/api/v1/encounters/{encounterId}/addenda", {
    params: { path: { encounterId } },
    body:
      amendsSectionIds.length > 0
        ? { reason, amendsSectionIds: [...amendsSectionIds] }
        : { reason },
  });
  // A free addendum's refusals are the server's own: the amending wording would misname a missing note as a draft switch.
  if (!error || amendsSectionIds.length === 0) return { data, error, response };
  const code = (error as { error?: { code?: unknown } }).error?.code;
  const wording = amendCreateRefusal(response?.status, typeof code === "string" ? code : null);
  return {
    data,
    error: wording
      ? { error: { code: typeof code === "string" ? code : "REFUSED", message: wording } }
      : error,
    response,
  };
}

/** Sign. The body is the attestation flag only; who is signing is whoever the session is. */
export async function signAddendum(
  client: ApiClient,
  ids: Ids,
): Promise<
  AddendumResult<{
    status: "signed";
    signedAt: string;
    /** The sections an amending addendum changed; the cosignature request opened for it, if its note needed one. */
    amendedSectionIds?: string[];
    cosignatureRequestId?: string | null;
  }>
> {
  const { data, error, response } = await client.POST(
    "/api/v1/encounters/{encounterId}/addenda/{addendumId}/sign",
    { params: pathOf(ids), body: { attestationConfirmed: true } },
  );
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data };
}

// ── WP 3.7: proposals from secure messages (ADR-0063) ──────────────────────────────────────────────────
// A proposal is a pointer. The reviewer writes their OWN addendum reason; nothing from the message is prefilled or sent.
// Signing the addendum (the existing sign flow, with step-up) is the accept; declining is the only other outcome.

export type PromotionListView = Ok<operations["getApiV1EncountersByEncounterIdChartpromotions"]>;
export type PromotionProposalView = PromotionListView["promotions"][number];
export const PROMOTION_REJECT_REASONS = [
  "not_clinically_relevant",
  "already_documented",
  "duplicate",
  "wrong_patient",
  "other",
] as const;
export type PromotionRejectReason = (typeof PROMOTION_REJECT_REASONS)[number];

export async function loadEncounterPromotions(
  client: ApiClient,
  encounterId: string,
): Promise<AddendumResult<PromotionListView>> {
  const { data, error, response } = await client.GET(
    "/api/v1/encounters/{encounterId}/chart-promotions",
    { params: { path: { encounterId } } },
  );
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data };
}

/** Open a draft addendum linked to the proposal. `reason` is the reviewer's own words. */
export async function createAddendumFromPromotion(
  client: ApiClient,
  encounterId: string,
  reason: string,
  promotionRequestId: string,
): Promise<AddendumResult<{ id: string; status: "draft" }>> {
  const { data, error, response } = await client.POST("/api/v1/encounters/{encounterId}/addenda", {
    params: { path: { encounterId } },
    body: { reason, promotionRequestId },
  });
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as { id: string; status: "draft" } };
}

export async function rejectEncounterPromotion(
  client: ApiClient,
  encounterId: string,
  requestId: string,
  reasonCode: PromotionRejectReason,
): Promise<AddendumResult<{ promotionRequestId: string; outcome: "rejected" }>> {
  const { data, error, response } = await client.POST(
    "/api/v1/encounters/{encounterId}/chart-promotions/{requestId}/reject",
    { params: { path: { encounterId, requestId } }, body: { reasonCode } },
  );
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as { promotionRequestId: string; outcome: "rejected" } };
}
