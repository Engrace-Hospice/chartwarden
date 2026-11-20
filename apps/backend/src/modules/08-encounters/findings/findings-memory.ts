// apps/backend/src/modules/08-encounters/findings/findings-memory.ts — WF09: the in-memory FindingsService the route tests run
// over (no DB, deterministic, RLS-free: every read is scoped by the passed organization id, so a cross-tenant id is the same
// non-leaking 404 RLS gives in production). It also hands back the matching EncounterAbacResolver, so the M8 `encounter.scope` /
// `is_author_or_supervisor` predicates resolve the same dataset.
import { assertVersion } from "@chartwarden/shared/route-kit";
import type { EncounterDiscipline, EncounterStatus, EncounterType } from "@chartwarden/types";
import { NotFoundError } from "@chartwarden/types";
import { unitlessMeasurements } from "../authoring/measurements";
import type { EncounterAbacResolver } from "../routes/service";
import { type AdlColumns, planAdlRecord } from "./adl";
import {
  type FindingKind,
  assertDraftForFinding,
  assertNoteStatesFinding,
} from "./findings-guards";
import {
  type AdlView,
  type FindingsService,
  type NutritionView,
  adlViewOf,
  nutritionViewOf,
  sameColumns,
} from "./findings-service";
import { type NutritionColumns, planNutritionRecord } from "./nutrition";
import { SIGNED_NOTE_STATUSES, type WeightSetRow, summariseWeights } from "./weight-history";

export interface FindingsEncounterSeed {
  readonly id: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly status: EncounterStatus;
  /** The note template's pair; a routine RN visit when omitted. */
  readonly encounterType?: EncounterType;
  readonly discipline?: EncounterDiscipline;
  /** `YYYY-MM-DD`. */
  readonly serviceDate: string;
  readonly authoredByMembershipId: string;
  /** Vitals sets captured on the encounter (only the weight matters here). */
  readonly weights?: readonly { readonly weight: string; readonly weightUnit: string | null }[];
}

export interface InMemoryFindingsBackend {
  readonly service: FindingsService;
  /** The ABAC resolver over the same encounters. */
  readonly resolver: EncounterAbacResolver;
  /** Move an encounter to another status (a test signs a note without driving the whole lifecycle). */
  setStatus(encounterId: string, status: EncounterStatus): void;
}

/** A record of either kind, keyed by encounter. `updatedAt` doubles as the version, as in the Drizzle service. */
interface Stored<C> {
  readonly columns: C;
  readonly updatedAt: string;
}

const STALE_RECORD_MESSAGE = "the record changed since you read it; reload and try again";

