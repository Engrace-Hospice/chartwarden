// apps/web/src/modules/08-encounters — the M8 AUTHORING access layer the §5.2 composer uses
// (Track B / ADR-0030; #91).
//
// M8's sign / acknowledge / cosign-sign / supervisor-release ceremonies were already built
// (`encounter-read.tsx`, TASK-031). What was missing is the one #91's title names: the staff app could
// read and SIGN a clinical record and could not AUTHOR one. A visit note is the highest-volume artifact
// in a hospice EHR, the CoP documentation of the visit, and the substantiation behind the claim.
//
// THE BLOCKER WAS NOT THE WRITE ROUTE. `PATCH /api/v1/encounters/:id/selections` has been mounted,
// guarded and contract-enriched since M8-T09, and #114 fixed it actually persisting. It carries
// `sectionId` and `code` as free strings and the server REJECTS an unknown one — so a composer needs to
// know which sections the encounter's template has and which vocabulary codes each accepts. Both have
// existed as pure leaf packages since M8-T05 (`@chartwarden/hearthnote`'s `resolveTemplate`,
// `@chartwarden/narrative-vocab`'s `entriesFor` — whose own header calls it "the entries a menu surfaces …
// so the selection UI and the template engine see the same deterministic ordering"). Neither was ever
// on the wire, so there was no selection UI for them to agree with. `GET .../template` (F-063) is that
// menu, and this file consumes it rather than shipping a second copy of the corpus to the browser: the
// resolution rules the menu is built from are the same ones `assembleSelections` enforces on the way
// back in, and a client-side copy would be free to disagree with them.
//
// WHAT THE SERVER OWNS, WHICH NOTHING HERE RE-DECIDES.
//
//   • §7.7 OPTIMISTIC CONCURRENCY. `PATCH .../selections` takes `If-Match` as a TYPED HEADER PARAM, so
//     forgetting it does not compile. The version comes from the read; a 412 means someone else saved
//     first, which on a shared draft is ordinary rather than exceptional.
//   • §2.6 THE LAYER-3 GATE. Whether a note may finalize — required sections filled, vitals present,
//     late-entry tier — is the server's. The composer shows which sections are `required` because a
//     clinician needs to know before they try; it never pre-empts the refusal.
//   • The Layer-1 NARRATIVE. `layer1Preview` comes back from the read and from every PATCH: the note as
//     it currently reads, assembled deterministically server-side. The composer never assembles prose.
//   • §2.2 the encounter lifecycle, and the late-entry tier the service date implies.
import { ENCOUNTER_DISCIPLINE_RULES } from "@chartwarden/types";
import type { ApiClient, operations } from "@chartwarden/ui";

// ── schema-derived type extraction (the four helpers every module's api layer uses) ─────────────────────

/** The `application/json` payload of an openapi-fetch response/request-body slot. */
type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
/** The success body of operation `Op` — 200 or 201, whichever the route actually sends. */
type Ok<Op> = Op extends { responses: { 200: infer R } }
  ? Json<R>
  : Op extends { responses: { 201: infer R } }
    ? Json<R>
    : never;
/** The request body of operation `Op`. */
type ReqBody<Op> = Op extends { requestBody?: infer RB } ? Json<RB> : never;

// ── wire shapes ────────────────────────────────────────────────────────────────────────────────────────

export type EncounterView = Ok<operations["getApiV1EncountersByEncounterId"]>;
export type TemplateView = Ok<operations["getApiV1EncountersByEncounterIdTemplate"]>;
export type TemplateSection = TemplateView["sections"][number];
export type MenuEntry = TemplateSection["entries"][number];
export type SelectionsView = Ok<operations["getApiV1EncountersByEncounterIdSelections"]>;
export type SelectionSection = SelectionsView["sections"][number];
export type VitalsListView = Ok<operations["getApiV1EncountersByEncounterIdVitals"]>;
export type MileageView = Ok<operations["getApiV1EncountersByEncounterIdMileage"]>;

export type CreateEncounterBody = ReqBody<operations["postApiV1Encounters"]>;
export type UpdateSelectionsBody = ReqBody<
  operations["patchApiV1EncountersByEncounterIdSelections"]
>;
export type CaptureVitalsBody = ReqBody<operations["postApiV1EncountersByEncounterIdVitals"]>;
export type CaptureMileageBody = ReqBody<operations["postApiV1EncountersByEncounterIdMileage"]>;
export type EvvReconcileBody = ReqBody<operations["postApiV1EncountersByEncounterIdEvvreconcile"]>;

