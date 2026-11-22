// apps/backend/src/modules/08-encounters/drafting/draft-service.ts — the service behind the visit-note draft routes (S1 PR C2b1;
// ADR-0114). Reads the draft for the SESSION viewer and resolves one section at a time.
//
// EVERY method answers 404 (the same `NotFoundError("encounter")` an absent encounter gets, so the switch is no existence oracle)
// when the tenant has the draft switched off, BEFORE it loads the encounter or reads any source: a tenant with the switch off sees
// today's behaviour exactly (VN-D17). The viewer's roles and membership come from the server-assembled session, never the request.
import type { AuditContext } from "@chartwarden/audit";
import { ForbiddenError, NotFoundError } from "@chartwarden/types";
import { EncounterStateError } from "../lifecycle/errors";
import { checkMutableForEdit } from "../lifecycle/validation";
import { assertMayReadAdmissionFacts } from "./admission-reads";
import {
  computeDraftOverview,
  snapshotDisciplinePlanPorts,
  snapshotIdgFollowUpPorts,
  snapshotStorePorts,
} from "./compute";
import { defaultDraftPorts } from "./default-ports";
import {
  type DisciplinePlanElementsView,
  assertDraftsFromDisciplinePlan,
  disciplinePlanElementsView,
} from "./discipline-plan-elements";
import type { AmendmentRef, DraftEncounterRow, DraftUnit, RunInOrg } from "./draft-store";
import {
  type AmendmentDraftView,
  type DraftSectionView,
  type DraftView,
  amendmentDraftView,
  draftView,
} from "./draft-view";
import {
  type IdgFollowUpItemsView,
  assertDraftsFromIdgFollowUp,
  assertMayReadIdgItems,
  idgFollowUpItemsView,
  mayReadIdgItems,
  readIdgFollowUpCandidates,
} from "./idg-follow-up";
import { readDisciplinePlanElements } from "./inputs";
import type { DraftPorts, DraftSeamPorts, DraftViewer } from "./ports";
import { resolveSection } from "./resolve-section";
import { serialSeams } from "./serial-seams";
import { assertMayReadSourceDomains } from "./source-reads";
import { guarded } from "./unavailable";
import { visitAsOf } from "./visit-time";

/** The authenticated caller of a draft route, from the server-assembled session. */
export interface DraftCaller {
  readonly organizationId: string;
  readonly userId: string;
  readonly roles: readonly string[];
  /** The active membership id, or `null` when the session carries none (a read then fails closed against a Part 2 release). */
  readonly membershipId: string | null;
  /**
   * The permission keys the session resolves to: the draft asks the read key of each source domain its template reads (`source-reads.ts`, S3), and
   * the draft of a recertification, face-to-face or admission visit the admission facts' keys too (`admission-reads.ts`).
   */
  readonly permissions: ReadonlySet<string>;
}

export interface ResolveSectionRequest {
  readonly resolution: "confirmed" | "deselected";
  /** What the clinician saw: the section's content hash and the phrase-corpus version of the draft. */
  readonly contentHash: string;
  readonly corpusVersion: string;
}

