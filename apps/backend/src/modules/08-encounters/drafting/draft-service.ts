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
import { computeDraftOverview } from "./compute";
import { defaultDraftPorts } from "./default-ports";
import type { AmendmentRef, DraftEncounterRow, DraftUnit, RunInOrg } from "./draft-store";
import {
  type AmendmentDraftView,
  type DraftSectionView,
  type DraftView,
  amendmentDraftView,
  draftView,
} from "./draft-view";
import type { DraftPorts, DraftSeamPorts } from "./ports";
import { resolveSection } from "./resolve-section";
import { serialSeams } from "./serial-seams";

/** The authenticated caller of a draft route, from the server-assembled session. */
export interface DraftCaller {
  readonly organizationId: string;
  readonly userId: string;
  readonly roles: readonly string[];
  /** The active membership id, or `null` when the session carries none (a read then fails closed against a Part 2 release). */
  readonly membershipId: string | null;
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
}

export interface AmendmentDraftService {
  /**
   * The draft of the signed note as the addendum's author sees it as of the visit time, restricted to the sections the addendum names (VN-D30),
   * each against the addendum's own resolutions. 404 for a free addendum (it names nothing) and for a tenant with the draft off.
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
): Promise<DraftEncounterRow> {
  if (!(await unit.enabled())) throw new NotFoundError("encounter");
  const encounter = await unit.encounter(encounterId, forUpdate);
  if (encounter === null) throw new NotFoundError("encounter");
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

export function createDraftService(deps: DraftServiceDeps): DraftService {
  const clock = deps.now ?? (() => new Date());
  // One request's source reads take turns (serial-seams.ts): each opens a pooled transaction beside the request's own.
  const seams = (): DraftSeamPorts => serialSeams((deps.seams ?? defaultDraftPorts)());
  return {
    async getDraft(caller, encounterId) {
      const now = clock();
      return deps.runInOrg(
        { organizationId: caller.organizationId, userId: caller.userId, now },
        async (unit) => {
          const encounter = await loadOr404(unit, encounterId, false);
          const ports: DraftPorts = { ...seams(), ...unit.store };
          const viewer = { roles: caller.roles, membershipId: caller.membershipId };
          const computed = await computeDraftOverview(ports, encounter, viewer, now);
          return draftView(encounter, computed, await unit.store.confirmations(encounter.id));
        },
      );
    },

    async resolveSection(caller, encounterId, sectionId, body, audit) {
      const now = clock();
      return deps.runInOrg(
        { organizationId: caller.organizationId, userId: caller.userId, now, audit },
        async (unit) => {
          // Locked: two confirmations of one encounter (and a selection save, which bumps the same row) run one after the other.
          const encounter = await loadOr404(unit, encounterId, true);
          // Same rule as the selection save: a signed, cosigned or voided note is edited only through an addendum.
          checkMutableForEdit({ status: encounter.status });
          const outcome = await resolveSection(seams(), unit.store, {
            encounter,
            viewer: { roles: caller.roles, membershipId: caller.membershipId },
            actorMembershipId: caller.membershipId,
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

    async getAmendmentDraft(caller, encounterId, addendumId) {
      const now = clock();
      return deps.runInOrg(
        { organizationId: caller.organizationId, userId: caller.userId, now },
        async (unit) => {
          const encounter = await loadOr404(unit, encounterId, false);
          const amendment = await loadAmendmentOr404(unit, encounterId, addendumId);
          const store = unit.amendmentStore(addendumId);
          const ports: DraftPorts = { ...seams(), ...store };
          const viewer = { roles: caller.roles, membershipId: caller.membershipId };
          const computed = await computeDraftOverview(ports, encounter, viewer, now);
          return amendmentDraftView(
            addendumId,
            amendment.sectionIds,
            draftView(encounter, computed, await store.confirmations(encounter.id)),
          );
        },
      );
    },

    async resolveAmendmentSection(caller, encounterId, addendumId, sectionId, body, audit) {
      const now = clock();
      return deps.runInOrg(
        { organizationId: caller.organizationId, userId: caller.userId, now, audit },
        async (unit) => {
          // Locked: the resolution, the addendum's sign and every other write of this encounter's draft run one after the other.
          const encounter = await loadOr404(unit, encounterId, true);
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
            viewer: { roles: caller.roles, membershipId: caller.membershipId },
            actorMembershipId: caller.membershipId,
            sectionId,
            resolution: body.resolution,
            contentHash: body.contentHash,
            corpusVersion: body.corpusVersion,
            now,
          });
          return outcome.view;
        },
      );
    },
  };
}
