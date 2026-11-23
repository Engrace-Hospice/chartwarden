// apps/web/src/modules/08-encounters — the typed access layer of the visit-note draft screens (ADR-0114, S1 PR D). Every route is on the
// generated client; this file reads the wire and shapes a refusal, it decides nothing (the server owns the draft, its hashes, the
// switch and the gate).
//
//   GET  /api/v1/encounters/{id}/draft                       the draft for the signed-in viewer, every template section with its state
//   PUT  /api/v1/encounters/{id}/draft/sections/{sectionId}  confirm or deselect one section against the content seen (hash + corpus)
//   GET  /api/v1/encounters/{id}/addenda/{addendumId}/draft  the same, for an amending addendum: only the sections it names (S1 PR E3)
//   PUT  /api/v1/encounters/{id}/addenda/{addendumId}/draft/sections/{sectionId}   confirm or deselect one of them
//   GET / PUT /api/v1/encounters/draft-policy                 the tenant's switch; PUT needs a fresh step-up and may be refused 409
//                                                             CORPUS_REVIEW_PENDING
//   GET / POST / DELETE /api/v1/encounters/{id}/care-plan-links   the visit's live care-plan links (the composer's picker)
//   GET  /api/v1/internal/care-plan/relevant-elements         the goals and interventions a visit may link
//   GET  /api/v1/encounters/{id}/discipline-plan-elements     (S4b) the goals and interventions of a social-work or chaplain visit's plan, kept or not
//   PUT  /api/v1/encounters/{id}/discipline-plan-elements/{elementId}   keep or leave out one of them
//   GET  /api/v1/encounters/{id}/idg-action-items             (S5b) the open IDG action items the viewer may follow up in an IDG follow-up visit
//   PUT  /api/v1/encounters/{id}/idg-action-item              link the visit to ONE of them, or clear the link (`null`; no key needed)
//   GET  /api/v1/patients/{id}/scales/{scale}/series          the score trend beside the note
//
// VN-D7: the draft carries source KINDS only (`origins`), never ids; nothing here asks for more. A call that throws (offline) is
// status 0, never an exception (closure-api.ts `settle`).
import { type OpsFailure, describeOpsError } from "@chartwarden/ui";
import type { ApiClient, operations } from "@chartwarden/ui";
import { type Outcome, settle } from "./closure-api";

/** The `application/json` payload of an openapi-fetch response slot. */
type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
/** The success body of operation `Op`: 200 or 201, whichever the route sends. */
type Ok<Op> = Op extends { responses: { 200: infer R } }
  ? Json<R>
  : Op extends { responses: { 201: infer R } }
    ? Json<R>
    : never;

export type DraftView = Ok<operations["getApiV1EncountersByEncounterIdDraft"]>;
export type AmendmentDraftView = Ok<
  operations["getApiV1EncountersByEncounterIdAddendaByAddendumIdDraft"]
>;
export type DraftSectionView = DraftView["sections"][number];
export type DraftSectionState = DraftSectionView["state"];
export type DraftOrigin = DraftSectionView["origins"][number];
export type Resolution = "confirmed" | "deselected";
export type DraftPolicyView = Ok<operations["getApiV1EncountersDraftpolicy"]>;
export type CarePlanLinksView = Ok<operations["getApiV1EncountersByEncounterIdCareplanlinks"]>;
export type CarePlanLink = CarePlanLinksView["links"][number];
export type RelevantElements = Ok<operations["getApiV1InternalCareplanRelevantelements"]>;
export type DisciplinePlanElementsView = Ok<
  operations["getApiV1EncountersByEncounterIdDisciplineplanelements"]
>;
export type DisciplinePlanElement = DisciplinePlanElementsView["elements"][number];
export type IdgActionItemsView = Ok<operations["getApiV1EncountersByEncounterIdIdgactionitems"]>;
export type IdgActionItem = IdgActionItemsView["items"][number];
export type ScaleSeries = Ok<operations["getApiV1PatientsByPatientIdScalesByScaleTypeSeries"]>;

export type { Outcome };

/** The two scales the draft has phrases for (PPS and ESAS-r), and so the two the trend shows. */
export const TREND_SCALES = ["pps", "esas_r"] as const;
export type TrendScale = (typeof TREND_SCALES)[number];