/** The §2.2 encounter taxonomy the server accepts. Derived, so a vocabulary change breaks the build. */
export type EncounterType = CreateEncounterBody["encounterType"];
/** The §2.2 authoring disciplines. */
export type EncounterDiscipline = CreateEncounterBody["discipline"];
/** The mileage provenance the server accepts (`odometer` | `route_calc` | `manual_override`). */
export type MileageSource = CaptureMileageBody["source"];

// ── §2.2 the (encounter type × discipline) matrix, and the caller's own half of it (F-083) ────────────
//
// `ENCOUNTER_DISCIPLINE_RULES` is the ONE declaration of which discipline may author which encounter
// type — read by the server's `checkEncounterDisciplinePair` (422 `INVALID_ENCOUNTER_DISCIPLINE_PAIR`),
// by the DB CHECK behind it, and by the HearthNote template registry, which builds a template for every
// legal pair and none for an illegal one. Imported rather than re-typed here for exactly that reason: a
// second copy could offer a pair with no template, i.e. an encounter that creates and then cannot be
// composed.
//
// The `satisfies` pin is what keeps the two vocabularies in step. The types above are derived from the
// generated OpenAPI client, `ENCOUNTER_DISCIPLINE_RULES` from `@chartwarden/types`; they are the same
// vocabulary by construction and NOTHING checked that. A route that gained an encounter type would
// leave this map short of a key, and the composer would silently stop offering it.
const DISCIPLINE_RULES = ENCOUNTER_DISCIPLINE_RULES satisfies {
  readonly [K in EncounterType]: readonly EncounterDiscipline[];
};

/** The disciplines that may author `encounterType` (§2.2). */
export function legalDisciplinesFor(encounterType: EncounterType): readonly EncounterDiscipline[] {
  return DISCIPLINE_RULES[encounterType];
}

/**
 * The caller's clinical disciplines, derived from their M3 role keys.
 *
 * The `discipline-derivation.test.ts` rule: "M3's `RoleGrant.roleKey` is the platform's one
 * authority-derivation input" (M19's `TRIAGE_DISCIPLINE_FOR_ROLE_KEY` states it, M17's
 * `resolveDisciplinesTx` implements it, M10's `authorDisciplinesForRoles` is the same intersection one
 * vocabulary over). A role key that is not a discipline (`rn_case_manager`, `administrator`) simply
 * does not intersect, which is why this is an intersection and not a lookup table.
 *
 * NOT a check — the server decides. This exists so the modal offers the caller pairs that can succeed
 * rather than a menu whose other entries only ever produce a 403.
 */
export function disciplinesForRoles(roles: readonly string[]): readonly EncounterDiscipline[] {
  const held = new Set(roles.map((r) => r.toLowerCase()));
  const all = new Set<EncounterDiscipline>();
  for (const ds of Object.values(DISCIPLINE_RULES)) for (const d of ds) all.add(d);
  return [...all].filter((d) => held.has(d));
}

/** The encounter types at least one of `disciplines` may author, in the §2.2 declaration order. */
export function encounterTypesForDisciplines(
  disciplines: readonly EncounterDiscipline[],
): readonly EncounterType[] {
  return (Object.keys(DISCIPLINE_RULES) as EncounterType[]).filter((k) =>
    DISCIPLINE_RULES[k].some((d) => disciplines.includes(d)),
  );
}

/**
 * The outcome of one write. A DISCRIMINATED result rather than a thrown error: a clinician composing a
 * note at a bedside has to see the failure where they are looking, and several of these failures are
 * controls working rather than bugs.
 */
export type WriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: number | null;
      readonly code: string | null;
      readonly message: string;
      readonly details: unknown;
    };

/**
 * Turn an openapi-fetch error into copy a clinician can act on.
 *
 * The §2.7 assembly codes are named rather than flattened: `UNKNOWN_TEMPLATE_SECTION` and
 * `UNKNOWN_VOCAB_CODE` mean the composer sent something the template or corpus does not have, which is
 * a client bug the clinician should not be asked to interpret; `VOCAB_VERSION_MISMATCH` (D11) means the
 * corpus moved under a draft and the note must be reloaded before it can be saved again.
 */
