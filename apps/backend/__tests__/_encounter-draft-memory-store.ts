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
import type {
  AmendmentRef,
  ConfirmationWrite,
  DraftEncounterRow,
  DraftResolvedEvent,
  DraftStore,
  DraftUnit,
  RunInOrg,
} from "../src/modules/08-encounters/drafting/draft-store";
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

export interface MemoryStoreOptions {
  /** The stored selection tree and slots the draft renders (default: nothing selected). */
  readonly selection?: Awaited<ReturnType<DraftStore["loadSelection"]>>;
  /** A read that fails, by store port name (the draft must then be unavailable, never a pass). */
  readonly failing?: readonly (keyof DraftStore)[];
  readonly ownText?: readonly string[];
  readonly vitals?: VitalsDraftInput | null;
  readonly previous?: Date | null;
  readonly links?: readonly LinkRow[];
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
  providerEntityId: null,
  locationId: null,
  ...over,
});

export function memoryDraftStore(options: MemoryStoreOptions = {}) {
  const links: LinkRow[] = [...(options.links ?? [])];
  const saved = new Map<string, ConfirmationWrite>();
  let nextLinkId = links.length + 1;
  const apply = (ops: readonly LinkOp[], by: string | null, at: Date): number => {
    for (const op of ops) {
      const column = op.element.kind === "goal" ? "goalId" : "interventionId";
      if (op.op === "remove_live") {
        for (const id of op.rowIds) {
          const i = links.findIndex((l) => l.id === id);
          links[i] = { ...(links[i] as LinkRow), removedAt: at, removedByMembershipId: by };
        }
      } else {
        links.push({
          id: `link-${nextLinkId++}`,
          goalId: null,
          interventionId: null,
          [column]: op.element.id,
          removedAt: op.op === "insert_removed" ? at : null,
          removedByMembershipId: op.op === "insert_removed" ? by : null,
        });
      }
    }
    return ops.length;
  };
  const store: DraftStore = {
    organizationTimeZone: async () => NEW_YORK,
    previousSignedVisitAt: async () => options.previous ?? null,
    latestVitals: async () => options.vitals ?? null,
    removedCarePlanElementIds: async () => removedElementIdsOf(links),
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
      apply(planLinks(links, carePlanElementsOf(refs)), null, new Date()),
    removeCarePlan: async (_encounter, refs, by, now) =>
      apply(planRemovals(links, carePlanElementsOf(refs)), by, now),
  };
  const spied = Object.fromEntries(
    Object.entries(store).map(([name, impl]) => [name, vi.fn(impl as never)]),
  ) as unknown as { [K in keyof DraftStore]: ReturnType<typeof vi.fn> } & DraftStore;
  return { store: spied, links, saved };
}

export interface MemoryUnitOptions extends MemoryStoreOptions {
  /** The addendum the amendment routes find on the encounter (default: none). Its resolutions are kept apart from the note's. */
  readonly amendment?: AmendmentRef;
  readonly enabled?: boolean;
  /** `null` is an absent encounter; undefined is the default draft encounter. */
  readonly encounter?: DraftEncounterRow | null;
}

/** A `RunInOrg` over the in-memory store: records which unit calls were made and every audit event. */
export function memoryRunInOrg(options: MemoryUnitOptions = {}) {
  const { store, links, saved } = memoryDraftStore(options);
  const events: DraftResolvedEvent[] = [];
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
  };
  const scopes: Parameters<RunInOrg>[0][] = [];
  const runInOrg: RunInOrg = async (scope, fn) => {
    scopes.push(scope);
    return fn(unit);
  };
  return { runInOrg, store, links, saved, amendmentSaved, events, encounterCalls, scopes, unit };
}