/** The sentences this feature gives a refusal, by server code (the envelope's own text is used for any code not listed). */
const REFUSAL_COPY: Readonly<Record<string, string>> = {
  CORPUS_REVIEW_PENDING:
    "The visit-note draft cannot be turned on yet: the platform's phrase wording has not completed its clinical review. Nothing was changed.",
  DRAFT_SECTION_STALE:
    "This section changed after you opened it, so nothing was recorded. Read the updated text, then confirm it again.",
  DRAFT_UNAVAILABLE:
    "The draft could not be checked right now. Nothing was changed. Try again in a moment.",
  IMMUTABLE_AFTER_SIGN: "This note is already signed and can no longer be changed.",
  UNKNOWN_TEMPLATE_SECTION:
    "That section is not one this addendum amends. Nothing was changed. Reload the page and try again.",
  ILLEGAL_TRANSITION:
    "This addendum is already signed or voided, so its sections can no longer be changed.",
  FORBIDDEN: "You do not have access to do that on this note.",
  DISCIPLINE_PLAN_LINK_LIMIT:
    "This visit has recorded as many changes to its plan items as it can hold, so nothing was changed. Tell your administrator if you need to change more.",
  IDG_ACTION_ITEM_LINK_LIMIT:
    "This visit has recorded as many changes to its IDG follow-up item as it can hold, so nothing was changed. Tell your administrator if you need to change more.",
};

/** A refusal that means "the section you saw is not the section there is now": the caller re-reads the draft. */
export const SECTION_STALE_CODE = "DRAFT_SECTION_STALE";
/** The refusal for switching the draft on while the phrase corpus awaits its clinical review. */
export const CORPUS_REVIEW_PENDING_CODE = "CORPUS_REVIEW_PENDING";

/** What a refused write tells the person (kind, the sentence, per-field errors). */
export function describeDraftRefusal(failure: { status: number; error: unknown }): OpsFailure {
  const response = failure.status === 0 ? null : { status: failure.status };
  return describeOpsError(failure.error, response, REFUSAL_COPY);
}

// ── the draft ──────────────────────────────────────────────────────────────────────────────────────────

export function loadDraft(client: ApiClient, encounterId: string): Promise<Outcome<DraftView>> {
  return settle(() =>
    client.GET("/api/v1/encounters/{encounterId}/draft", {
      params: { path: { encounterId } },
    }),
  );
}

/** Resolve one drafted section. The hash and corpus version are the ones the clinician saw; a section with none has nothing to resolve. */
export function resolveDraftSection(
  client: ApiClient,
  encounterId: string,
  section: Pick<DraftSectionView, "sectionId" | "contentHash" | "corpusVersion">,
  resolution: Resolution,
): Promise<Outcome<DraftSectionView>> {
  const { sectionId, contentHash, corpusVersion } = section;
  if (contentHash === null || corpusVersion === null) {
    return Promise.resolve({ ok: false, status: 0, error: null });
  }
  return settle(() =>
    client.PUT("/api/v1/encounters/{encounterId}/draft/sections/{sectionId}", {
      params: { path: { encounterId, sectionId } },
      body: { resolution, contentHash, corpusVersion },
    }),
  );
}

// ── an amending addendum's own draft (VN-D30) ──────────────────────────────────────────────────────────

/** The draft of the SIGNED note as the addendum's author sees it, restricted to the sections the addendum names. */
export function loadAmendmentDraft(
  client: ApiClient,
  encounterId: string,
  addendumId: string,
): Promise<Outcome<AmendmentDraftView>> {
  return settle(() =>
    client.GET("/api/v1/encounters/{encounterId}/addenda/{addendumId}/draft", {
      params: { path: { encounterId, addendumId } },
    }),
  );
}

/** Confirm or deselect one named section of an addendum's draft; same hash and corpus rules as the note's section. */
export function resolveAmendmentSection(
  client: ApiClient,
  encounterId: string,
  addendumId: string,
  section: Pick<DraftSectionView, "sectionId" | "contentHash" | "corpusVersion">,
  resolution: Resolution,
): Promise<Outcome<DraftSectionView>> {
  const { sectionId, contentHash, corpusVersion } = section;
  if (contentHash === null || corpusVersion === null) {
    return Promise.resolve({ ok: false, status: 0, error: null });
  }
  return settle(() =>
    client.PUT("/api/v1/encounters/{encounterId}/addenda/{addendumId}/draft/sections/{sectionId}", {
      params: { path: { encounterId, addendumId, sectionId } },
      body: { resolution, contentHash, corpusVersion },
    }),
  );
}

// ── the tenant's switch ────────────────────────────────────────────────────────────────────────────────

export function loadDraftPolicy(client: ApiClient): Promise<Outcome<DraftPolicyView>> {
  return settle(() => client.GET("/api/v1/encounters/draft-policy"));
}

export function saveDraftPolicy(
  client: ApiClient,
  enabled: boolean,
): Promise<Outcome<DraftPolicyView>> {
  return settle(() => client.PUT("/api/v1/encounters/draft-policy", { body: { enabled } }));
}

// ── the composer's care-plan picker ────────────────────────────────────────────────────────────────────

export interface PickerEncounter {
  readonly id: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly encounterType: string;
  readonly discipline: string;
}

export function loadRelevantElements(
  client: ApiClient,
  encounter: PickerEncounter,
): Promise<Outcome<RelevantElements>> {
  return settle(() =>
    client.GET("/api/v1/internal/care-plan/relevant-elements", {
      params: {
        query: {
          patientId: encounter.patientId,
          admissionId: encounter.admissionId,
          encounterType: encounter.encounterType,
          discipline: encounter.discipline,
        },
      },
    }),
  );
}