export interface DraftService extends AmendmentDraftService {
  getDraft(caller: DraftCaller, encounterId: string): Promise<DraftView>;
  /** Needs a membership (the confirmation is attributed to it). Writes inside one transaction and records the explicit audit event. */
  resolveSection(
    caller: DraftCaller & { readonly membershipId: string },
    encounterId: string,
    sectionId: string,
    body: ResolveSectionRequest,
    audit: AuditContext,
  ): Promise<DraftSectionView>;
  /**
   * S4b (VN-D60): the goals and interventions of the discipline's plan in effect at the visit, as the calling viewer is handed them, each with whether
   * the visit keeps it. Only for a visit drafted from the discipline's plan (a social worker's or a chaplain's); 404 for a tenant with the draft off.
   */
  getDisciplinePlanElements(
    caller: DraftCaller,
    encounterId: string,
  ): Promise<DisciplinePlanElementsView>;
  /**
   * S4b: keeps one element in the visit's statement of the plan (`included: true`) or leaves it out. Idempotent; the encounter row is locked first, as a
   * section's resolution does. An element the viewer is not handed (absent, or Part 2 without disclosure) is the same 404.
   */
  setDisciplinePlanElement(
    caller: DraftCaller & { readonly membershipId: string },
    encounterId: string,
    elementId: string,
    body: { readonly included: boolean },
    audit: AuditContext,
  ): Promise<DisciplinePlanElementsView>;
  /**
   * S5b (VN-D64 to VN-D67): the open IDG action items the calling viewer may link an IDG follow-up visit to (assigned to them, for the visit's patient,
   * linked to an encounter), with the linked one marked. M14 decides Part 2 per viewer and hands a viewer it does not clear nothing for a flagged patient.
   * Needs `idg.read` (403 naming it); only for an IDG follow-up visit (422 otherwise); 404 for a tenant with the draft off.
   */
  getIdgActionItems(caller: DraftCaller, encounterId: string): Promise<IdgFollowUpItemsView>;
  /**
   * S5b: links the visit to one action item (`actionItemId`) or clears the link (`null`). Idempotent; the encounter row is locked first. An item the viewer is
   * not handed (absent, closed, another patient's, Part 2 without disclosure) is the same 404.
   */
  setIdgActionItem(
    caller: DraftCaller & { readonly membershipId: string },
    encounterId: string,
    body: { readonly actionItemId: string | null },
    audit: AuditContext,
  ): Promise<IdgFollowUpItemsView>;
}

export interface AmendmentDraftService {
  /**
   * The draft of the signed note as the addendum's author sees it as of the visit time, restricted to the sections the addendum names (VN-D30),
   * each against the addendum's own resolutions. The addendum's AUTHOR alone (403 for anyone else, a free addendum's included); 404 for the author's
   * free addendum (it names nothing) and for a tenant with the draft off.
   */
  getAmendmentDraft(
    caller: DraftCaller,
    encounterId: string,
    addendumId: string,
  ): Promise<AmendmentDraftView>;
  /**
   * The addendum's author confirms or deselects one section it names, bound to the content hash and corpus version they saw (VN-D12). The encounter
   * row is locked first, as the note's own resolution and the addendum's sign do. A signed or voided addendum, and anyone but its author, are refused.
   */
  resolveAmendmentSection(
    caller: DraftCaller & { readonly membershipId: string },
    encounterId: string,
    addendumId: string,
    sectionId: string,
    body: ResolveSectionRequest,
    audit: AuditContext,
  ): Promise<DraftSectionView>;
}

export interface DraftServiceDeps {
  readonly runInOrg: RunInOrg;
  /** The seam-backed half of the draft ports (M7, M9, M12, M39); defaults to the M1-registry wiring. Injected by tests. */
  readonly seams?: () => DraftSeamPorts;
  readonly now?: () => Date;
}

async function loadOr404(
  unit: DraftUnit,
  encounterId: string,
  forUpdate: boolean,
  caller: DraftCaller,
): Promise<DraftEncounterRow> {
  if (!(await unit.enabled())) throw new NotFoundError("encounter");
  const encounter = await unit.encounter(encounterId, forUpdate);
  if (encounter === null) throw new NotFoundError("encounter");
  // After the switch and the tenant are known, so the refusal is no oracle for either; before any source is read.
  assertMayReadAdmissionFacts(encounter.encounterType, caller.permissions);
  assertMayReadSourceDomains(encounter.encounterType, encounter.discipline, caller.permissions);
  return encounter;
}

async function loadAmendmentOr404(
  unit: DraftUnit,
  encounterId: string,
  addendumId: string,
): Promise<AmendmentRef> {
  const amendment = await unit.amendment(encounterId, addendumId);
  if (amendment === null || amendment.sectionIds.length === 0) throw new NotFoundError("addendum");
  return amendment;
}

/**
 * The amendment draft is its AUTHOR's view: the sections an addendum names say what it amends. Anyone else is refused 403 whether the addendum is
 * free or amending (so the refusal is no oracle for which addenda name sections), BEFORE the sections are looked at. The route gates it with the
 * same rule (`is_addendum_author`); this is the service not relying on that. An absent addendum stays 404: only its author reaches here.
 */