function failure(status: number | undefined, body: unknown): WriteResult<never> {
  const httpStatus = typeof status === "number" ? status : null;
  const err =
    body && typeof body === "object" && "error" in body
      ? (body as { error?: { code?: unknown; message?: unknown; details?: unknown } }).error
      : undefined;
  const detail = typeof err?.message === "string" ? err.message : null;
  const code = typeof err?.code === "string" ? err.code : null;
  const message =
    code === "VOCAB_VERSION_MISMATCH"
      ? "The clinical vocabulary was updated while this note was open. Reload it before saving again — the wording of an already-selected phrase may have changed."
      : code === "UNKNOWN_TEMPLATE_SECTION" || code === "UNKNOWN_VOCAB_CODE"
        ? (detail ??
          "This note referenced something its template does not contain. Reload and try again.")
        : httpStatus === 412
          ? "Someone else saved this note after you opened it. Reload to pick up their changes — saving now would discard them."
          : httpStatus === 403
            ? (detail ?? "Your role is not permitted to author on this encounter.")
            : httpStatus === 409
              ? (detail ?? "This encounter changed before your action was applied.")
              : httpStatus === 404
                ? "That encounter is no longer available to you."
                : httpStatus === 422
                  ? (detail ?? "The server rejected the details supplied.")
                  : (detail ?? "The action could not be completed.");
  return { ok: false, status: httpStatus, code, message, details: err?.details };
}

const ok = <T>(value: T): WriteResult<T> => ({ ok: true, value });

// ── reads the composer needs ───────────────────────────────────────────────────────────────────────────

/** The authoring menu: the encounter's template sections and the vocabulary each accepts (F-063). */
export async function loadTemplate(
  client: ApiClient,
  encounterId: string,
): Promise<TemplateView | null> {
  const { data } = await client.GET("/api/v1/encounters/{encounterId}/template", {
    params: { path: { encounterId } },
  });
  return (data ?? null) as TemplateView | null;
}

/** The stored selection tree plus its assembled Layer-1 narrative and the version `If-Match` needs. */
export async function loadSelections(
  client: ApiClient,
  encounterId: string,
): Promise<SelectionsView | null> {
  const { data } = await client.GET("/api/v1/encounters/{encounterId}/selections", {
    params: { path: { encounterId } },
  });
  return (data ?? null) as SelectionsView | null;
}

/** Every vitals set on the encounter, newest capture first (#92). */
export async function loadVitals(
  client: ApiClient,
  encounterId: string,
): Promise<VitalsListView | null> {
  const { data } = await client.GET("/api/v1/encounters/{encounterId}/vitals", {
    params: { path: { encounterId } },
  });
  return (data ?? null) as VitalsListView | null;
}

/** The encounter's mileage row, or null when none was recorded (F-063). */
export async function loadMileage(
  client: ApiClient,
  encounterId: string,
): Promise<MileageView | null> {
  const { data } = await client.GET("/api/v1/encounters/{encounterId}/mileage", {
    params: { path: { encounterId } },
  });
  return (data ?? null) as MileageView | null;
}

// ── authoring writes ───────────────────────────────────────────────────────────────────────────────────

/**
 * The patient's admissions, newest first — the `admissionId` `POST /api/v1/encounters` requires.
 *
 * The same route M12 had to add for the same reason (F-065): the org-wide census takes no patient
 * filter and its items carry no `patientId`, so nothing else in the app can answer "which admission is
 * this patient on". Read here rather than threaded down as a prop, so the modal is self-contained.
 */
export async function loadPatientAdmissions(
  client: ApiClient,
  patientId: string,
): Promise<
  { id: string; state: string; admissionAt: string | null; dischargedAt: string | null }[]
> {
  const { data } = await client.GET("/api/v1/patients/{patientId}/admissions", {
    params: { path: { patientId } },
  });
  return (data?.items ?? []) as {
    id: string;
    state: string;
    admissionAt: string | null;
    dischargedAt: string | null;
  }[];
}

/** §2.2 — open a draft encounter. The server derives the template and the late-entry tier from it. */
export async function createDraft(
  client: ApiClient,
  body: CreateEncounterBody,
): Promise<WriteResult<{ id: string; status: string; templateKey: string; version: number }>> {
  const { data, error, response } = await client.POST("/api/v1/encounters", { body });
  if (error || !data) return failure(response?.status, error);
  return ok(data as { id: string; status: string; templateKey: string; version: number });
}

/**
 * §2.6 — save the selection tree. The WHOLE tree, every time: `PATCH .../selections` replaces it rather
 * than merging, which is what makes deselecting an entry expressible at all.
 *
 * `If-Match` is a TYPED header param on this operation, so omitting it does not compile. The version is
 * whatever the last read or save returned; a 412 means someone else saved first.
 */
export async function saveSelections(
  client: ApiClient,
  encounterId: string,
  version: number,
  body: UpdateSelectionsBody,
): Promise<WriteResult<{ version: number; layer1Preview: string }>> {
  const { data, error, response } = await client.PATCH(
    "/api/v1/encounters/{encounterId}/selections",
    {
      params: { path: { encounterId }, header: { "If-Match": String(version) } },
      body,
    },
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data as { version: number; layer1Preview: string });
}

