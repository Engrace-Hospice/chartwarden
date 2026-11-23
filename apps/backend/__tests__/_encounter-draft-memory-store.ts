import type { VitalsDraftInput } from "@chartwarden/hearthnote";
// An in-memory `DraftStore` and `RunInOrg` for the draft routes' orchestration tests (S1 PR C2b1). The care-plan link rules are the
// SAME pure planners the Drizzle store runs (care-plan-refs.ts); only the row storage is faked. Synthetic ids only.
import { vi } from "vitest";
import {
  type LinkOp,
  type LinkRowState,
  carePlanElementsOf,
  planLinks,
  planRemovals,
  removedElementIdsOf,
} from "../src/modules/08-encounters/drafting/care-plan-refs";
import { disciplinePlanElementsOf } from "../src/modules/08-encounters/drafting/discipline-plan-refs";
import type {
  AmendmentRef,
  ConfirmationWrite,
  DraftEncounterRow,
  DraftResolvedEvent,
  DraftStore,
  DraftUnit,
  IdgLinkRefusedEvent,
  RunInOrg,
} from "../src/modules/08-encounters/drafting/draft-store";
import {
  type IdgLinkRowState,
  planIdgLink,
} from "../src/modules/08-encounters/drafting/idg-action-item-links";
import {
  ADMISSION_ID,
  EMPTY_SELECTION,
  ENCOUNTER_ID,
  NEW_YORK,
  ORG_ID,
  PATIENT_ID,
} from "./_encounter-draft-fixtures";

export interface LinkRow extends LinkRowState {
  readonly removedByMembershipId: string | null;
}

/** An `encounter_discipline_plan_link` row (S4b): an M7-shaped link row plus the Part 2 flag the writer states. */
export interface DisciplineLinkRow extends LinkRow {
  readonly part2Derived: boolean;
}

/** An `encounter_idg_action_item_link` row (S5b): one M14 action item, the member who removed it, the Part 2 flag the writer states. */
export interface IdgLinkRow extends IdgLinkRowState {
  readonly removedByMembershipId: string | null;
  readonly part2Derived: boolean;
  readonly linkedByMembershipId: string;
}

export interface MemoryStoreOptions {
  /** The stored selection tree and slots the draft renders (default: nothing selected). */
  readonly selection?: Awaited<ReturnType<DraftStore["loadSelection"]>>;
  /** A read that fails, by store port name (the draft must then be unavailable, never a pass). */
  readonly failing?: readonly (keyof DraftStore)[];
  readonly ownText?: readonly string[];
  readonly vitals?: VitalsDraftInput | null;
  readonly previous?: Date | null;
  readonly links?: readonly LinkRow[];
  /** S4b: the visit's links to M15 plan elements. */
  readonly disciplineLinks?: readonly DisciplineLinkRow[];
  /** S5b: the visit's links to M14 action items (at most one live). */
  readonly idgLinks?: readonly IdgLinkRow[];
}

export const draftEncounterRow = (over: Partial<DraftEncounterRow> = {}): DraftEncounterRow => ({
  id: ENCOUNTER_ID,
  organizationId: ORG_ID,
  patientId: PATIENT_ID,
  admissionId: ADMISSION_ID,
  encounterType: "routine_visit",
  discipline: "rn",
  serviceDate: "2026-11-18",
  status: "draft",
  // the member the draft tests' callers are (`membershipId` of their sessions)
  authoredByMembershipId: "00000000-0000-4000-8000-0000000000aa",
  providerEntityId: null,
  locationId: null,
  ...over,
});

