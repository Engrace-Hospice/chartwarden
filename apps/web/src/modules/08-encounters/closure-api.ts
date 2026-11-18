// apps/web/src/modules/08-encounters — the typed access layer of the closure screens (ADR-0113): the supervisor overdue board, the
// override grant / revoke, and the tenant policy. Every route is /api/v1/encounters/... on the generated client; this file only reads
// the wire and shapes a refusal, it decides nothing (the server owns the clock, the stage, the scope and the guards).
//
//   GET  overdue-notes?limit                     encounter.closure_override
//   POST closure-overrides                       encounter.closure_override + fresh step-up + Idempotency-Key (declared header)
//   POST closure-overrides/{id}/revoke           same guards; the shared client supplies the key
//   GET / PUT closure-policy                     encounter.closure_policy_admin (PUT: fresh step-up; the shared client supplies the key)
//
// A write whose reply is lost may or may not have landed: the grant runs under the screen's `useAttemptKey` so its retry carries the
// same key (docs/DEVELOPMENT.md "Idempotency keys in the UI"). A call that throws (offline) is status 0, never an exception.
import { type OpsFailure, describeOpsError } from "@chartwarden/ui";
import type { ApiClient, AttemptKey, operations } from "@chartwarden/ui";

/** The `application/json` payload of an openapi-fetch response/request-body slot. */
type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
/** The success body of operation `Op`: 200 or 201, whichever the route sends. */
type Ok<Op> = Op extends { responses: { 200: infer R } }
  ? Json<R>
  : Op extends { responses: { 201: infer R } }
    ? Json<R>
    : never;

export type OverdueBoardView = Ok<operations["getApiV1EncountersOverduenotes"]>;
export type OverdueNote = OverdueBoardView["items"][number];
export type ClosureOverrideView = Ok<operations["postApiV1EncountersClosureoverrides"]>;
export type ClosurePolicyView = Ok<operations["getApiV1EncountersClosurepolicy"]>;
export type ClosurePolicyInput = Pick<ClosurePolicyView, "mode" | "thresholdHours">;
export type CareTeamStaff = Ok<operations["getApiV1OrgsByIdCareteamstaff"]>["staff"][number];

/** The most the board asks for: the server's cap. `truncated` says when more matched, and the screen says so. */
export const OVERDUE_BOARD_LIMIT = 200;
/** The most staff the (best-effort) name lookup asks for: the route's cap. */
export const STAFF_NAME_LIMIT = 200;

/** A call's result: its data, or the status and the parsed error body. Status 0 = no answer (a thrown request). */
export type Outcome<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly error: unknown };

/** The sentences this feature gives a refusal, by server code (the envelope's own text is used for any code not listed). */
const REFUSAL_COPY: Readonly<Record<string, string>> = {
  FORBIDDEN:
    "That was refused. You cannot override your own note, and an override needs the supervisor permission.",
};

interface Settled<T> {
  readonly data?: T | undefined;
  readonly error?: unknown;
  readonly response?: { readonly status: number } | undefined;
}

function toOutcome<T>(result: Settled<T>): Outcome<T> {
  if (result.data !== undefined && !result.error) return { ok: true, data: result.data };
  return { ok: false, status: result.response?.status ?? 0, error: result.error };
}

const NO_ANSWER_OUTCOME = { ok: false, status: 0, error: null } as const;

/** A request that throws got no answer at all: the result is `status: 0`, so a screen never has to catch. */
async function settle<T>(send: () => Promise<Settled<T>>): Promise<Outcome<T>> {
  try {
    return toOutcome(await send());
  } catch {
    return NO_ANSWER_OUTCOME;
  }
}

export function loadOverdueNotes(
  client: ApiClient,
  limit: number = OVERDUE_BOARD_LIMIT,
): Promise<Outcome<OverdueBoardView>> {
  return settle(() =>
    client.GET("/api/v1/encounters/overdue-notes", { params: { query: { limit } } }),
  );
}

export interface GrantOverrideInput {
  readonly subjectMembershipId: string;
  readonly reason: string;
  readonly hours: number;
}

/**
 * Grant one clinician's closure override. The fingerprint is the whole intent (who, why, how long), so a retry of the SAME attempt after
 * a lost reply is sent under the same Idempotency-Key and an edit starts a new one. The reason is only ever hashed into that fingerprint.
 */
export async function grantOverride(
  client: ApiClient,
  attempt: AttemptKey,
  input: GrantOverrideInput,
): Promise<Outcome<ClosureOverrideView>> {
  const fingerprint = JSON.stringify([input.subjectMembershipId, input.reason, input.hours]);
  try {
    return toOutcome(
      await attempt.run(fingerprint, (key) =>
        client.POST("/api/v1/encounters/closure-overrides", {
          params: { header: { "Idempotency-Key": key } },
          body: {
            subjectMembershipId: input.subjectMembershipId,
            reason: input.reason,
            hours: input.hours,
          },
        }),
      ),
    );
  } catch {
    return NO_ANSWER_OUTCOME;
  }
}

export function revokeOverride(
  client: ApiClient,
  overrideId: string,
): Promise<Outcome<ClosureOverrideView>> {
  return settle(() =>
    client.POST("/api/v1/encounters/closure-overrides/{overrideId}/revoke", {
      params: { path: { overrideId } },
    }),
  );
}

export function loadClosurePolicy(client: ApiClient): Promise<Outcome<ClosurePolicyView>> {
  return settle(() => client.GET("/api/v1/encounters/closure-policy"));
}

export function saveClosurePolicy(
  client: ApiClient,
  input: ClosurePolicyInput,
): Promise<Outcome<ClosurePolicyView>> {
  return settle(() =>
    client.PUT("/api/v1/encounters/closure-policy", {
      body: { mode: input.mode, thresholdHours: input.thresholdHours },
    }),
  );
}

/** One request for the names of the clinicians on the board; a failure is silent (the board falls back to a short id). */
export function loadStaffNames(
  client: ApiClient,
  organizationId: string,
): Promise<Outcome<CareTeamStaff[]>> {
  return settle(async () => {
    const result = await client.GET("/api/v1/orgs/{id}/care-team-staff", {
      params: { path: { id: organizationId }, query: { limit: STAFF_NAME_LIMIT } },
    });
    return { data: result.data?.staff, error: result.error, response: result.response };
  });
}

/** What a refused write tells the person (kind, the sentence, and the per-field errors a 422 carries). */
export function describeRefusal(failure: { status: number; error: unknown }): OpsFailure {
  const response = failure.status === 0 ? null : { status: failure.status };
  return describeOpsError(failure.error, response, REFUSAL_COPY);
}