/** §2.2 — record a vitals set. Every field is optional; the server validates envelopes and the CNI reason. */
export async function captureVitals(
  client: ApiClient,
  encounterId: string,
  body: CaptureVitalsBody,
): Promise<WriteResult<{ vitalsId: string }>> {
  const { data, error, response } = await client.POST("/api/v1/encounters/{encounterId}/vitals", {
    params: { path: { encounterId } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data as { vitalsId: string });
}

/** D10 — record travel. `source` is provenance the payroll seam reads, not a formality. */
export async function captureMileage(
  client: ApiClient,
  encounterId: string,
  body: CaptureMileageBody,
): Promise<WriteResult<{ mileageId: string; milesDriven: string; source: string }>> {
  const { data, error, response } = await client.POST("/api/v1/encounters/{encounterId}/mileage", {
    params: { path: { encounterId } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data as { mileageId: string; milesDriven: string; source: string });
}

/**
 * §2.2 — finalize the draft (Layer-3 gate). The SERVER decides whether the note is complete: required
 * sections filled, the §2.6 checks, the late-entry tier. A refusal here is the gate working and is
 * rendered verbatim, because it names exactly what is missing.
 */
export async function finalizeEncounter(
  client: ApiClient,
  encounterId: string,
  lateEntryReason?: string,
): Promise<WriteResult<{ status: string; version: number }>> {
  // GAP-013: `lateEntryReason` is required server-side only when the note is documented > 24h after the visit.
  const { data, error, response } = await client.POST("/api/v1/encounters/{encounterId}/finalize", {
    params: { path: { encounterId } },
    body: { lateEntryReason },
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data as { status: string; version: number });
}

/** D9 — document why EVV brackets are missing, when the visit was not captured electronically. */
export async function documentEvvMissing(
  client: ApiClient,
  encounterId: string,
  evvMissingReason: string,
): Promise<WriteResult<{ evvBracketState: string }>> {
  const { data, error, response } = await client.POST(
    "/api/v1/encounters/{encounterId}/evv-reconcile",
    { params: { path: { encounterId } }, body: { evvMissingReason } as EvvReconcileBody },
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data as { evvBracketState: string });
}

// ── selection-tree helpers (pure) ──────────────────────────────────────────────────────────────────────

/** The `params` an entry needs, keyed by slot — empty when the phrase interpolates nothing extra. */
export type EntryParams = Record<string, string | number>;

/** One entry as the composer holds it before it becomes a wire `entries[]` item. */
export interface DraftEntry {
  readonly code: string;
  readonly params: EntryParams;
}

/** The composer's working state: section id → selected entries + free text. */
export interface DraftSections {
  [sectionId: string]: { entries: DraftEntry[]; freeText: string };
}

/** Read a stored selection tree into the composer's working shape. */
export function toDraft(sections: readonly SelectionSection[]): DraftSections {
  const out: DraftSections = {};
  for (const s of sections) {
    out[s.sectionId] = {
      entries: s.entries.map((e) => ({ code: e.code, params: (e.params ?? {}) as EntryParams })),
      freeText: s.freeText ?? "",
    };
  }
  return out;
}

/**
 * Turn the composer's working state into the PATCH body.
 *
 * Sections with no entries AND no free text are dropped rather than sent empty: the server stores what
 * it is given and `assembleLayer1` omits empty sections from the narrative, so sending them would
 * persist rows that can never render. A section carrying only free text IS sent — verbatim prose is
 * content, and assembly preserves it exactly.
 */
export function toSelectionsBody(draft: DraftSections): UpdateSelectionsBody {
  const sections = Object.entries(draft)
    .filter(([, v]) => v.entries.length > 0 || v.freeText.trim().length > 0)
    .map(([sectionId, v]) => ({
      sectionId,
      entries: v.entries.map((e) =>
        Object.keys(e.params).length > 0 ? { code: e.code, params: e.params } : { code: e.code },
      ),
      ...(v.freeText.trim().length > 0 ? { freeText: v.freeText.trim() } : {}),
    }));
  return { sections } as UpdateSelectionsBody;
}

/** Which required sections are still empty — shown to the author, never used to block the request. */
export function unmetRequiredSections(
  template: TemplateView,
  draft: DraftSections,
): readonly string[] {
  return template.sections
    .filter((s) => s.required)
    .filter((s) => {
      const d = draft[s.sectionId];
      return !d || (d.entries.length === 0 && d.freeText.trim().length === 0);
    })
    .map((s) => s.heading);
}