export function memoryDraftStore(options: MemoryStoreOptions = {}) {
  const links: LinkRow[] = [...(options.links ?? [])];
  const disciplineLinks: DisciplineLinkRow[] = [...(options.disciplineLinks ?? [])];
  const idgLinks: IdgLinkRow[] = [...(options.idgLinks ?? [])];
  const saved = new Map<string, ConfirmationWrite>();
  let nextLinkId = links.length + disciplineLinks.length + 1;
  /** Executes link ops against one of the two row sets; `extra` is what that table's rows carry beyond the M7 shape (the Part 2 flag). */
  const apply = (
    rows: LinkRow[],
    ops: readonly LinkOp[],
    by: string | null,
    at: Date,
    extra: Record<string, unknown> = {},
  ): number => {
    for (const op of ops) {
      const column = op.element.kind === "goal" ? "goalId" : "interventionId";
      if (op.op === "remove_live") {
        for (const id of op.rowIds) {
          const i = rows.findIndex((l) => l.id === id);
          rows[i] = { ...(rows[i] as LinkRow), removedAt: at, removedByMembershipId: by };
        }
      } else {
        rows.push({
          id: `link-${nextLinkId++}`,
          goalId: null,
          interventionId: null,
          [column]: op.element.id,
          removedAt: op.op === "insert_removed" ? at : null,
          removedByMembershipId: op.op === "insert_removed" ? by : null,
          ...extra,
        });
      }
    }
    return ops.length;
  };
  const store: DraftStore = {
    organizationTimeZone: async () => NEW_YORK,
    previousSignedVisitAt: async () => options.previous ?? null,
    latestVitals: async () => options.vitals ?? null,
    weightReadings: async () => [],
    removedCarePlanElementIds: async () => removedElementIdsOf(links),
    removedDisciplinePlanElementIds: async () => removedElementIdsOf(disciplineLinks),
    linkedIdgActionItemId: async () =>
      idgLinks.find((row) => row.removedAt === null)?.actionItemId ?? null,
    loadSelection: async () => options.selection ?? EMPTY_SELECTION,
    confirmations: async () => {
      if (options.failing?.includes("confirmations")) throw new Error("the store is unreachable");
      return [...saved.values()];
    },
    ownTextSectionIds: async () => new Set(options.ownText ?? []),
    saveConfirmation: async (write) => {
      saved.set(write.sectionId, write);
    },
    linkCarePlan: async (_encounter, refs) =>
      apply(links, planLinks(links, carePlanElementsOf(refs)), null, new Date()),
    removeCarePlan: async (_encounter, refs, by, now) =>
      apply(links, planRemovals(links, carePlanElementsOf(refs)), by, now),
    linkDisciplinePlan: async (_encounter, refs, part2Derived) =>
      apply(
        disciplineLinks,
        planLinks(disciplineLinks, disciplinePlanElementsOf(refs)),
        null,
        new Date(),
        { part2Derived },
      ),
    raiseIdgLinkPart2: async (_encounterId, actionItemId) => {
      let raised = false;
      idgLinks.forEach((row, i) => {
        if (row.actionItemId === actionItemId && !row.part2Derived) {
          idgLinks[i] = { ...row, part2Derived: true };
          raised = true;
        }
      });
      return raised;
    },
    // The SAME pure plan the Drizzle store executes (idg-action-item-links.ts); only the row storage is faked.
    setIdgActionItemLink: async (_encounter, target, currentPart2Derived, by, now) => {
      const plan = planIdgLink(idgLinks, target, currentPart2Derived);
      for (const actionItemId of plan.raisePart2OfItems) {
        idgLinks.forEach((row, i) => {
          if (row.actionItemId === actionItemId) idgLinks[i] = { ...row, part2Derived: true };
        });
      }
      if (plan.removeRowId !== null) {
        const i = idgLinks.findIndex((row) => row.id === plan.removeRowId);
        idgLinks[i] = {
          ...(idgLinks[i] as IdgLinkRow),
          removedAt: now,
          removedByMembershipId: by,
        };
      }
      if (plan.insert !== null) {
        idgLinks.push({
          id: `idg-link-${nextLinkId++}`,
          actionItemId: plan.insert.actionItemId,
          removedAt: null,
          removedByMembershipId: null,
          part2Derived: plan.insert.part2Derived,
          linkedByMembershipId: by,
        });
      }
      return plan.removeRowId !== null || plan.insert !== null;
    },
    removeDisciplinePlan: async (_encounter, refs, part2Derived, by, now) =>
      apply(
        disciplineLinks,
        planRemovals(disciplineLinks, disciplinePlanElementsOf(refs)),
        by,
        now,
        { part2Derived },
      ),
  };
  const spied = Object.fromEntries(
    Object.entries(store).map(([name, impl]) => [name, vi.fn(impl as never)]),
  ) as unknown as { [K in keyof DraftStore]: ReturnType<typeof vi.fn> } & DraftStore;
  return { store: spied, links, disciplineLinks, idgLinks, saved };
}

export interface MemoryUnitOptions extends MemoryStoreOptions {
  /** The addendum the amendment routes find on the encounter (default: none). Its resolutions are kept apart from the note's. */
  readonly amendment?: AmendmentRef;
  readonly enabled?: boolean;
  /** The refused-link audit write throws (the refusal must still be answered). */
  readonly refusalAuditFails?: boolean;
  /** `null` is an absent encounter; undefined is the default draft encounter. */
  readonly encounter?: DraftEncounterRow | null;
}

/** A `RunInOrg` over the in-memory store: records which unit calls were made and every audit event. */
export function memoryRunInOrg(options: MemoryUnitOptions = {}) {
  const { store, links, disciplineLinks, idgLinks, saved } = memoryDraftStore(options);
  const events: DraftResolvedEvent[] = [];
  const refusals: IdgLinkRefusedEvent[] = [];
  const encounterCalls: { id: string; forUpdate: boolean }[] = [];
  const found = options.encounter === undefined ? draftEncounterRow() : options.encounter;
  const amendmentSaved = new Map<string, ConfirmationWrite>();
  const amendmentStore: DraftStore = {
    ...store,
    confirmations: async () => [...amendmentSaved.values()],
    saveConfirmation: async (write) => {
      amendmentSaved.set(write.sectionId, write);
    },
    linkCarePlan: async () => 0,
    removeCarePlan: async () => 0,
    // An amendment never changes the visit's links (VN-D62): it reads the note's removed set and writes none of its own.
    linkDisciplinePlan: async () => 0,
    removeDisciplinePlan: async () => 0,
    setIdgActionItemLink: async () => false,
    raiseIdgLinkPart2: async () => false,
  };
  const unit: DraftUnit = {
    amendment: async (encounterId, addendumId) =>
      options.amendment !== undefined &&
      options.amendment.id === addendumId &&
      found?.id === encounterId
        ? options.amendment
        : null,
    amendmentStore: () => amendmentStore,
    enabled: async () => options.enabled ?? true,
    encounter: async (id, forUpdate) => {
      encounterCalls.push({ id, forUpdate });
      return found !== null && found.id === id ? found : null;
    },
    store,
    recordResolved: async (event) => {
      events.push(event);
    },
    recordIdgLinkRefused: async (event) => {
      if (options.refusalAuditFails === true) throw new Error("the audit write failed");
      refusals.push(event);
    },
  };
  const scopes: Parameters<RunInOrg>[0][] = [];
  const runInOrg: RunInOrg = async (scope, fn) => {
    scopes.push(scope);
    return fn(unit);
  };
  return {
    runInOrg,
    store,
    links,
    disciplineLinks,
    idgLinks,
    saved,
    amendmentSaved,
    events,
    refusals,
    encounterCalls,
    scopes,
    unit,
  };
}
