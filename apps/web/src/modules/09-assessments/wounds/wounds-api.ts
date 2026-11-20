// apps/web/src/modules/09-assessments/wounds — the typed access layer for a patient's LONGITUDINAL wounds (M9).
//
// A patient has wounds; each visit adds dated observations to a wound; the visit note states the observations
// recorded at that encounter. Reads return the raw openapi-fetch result so the kit's `useLoad` can guard and
// refresh them; writes return a `WoundResult`, because every caller renders a refusal in place.
//
// WHAT THE SERVER OWNS, WHICH NOTHING HERE RE-DECIDES: the computed area and the percent change since the last
// measured visit (`areaCm2`, `areaChangePercent`), the rule that only a pressure injury carries a stage, and the
// append-only supersede of a correction. The form mirrors the rules only to keep most 422s from happening.
//
// IDEMPOTENCY. Registering a wound, recording an observation and correcting one DECLARE an `Idempotency-Key`, so each
// takes its key from the shared attempt keys, one per intent (route + patient + wound + body): the same key is kept
// across a lost reply, a gateway page and the in-flight 409, so a retry replays instead of writing twice, and any other
// answer renews it. A body that carries a per-attempt timestamp would never match its own retry: no write below sends
// `observedAt`. The server stamps it, and a correction keeps the original's. Resolving a wound is idempotent already and
// carries no key of its own (the client middleware supplies one).
import {
  type ApiClient,
  type OpsFailure,
  describeOpsError,
  type operations,
  sharedAttemptKeys,
} from "@chartwarden/ui";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Ok<Op> = Op extends { responses: { 200: infer R } }
  ? Json<R>
  : Op extends { responses: { 201: infer R } }
    ? Json<R>
    : never;
type ReqBody<Op> = Op extends { requestBody?: infer RB } ? Json<RB> : never;

type ListOp = operations["getApiV1PatientsByPatientIdWounds"];
type DetailOp = operations["getApiV1PatientsByPatientIdWoundsByWoundId"];
type RegisterOp = operations["postApiV1PatientsByPatientIdWounds"];
type ObserveOp = operations["postApiV1PatientsByPatientIdWoundsByWoundIdObservations"];
type CorrectOp =
  operations["postApiV1PatientsByPatientIdWoundsByWoundIdObservationsByObservationIdCorrections"];
type ResolveOp = operations["postApiV1PatientsByPatientIdWoundsByWoundIdResolve"];

export type WoundListResponse = Ok<ListOp>;
export type WoundListItem = WoundListResponse["wounds"][number];
export type WoundDetail = Ok<DetailOp>;
export type WoundView = WoundDetail["wound"];
export type WoundObservation = WoundDetail["observations"][number];

export type WoundStatusFilter = NonNullable<NonNullable<ListOp["parameters"]["query"]>["status"]>;
export type RegisterWoundBody = ReqBody<RegisterOp>;
export type RecordObservationBody = ReqBody<ObserveOp>;
export type CorrectObservationBody = ReqBody<CorrectOp>;
export type ResolveWoundBody = ReqBody<ResolveOp>;

export type WoundSiteCode = WoundView["siteCode"];
export type WoundLaterality = WoundView["laterality"];
export type WoundEtiology = WoundView["etiology"];
export type WoundAcquired = WoundView["acquired"];
export type WoundStatus = WoundView["status"];
export type PressureStage = NonNullable<WoundObservation["stage"]>;
export type WoundBedTissue = WoundObservation["woundBed"][number];
export type ExudateAmount = NonNullable<WoundObservation["exudateAmount"]>;
export type ExudateType = NonNullable<WoundObservation["exudateType"]>;
export type WoundOdor = NonNullable<WoundObservation["odor"]>;
export type PeriwoundCondition = WoundObservation["periwound"][number];
export type WoundDressing = NonNullable<WoundObservation["dressing"]>;
export type WoundTrend = NonNullable<WoundObservation["trend"]>;
export type CorrectionReason = CorrectObservationBody["correctionReason"];
export type WoundResolution = ResolveWoundBody["status"];

/** The outcome of one write: discriminated, because every caller shows the refusal beside the form. */
export type WoundResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: OpsFailure };

/**
 * The server's refusals in the words a clinician can act on. Keyed by error code; a code not listed falls back to the
 * server's own sentence (the envelope never carries record content) and then to the kit's generic copy for its kind.
 */