export function loadCarePlanLinks(
  client: ApiClient,
  encounterId: string,
): Promise<Outcome<CarePlanLinksView>> {
  return settle(() =>
    client.GET("/api/v1/encounters/{encounterId}/care-plan-links", {
      params: { path: { encounterId } },
    }),
  );
}

export type LinkTarget =
  | { readonly kind: "goal"; readonly id: string }
  | { readonly kind: "intervention"; readonly id: string };

export function linkCarePlanElement(
  client: ApiClient,
  encounterId: string,
  target: LinkTarget,
): Promise<Outcome<CarePlanLink>> {
  return settle(() =>
    client.POST("/api/v1/encounters/{encounterId}/care-plan-links", {
      params: { path: { encounterId } },
      body: target.kind === "goal" ? { goalId: target.id } : { interventionId: target.id },
    }),
  );
}

/**
 * Soft-remove a live link (a draft encounter only). The reply has no body, so success is the response's own status, made `data: true`
 * here: the client hands back `error: ""` (falsy) for a refusal with an empty body, which must not read as a removal.
 */
export function unlinkCarePlanElement(
  client: ApiClient,
  encounterId: string,
  linkId: string,
): Promise<Outcome<true>> {
  return settle(async () => {
    const result = await client.DELETE(
      "/api/v1/encounters/{encounterId}/care-plan-links/{linkId}",
      {
        params: { path: { encounterId, linkId } },
      },
    );
    return {
      data: result.response.ok ? (true as const) : undefined,
      error: result.error,
      response: result.response,
    };
  });
}

// ── the discipline's plan (S4b) ──────────────────────────────────────────────────────────────────────────

/** The goals and interventions of a social-work or chaplain visit's plan, each with whether the visit keeps it. */
export function loadDisciplinePlanElements(
  client: ApiClient,
  encounterId: string,
): Promise<Outcome<DisciplinePlanElementsView>> {
  return settle(() =>
    client.GET("/api/v1/encounters/{encounterId}/discipline-plan-elements", {
      params: { path: { encounterId } },
    }),
  );
}

/** Keep one element in the visit's statement of the plan (`included`) or leave it out. The answer is the whole updated list. */
export function setDisciplinePlanElement(
  client: ApiClient,
  encounterId: string,
  elementId: string,
  included: boolean,
): Promise<Outcome<DisciplinePlanElementsView>> {
  return settle(() =>
    client.PUT("/api/v1/encounters/{encounterId}/discipline-plan-elements/{elementId}", {
      params: { path: { encounterId, elementId } },
      body: { included },
    }),
  );
}

// ── the IDG follow-up's action item (S5b) ───────────────────────────────────────────────────────────────

/** The stable code of the 403 the two IDG routes answer a viewer without the `idg.act` key (the message names the key; the code is what is matched). */
const IDG_ACTION_PERMISSION_REQUIRED_CODE = "IDG_ACTION_PERMISSION_REQUIRED";

/** Whether a refusal is the missing-`idg.act` one. Matched on the error's CODE, never on its message text. */
export function isIdgActionPermissionRefusal(error: unknown): boolean {
  const code = (error as { error?: { code?: unknown } } | null | undefined)?.error?.code;
  return code === IDG_ACTION_PERMISSION_REQUIRED_CODE;
}

/** The open IDG action items the viewer may follow up in this visit (an IDG follow-up visit only), the linked one marked. Facts only, never a title. */
export function loadIdgActionItems(
  client: ApiClient,
  encounterId: string,
): Promise<Outcome<IdgActionItemsView>> {
  return settle(() =>
    client.GET("/api/v1/encounters/{encounterId}/idg-action-items", {
      params: { path: { encounterId } },
    }),
  );
}

/**
 * Link the visit to ONE action item, or clear the link (`null`). Linking answers the whole updated list; clearing needs no key and no M14 and answers an empty list
 * that is NOT the list the viewer is handed, so the caller reads it again.
 */
export function setIdgActionItem(
  client: ApiClient,
  encounterId: string,
  actionItemId: string | null,
): Promise<Outcome<IdgActionItemsView>> {
  return settle(() =>
    client.PUT("/api/v1/encounters/{encounterId}/idg-action-item", {
      params: { path: { encounterId } },
      body: { actionItemId },
    }),
  );
}

// ── the score trend ────────────────────────────────────────────────────────────────────────────────────

export function loadScaleSeries(
  client: ApiClient,
  patientId: string,
  scaleType: TrendScale,
  window: { readonly from: string; readonly to: string },
): Promise<Outcome<ScaleSeries>> {
  return settle(() =>
    client.GET("/api/v1/patients/{patientId}/scales/{scaleType}/series", {
      params: { path: { patientId, scaleType }, query: window },
    }),
  );
}