export function createInMemoryFindingsBackend(
  seed: readonly FindingsEncounterSeed[],
  clock: () => Date = () => new Date(),
): InMemoryFindingsBackend {
  const encounters = new Map(seed.map((e) => [e.id, { ...e }]));
  const adls = new Map<string, Stored<AdlColumns>>();
  const nutritions = new Map<string, Stored<NutritionColumns>>();
  let captureTick = 0;

  /** Tenant-scoped lookup: another tenant's encounter is indistinguishable from an absent one. */
  const visible = (organizationId: string, encounterId: string) => {
    const encounter = encounters.get(encounterId);
    if (!encounter || encounter.organizationId !== organizationId) {
      throw new NotFoundError("encounter");
    }
    return encounter;
  };
  /** A draft whose template states the record, with the optional `If-Match` checked against what is stored. */
  const writable = (
    organizationId: string,
    encounterId: string,
    kind: FindingKind,
    stored: Stored<unknown> | undefined,
    ifMatch: number | undefined,
  ): void => {
    const encounter = visible(organizationId, encounterId);
    assertDraftForFinding(encounter.status);
    assertNoteStatesFinding(
      encounter.encounterType ?? "routine_visit",
      encounter.discipline ?? "rn",
      kind,
    );
    if (ifMatch !== undefined) {
      const current = stored === undefined ? 0 : new Date(stored.updatedAt).getTime();
      assertVersion(current, ifMatch, STALE_RECORD_MESSAGE);
    }
  };
  /** The next `updatedAt`: the clock, but always strictly later than the stored one (the version must move on every write). */
  const nextUpdatedAt = (stored: Stored<unknown> | undefined): string =>
    new Date(
      Math.max(
        clock().getTime(),
        stored === undefined ? 0 : new Date(stored.updatedAt).getTime() + 1,
      ),
    ).toISOString();

  /**
   * One PUT, whichever record it replaces (the in-memory twin of the Drizzle `writeRecord`): the encounter must be a visible draft whose
   * template states the record, the optional `If-Match` must be the version stored, an unchanged record keeps its version (the
   * idempotent no-op), else the columns are stored under a strictly later version.
   */
  const putRecord = <C extends object, V>(
    store: Map<string, Stored<C>>,
    kind: FindingKind,
    [organizationId, encounterId]: readonly [string, string],
    columns: C,
    ifMatch: number | undefined,
    viewOf: (encounterId: string, patientId: string, columns: C, updatedAt: string) => V,
  ): V => {
    const previous = store.get(encounterId);
    writable(organizationId, encounterId, kind, previous, ifMatch);
    const stored =
      previous && sameColumns(previous.columns, columns)
        ? previous
        : { columns, updatedAt: nextUpdatedAt(previous) };
    store.set(encounterId, stored);
    const { patientId } = visible(organizationId, encounterId);
    return viewOf(encounterId, patientId, stored.columns, stored.updatedAt);
  };

  const service: FindingsService = {
    async getAdl(organizationId, encounterId): Promise<AdlView | null> {
      const encounter = visible(organizationId, encounterId);
      const stored = adls.get(encounter.id);
      return stored
        ? adlViewOf(encounterId, encounter.patientId, stored.columns, stored.updatedAt)
        : null;
    },
    async putAdl(organizationId, encounterId, input, _actor, ifMatch) {
      return putRecord(
        adls,
        "adl",
        [organizationId, encounterId],
        planAdlRecord(input),
        ifMatch,
        adlViewOf,
      );
    },
    async getNutrition(organizationId, encounterId): Promise<NutritionView | null> {
      const encounter = visible(organizationId, encounterId);
      const stored = nutritions.get(encounter.id);
      return stored
        ? nutritionViewOf(encounterId, encounter.patientId, stored.columns, stored.updatedAt)
        : null;
    },
    async putNutrition(organizationId, encounterId, input, _actor, ifMatch) {
      return putRecord(
        nutritions,
        "nutrition",
        [organizationId, encounterId],
        planNutritionRecord(input),
        ifMatch,
        nutritionViewOf,
      );
    },
    async getWeightHistory(organizationId, encounterId) {
      const current = visible(organizationId, encounterId);
      // The same population the SQL reads: this encounter (unless void) plus this patient's earlier-dated SIGNED encounters.
      const rows: WeightSetRow[] = [...encounters.values()]
        .filter(
          (e) =>
            e.organizationId === organizationId &&
            e.patientId === current.patientId &&
            e.status !== "voided" &&
            (e.id === current.id ||
              (e.serviceDate < current.serviceDate &&
                (SIGNED_NOTE_STATUSES as readonly string[]).includes(e.status))),
        )
        .flatMap((e) =>
          (e.weights ?? []).map((w) => ({
            encounterId: e.id,
            serviceDate: e.serviceDate,
            capturedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, captureTick++)),
            weight: w.weight,
            weightUnit: w.weightUnit,
          })),
        );
      return {
        patientId: current.patientId,
        ...summariseWeights(rows, encounterId),
        weightUnitMissing: unitlessMeasurements(current.weights ?? []).weightUnitMissing,
      };
    },
  };

  const resolver: EncounterAbacResolver = {
    async loadEncounter(organizationId, encounterId) {
      const e = encounters.get(encounterId);
      if (!e || e.organizationId !== organizationId) return null;
      return {
        encounterId: e.id,
        patientId: e.patientId,
        discipline: "rn",
        authoredByUserId: e.authoredByMembershipId,
      };
    },
    async loadAddendumAuthor() {
      return null;
    },
  };

  return {
    service,
    resolver,
    setStatus(encounterId, status) {
      const e = encounters.get(encounterId);
      if (e) encounters.set(encounterId, { ...e, status });
    },
  };
}