export const WOUND_ERROR_COPY: Readonly<Record<string, string>> = {
  WOUND_SITE_UNKNOWN: "That site is not on the site list. Choose a site from the list.",
  WOUND_SITE_LATERALITY_MISMATCH:
    "That side does not fit the site. Choose a side that applies to it, such as midline for the sacrum.",
  WOUND_ONSET_IN_FUTURE: "The onset date cannot be in the future.",
  WOUND_CLOSED_BEFORE_ONSET: "The date closed cannot be before the onset date.",
  WOUND_CLOSE_IN_FUTURE: "The date closed cannot be in the future.",
  WOUND_OBSERVED_IN_FUTURE:
    "An observation cannot be dated in the future. Check the clock on this device.",
  WOUND_OBSERVED_BEFORE_ONSET:
    "An observation cannot be dated before the wound's onset date. Check the date, or the onset date on the wound.",
  WOUND_OBSERVED_IMPLAUSIBLY_EARLY: "That date is before the year 2000. Check the date.",
  WOUND_NOT_IN_NOTE:
    "This visit's note has no skin and wounds section, so the observation would not appear in it. Record it without linking it to the visit.",
  WOUND_STAGE_NOT_APPLICABLE: "Only a pressure injury has a stage. Clear the stage.",
  WOUND_DEPTH_REQUIRES_AREA: "A depth needs both the length and the width.",
  WOUND_MEASUREMENT_RANGE:
    "A measurement is out of range. Length and width go up to 100 cm and depth up to 30 cm, with one decimal place.",
  WOUND_PAIN_RANGE: "Pain is a whole number from 0 to 10.",
  WOUND_DRESSING_REQUIRED: "Name the dressing that was applied.",
  WOUND_PERIWOUND_INTACT_EXCLUSIVE:
    "Intact skin around the wound cannot be combined with another finding.",
  WOUND_BED_DUPLICATE: "A wound bed finding is listed twice. Remove the duplicate.",
  WOUND_PERIWOUND_DUPLICATE:
    "A finding about the skin around the wound is listed twice. Remove the duplicate.",
  WOUND_NOT_OPEN: "This wound is already healed or resolved, so it takes no more observations.",
  STALE_VERSION:
    "Someone else changed this observation after you opened it. Reload it, then correct it again.",
  CORRECTION_TARGET_NOT_ACTIVE:
    "This observation was already corrected. Reload to see the current one.",
  VALIDATION_FAILED: "Some values were not accepted. Check the form and try again.",
};

const fail = (failure: OpsFailure): { ok: false; failure: OpsFailure } => ({ ok: false, failure });

interface SettleInput {
  readonly data?: unknown;
  readonly error?: unknown;
  readonly response?: Response;
}

async function settle<T>(request: Promise<SettleInput>): Promise<WoundResult<T>> {
  try {
    const { data, error, response } = await request;
    if (error !== undefined || data === undefined) {
      return fail(describeOpsError(error, response ?? null, WOUND_ERROR_COPY));
    }
    return { ok: true, value: data as T };
  } catch {
    // A rejected request (offline, a reset) is a failure the form can show, never an exception out of a click handler.
    return fail(describeOpsError(undefined, null, WOUND_ERROR_COPY));
  }
}

// ── reads (raw results for `useLoad`) ──────────────────────────────────────────────────────────────────────────

/** The patient's wounds, each with its latest observation. */
export const fetchWounds = (client: ApiClient, patientId: string, status: WoundStatusFilter) =>
  client.GET("/api/v1/patients/{patientId}/wounds", {
    params: { path: { patientId }, query: { status } },
  });

/** One wound with its observations, newest first, each with the computed area and percent change. */
export const fetchWound = (client: ApiClient, patientId: string, woundId: string) =>
  client.GET("/api/v1/patients/{patientId}/wounds/{woundId}", {
    params: { path: { patientId, woundId } },
  });

// ── writes ─────────────────────────────────────────────────────────────────────────────────────────────────────

export function registerWound(
  client: ApiClient,
  patientId: string,
  body: RegisterWoundBody,
): Promise<WoundResult<WoundView>> {
  return settle(
    sharedAttemptKeys.run(JSON.stringify(["wound:register", patientId, body]), (key) =>
      client.POST("/api/v1/patients/{patientId}/wounds", {
        params: { path: { patientId }, header: { "Idempotency-Key": key } },
        body,
      }),
    ),
  );
}

export function recordObservation(
  client: ApiClient,
  patientId: string,
  woundId: string,
  body: RecordObservationBody,
): Promise<WoundResult<WoundObservation>> {
  return settle(
    sharedAttemptKeys.run(JSON.stringify(["wound:observe", patientId, woundId, body]), (key) =>
      client.POST("/api/v1/patients/{patientId}/wounds/{woundId}/observations", {
        params: { path: { patientId, woundId }, header: { "Idempotency-Key": key } },
        body,
      }),
    ),
  );
}

/**
 * Correct an observation. NOT an edit: the server appends one that supersedes it and keeps both. `version` is the
 * observation's own, sent as `If-Match`; a 409 STALE_VERSION means it moved on since it was read.
 */
export function correctObservation(
  client: ApiClient,
  patientId: string,
  woundId: string,
  observation: { readonly id: string; readonly version: number },
  body: CorrectObservationBody,
): Promise<WoundResult<WoundObservation>> {
  const intent = JSON.stringify(["wound:correct", patientId, woundId, observation, body]);
  return settle(
    sharedAttemptKeys.run(intent, (key) =>
      client.POST(
        "/api/v1/patients/{patientId}/wounds/{woundId}/observations/{observationId}/corrections",
        {
          params: {
            path: { patientId, woundId, observationId: observation.id },
            header: { "If-Match": String(observation.version), "Idempotency-Key": key },
          },
          body,
        },
      ),
    ),
  );
}

/** Close the wound as healed or resolved for another reason. One-way. */
export function resolveWound(
  client: ApiClient,
  patientId: string,
  woundId: string,
  body: ResolveWoundBody,
): Promise<WoundResult<WoundView>> {
  return settle(
    client.POST("/api/v1/patients/{patientId}/wounds/{woundId}/resolve", {
      params: { path: { patientId, woundId } },
      body,
    }),
  );
}