async function loadAuthoredAmendmentOr404(
  unit: DraftUnit,
  encounterId: string,
  addendumId: string,
  caller: DraftCaller,
): Promise<AmendmentRef> {
  const amendment = await unit.amendment(encounterId, addendumId);
  if (amendment === null) throw new NotFoundError("addendum");
  if (caller.membershipId === null || amendment.authoredByMembershipId !== caller.membershipId) {
    throw new ForbiddenError(
      "only the author of an addendum may read the draft of its amended sections",
    );
  }
  if (amendment.sectionIds.length === 0) throw new NotFoundError("addendum");
  return amendment;
}

/**
 * The viewer a draft is computed for: the session's roles and membership, and the permission keys it resolves to (the draft asks `idg.read` itself, for
 * the IDG follow-up's own section alone: S5b, VN-D66).
 */
const viewerOf = (caller: DraftCaller): DraftViewer => ({
  roles: caller.roles,
  membershipId: caller.membershipId,
  permissions: caller.permissions,
});

/** The visit time the draft is built as of (the end of the service date in the organization's zone, capped at now), by the same rule and the same failure code. */
async function visitTimeOf(
  encounter: DraftEncounterRow,
  store: Pick<DraftPorts, "organizationTimeZone">,
  now: Date,
): Promise<string> {
  const orgTimeZone = await guarded("the organization time zone", () =>
    store.organizationTimeZone(encounter.organizationId),
  );
  return guarded("the visit time", async () =>
    visitAsOf({ serviceDate: encounter.serviceDate, orgTimeZone, now }),
  );
}

export function createDraftService(deps: DraftServiceDeps): DraftService {
  const clock = deps.now ?? (() => new Date());
  // One request's source reads take turns (serial-seams.ts): each opens a pooled transaction beside the request's own.
  const seams = (): DraftSeamPorts => serialSeams((deps.seams ?? defaultDraftPorts)());
  return {
    // The two READS hold no connection while a source is asked (S3): the encounter and every store read go in one short transaction, which closes;
    // then the sources (M7, M9, M12, M39, each opening a pooled transaction of its own) are read; then the confirmations in a second short one.
    // The WRITES below keep their transaction, and the row lock in it, open across the seam reads: the draft they decide over must be the one the
    // lock protects (a source that does not answer within DRAFT_SOURCE_READ_TIMEOUT_MS fails the request, 503, and releases both).
    async getDraft(caller, encounterId) {
      const now = clock();
      const scope = { organizationId: caller.organizationId, userId: caller.userId, now };
      const { encounter, storePorts } = await deps.runInOrg(scope, async (unit) => {
        const row = await loadOr404(unit, encounterId, false, caller);
        return {
          encounter: row,
          storePorts: await snapshotStorePorts(
            unit.store,
            row,
            now,
            mayReadIdgItems(caller.permissions),
          ),
        };
      });
      const viewer = viewerOf(caller);
      const computed = await computeDraftOverview(
        { ...seams(), ...storePorts },
        encounter,
        viewer,
        now,
      );
      return deps.runInOrg(scope, async (unit) =>
        draftView(encounter, computed, await unit.store.confirmations(encounter.id)),
      );
    },

    async resolveSection(caller, encounterId, sectionId, body, audit) {
      const now = clock();
      return deps.runInOrg(
        { organizationId: caller.organizationId, userId: caller.userId, now, audit },
        async (unit) => {
          // Locked: two confirmations of one encounter (and a selection save, which bumps the same row) run one after the other.
          const encounter = await loadOr404(unit, encounterId, true, caller);
          // Same rule as the selection save: a signed, cosigned or voided note is edited only through an addendum.
          checkMutableForEdit({ status: encounter.status });
          const outcome = await resolveSection(seams(), unit.store, {
            encounter,
            viewer: viewerOf(caller),
            actorMembershipId: caller.membershipId,
            addendumId: null,
            sectionId,
            resolution: body.resolution,
            contentHash: body.contentHash,
            corpusVersion: body.corpusVersion,
            now,
          });
          if (outcome.event !== null) await unit.recordResolved(outcome.event);
          return outcome.view;
        },
      );
    },

    async getDisciplinePlanElements(caller, encounterId) {
      const now = clock();
      const scope = { organizationId: caller.organizationId, userId: caller.userId, now };
      // As the draft's own read: the store facts in one short transaction that closes before the plan (M15, its own pooled transaction) is asked.
      // Only the two the response needs: the stored selections (the clinician's free text) are not loaded.
      const { encounter, storePorts } = await deps.runInOrg(scope, async (unit) => {
        const row = await loadOr404(unit, encounterId, false, caller);
        assertDraftsFromDisciplinePlan(row);
        return { encounter: row, storePorts: await snapshotDisciplinePlanPorts(unit.store, row) };
      });
      const asOf = await visitTimeOf(encounter, storePorts, now);
      const elements = await readDisciplinePlanElements(
        { ...seams(), ...storePorts },
        encounter,
        { roles: caller.roles, membershipId: caller.membershipId },
        asOf,
      );
      return disciplinePlanElementsView(encounter, elements);
    },

    async setDisciplinePlanElement(caller, encounterId, elementId, body, audit) {
      const now = clock();
      return deps.runInOrg(
        { organizationId: caller.organizationId, userId: caller.userId, now, audit },
        async (unit) => {
          // Locked, and a signed, cosigned or voided note is edited only through an addendum, as a section's resolution is.
          const encounter = await loadOr404(unit, encounterId, true, caller);
          checkMutableForEdit({ status: encounter.status });
          assertDraftsFromDisciplinePlan(encounter);
          const asOf = await visitTimeOf(encounter, unit.store, now);
          const elements = await readDisciplinePlanElements(
            { ...seams(), ...unit.store },
            encounter,
            { roles: caller.roles, membershipId: caller.membershipId },
            asOf,
          );
          // An element this viewer was not handed (another plan's, absent, or Part 2 without disclosure) is not here: one answer for all of them.
          const element = elements.find((e) => e.elementId === elementId);
          if (element === undefined) throw new NotFoundError("plan element");
          const ref = {
            kind: element.kind === "goal" ? "discipline_plan_goal" : "discipline_plan_intervention",
            id: element.elementId,
          } as const;
          if (body.included) {
            await unit.store.linkDisciplinePlan(encounter, [ref], element.part2Derived);
          } else {
            await unit.store.removeDisciplinePlan(
              encounter,
              [ref],
              element.part2Derived,
              caller.membershipId,
              now,
            );
          }
          return disciplinePlanElementsView(
            encounter,
            elements.map((e) => (e.elementId === elementId ? { ...e, kept: body.included } : e)),
          );
        },
      );
    },

    async getIdgActionItems(caller, encounterId) {
      const now = clock();
      const scope = { organizationId: caller.organizationId, userId: caller.userId, now };
      // As the plan element list: the store facts in one short transaction that closes before M14 (its own pooled transaction) is asked. Only the zone and
      // the live link: the stored selections (the clinician's free text) are not loaded.
      const { encounter, storePorts } = await deps.runInOrg(scope, async (unit) => {
        const row = await loadOr404(unit, encounterId, false, caller);
        assertDraftsFromIdgFollowUp(row);
        assertMayReadIdgItems(caller.permissions);
        return { encounter: row, storePorts: await snapshotIdgFollowUpPorts(unit.store, row) };
      });
      const timeZone = await storePorts.organizationTimeZone(encounter.organizationId);
      const candidates = await readIdgFollowUpCandidates(
        seams(),
        encounter,
        viewerOf(caller),
        timeZone,
      );
      return idgFollowUpItemsView(
        encounter,
        candidates,
        await storePorts.linkedIdgActionItemId(encounter.id),
      );
    },

    async setIdgActionItem(caller, encounterId, body, audit) {
      const now = clock();
      return deps.runInOrg(
        { organizationId: caller.organizationId, userId: caller.userId, now, audit },
        async (unit) => {
          // Locked, and a signed, cosigned or voided note is edited only through an addendum, as a section's resolution is.
          const encounter = await loadOr404(unit, encounterId, true, caller);
          checkMutableForEdit({ status: encounter.status });
          assertDraftsFromIdgFollowUp(encounter);
          assertMayReadIdgItems(caller.permissions);
          const timeZone = await guarded("the organization time zone", () =>
            unit.store.organizationTimeZone(encounter.organizationId),
          );
          const candidates = await readIdgFollowUpCandidates(
            seams(),
            encounter,
            viewerOf(caller),
            timeZone,
          );
          // An item this viewer was not handed (absent, closed, reassigned, another patient's, or Part 2 without disclosure) is not here: one answer.
          const target =
            body.actionItemId === null
              ? null
              : (candidates.find((c) => c.actionItemId === body.actionItemId) ?? undefined);
          if (target === undefined) throw new NotFoundError("action item");
          const live = await guarded("the linked IDG action item", () =>
            unit.store.linkedIdgActionItemId(encounter.id),
          );
          // The verdict for the item being left: its own when M14 still hands it over, else Part 2 (fails closed: the flag only moves the audit class).
          const leaving =
            live === null ? undefined : candidates.find((c) => c.actionItemId === live);
          await unit.store.setIdgActionItemLink(
            encounter,
            target === null
              ? null
              : { actionItemId: target.actionItemId, part2Derived: target.part2Derived },
            live !== null && (leaving?.part2Derived ?? true),
            caller.membershipId,
            now,
          );
          return idgFollowUpItemsView(encounter, candidates, target?.actionItemId ?? null);
        },
      );
    },

    async getAmendmentDraft(caller, encounterId, addendumId) {
      const now = clock();
      const scope = { organizationId: caller.organizationId, userId: caller.userId, now };
      const { encounter, amendment, storePorts } = await deps.runInOrg(scope, async (unit) => {
        const row = await loadOr404(unit, encounterId, false, caller);
        return {
          encounter: row,
          amendment: await loadAuthoredAmendmentOr404(unit, encounterId, addendumId, caller),
          storePorts: await snapshotStorePorts(
            unit.store,
            row,
            now,
            mayReadIdgItems(caller.permissions),
          ),
        };
      });
      const viewer = viewerOf(caller);
      const computed = await computeDraftOverview(
        { ...seams(), ...storePorts },
        encounter,
        viewer,
        now,
      );
      return deps.runInOrg(scope, async (unit) =>
        amendmentDraftView(
          addendumId,
          amendment.sectionIds,
          draftView(
            encounter,
            computed,
            await unit.amendmentStore(addendumId).confirmations(encounter.id),
          ),
        ),
      );
    },

    async resolveAmendmentSection(caller, encounterId, addendumId, sectionId, body, audit) {
      const now = clock();
      return deps.runInOrg(
        { organizationId: caller.organizationId, userId: caller.userId, now, audit },
        async (unit) => {
          // Locked: the resolution, the addendum's sign and every other write of this encounter's draft run one after the other.
          const encounter = await loadOr404(unit, encounterId, true, caller);
          const amendment = await loadAmendmentOr404(unit, encounterId, addendumId);
          if (amendment.authoredByMembershipId !== caller.membershipId) {
            throw new ForbiddenError(
              "only the author of an addendum may resolve the sections it amends",
            );
          }
          if (amendment.status === "signed" || amendment.status === "voided") {
            throw new EncounterStateError(
              "ILLEGAL_TRANSITION",
              `the amended sections of a ${amendment.status} addendum cannot be changed`,
            );
          }
          if (!amendment.sectionIds.includes(sectionId)) {
            throw new EncounterStateError(
              "UNKNOWN_TEMPLATE_SECTION",
              `section '${sectionId}' is not one this addendum amends`,
            );
          }
          const outcome = await resolveSection(seams(), unit.amendmentStore(addendumId), {
            encounter,
            viewer: viewerOf(caller),
            actorMembershipId: caller.membershipId,
            addendumId,
            sectionId,
            resolution: body.resolution,
            contentHash: body.contentHash,
            corpusVersion: body.corpusVersion,
            now,
          });
          // The same explicit audit event a note's resolution records (CW-AC-49), naming the addendum: it is the only record of a deselection that
          // leaves a named section empty, and the row trigger's image of the update alone does not say who resolved what against which addendum.
          if (outcome.event !== null) await unit.recordResolved(outcome.event);
          return outcome.view;
        },
      );
    },
  };
}
