// apps/backend/src/modules/09-assessments/wounds/seam.ts — M9's `WoundProvider` seam: the wound observations recorded at
// one encounter, for the M8 visit note to state. M9 owns the wound record and may not import M8; M8 may read M9 only
// through a published seam. The provider is pure orchestration over a store port; the Drizzle store reads under an
// org-explicit tenant context (RLS-scoped) and returns only CURRENT (non-superseded) observations whose
// `source_encounter_id` is the encounter, ordered by observed time then id. Phrasing and judgement stay with the note.
import {
  type WoundObservationView,
  type WoundProvider,
  type WoundReadActor,
  type WoundReadOptions,
  siteLabel,
} from "@chartwarden/assessments";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, asc, eq } from "drizzle-orm";
import type { WoundObservationRecord, WoundRecord } from "./projection";
import { woundObservationRecordOf, woundRecordOf } from "./row-mappers";

/** The data port the provider composes over. */
export interface WoundProviderStore {
  currentObservationsForEncounter(
    organizationId: string,
    encounterId: string,
    actor: WoundReadActor,
    filter: WoundReadOptions,
  ): Promise<readonly WoundObservationView[]>;
}

/** One observation + its wound, as the seam view the note reads (the site as its display phrase). */
export function toWoundObservationView(
  wound: WoundRecord,
  o: WoundObservationRecord,
): WoundObservationView {
  return {
    observationId: o.id,
    woundId: o.woundId,
    observedAt: o.observedAt,
    site: siteLabel(wound.siteCode, wound.laterality),
    etiology: wound.etiology,
    stage: o.stage,
    lengthCm: o.lengthCm,
    widthCm: o.widthCm,
    depthCm: o.depthCm,
    undermining: o.undermining,
    woundBed: o.woundBed,
    exudateAmount: o.exudateAmount,
    exudateType: o.exudateType,
    odor: o.odor,
    periwound: o.periwound,
    painScore: o.painScore,
    dressing: o.dressing,
    dressingChanged: o.dressingChanged,
    infectionSigns: o.infectionSigns,
    trend: o.trend,
  };
}

/** `WoundProvider` over a store. Fails closed: a blank organisation or encounter is an error, never an empty answer. */
export function createWoundProvider(store: WoundProviderStore): WoundProvider {
  return {
    async listObservationsForEncounter(organizationId, encounterId, actor, options = {}) {
      if (!organizationId?.trim())
        throw new Error("listObservationsForEncounter: organizationId required");
      if (!encounterId?.trim())
        throw new Error("listObservationsForEncounter: encounterId required");
      return store.currentObservationsForEncounter(organizationId, encounterId, actor, options);
    },
  };
}

/** The production store: one org-scoped read joining each observation to its wound. */
export function createDrizzleWoundProviderStore(db: DbClient): WoundProviderStore {
  const O = schema.woundObservations;
  const W = schema.wounds;
  return {
    async currentObservationsForEncounter(organizationId, encounterId, actor, filter) {
      return withOrgContext(db, { organizationId, userId: actor.userId }, async (tx) => {
        const rows = await tx
          .select({ observation: O, wound: W })
          .from(O)
          .innerJoin(W, and(eq(W.id, O.woundId), eq(W.organizationId, O.organizationId)))
          .where(
            and(
              // Explicit second wall behind RLS (a PHI-bearing seam).
              eq(O.organizationId, organizationId),
              eq(O.sourceEncounterId, encounterId),
              eq(O.status, "active"),
              filter.patientId ? eq(O.patientId, filter.patientId) : undefined,
            ),
          )
          .orderBy(asc(O.observedAt), asc(O.id));
        return rows.map((r) =>
          toWoundObservationView(woundRecordOf(r.wound), woundObservationRecordOf(r.observation)),
        );
      });
    },
  };
}

/** An in-memory store over fixed records (tests; a boot without a database). */
export function createInMemoryWoundProviderStore(source: {
  wounds: () => readonly WoundRecord[];
  observations: () => readonly WoundObservationRecord[];
}): WoundProviderStore {
  return {
    async currentObservationsForEncounter(organizationId, encounterId, _actor, filter) {
      return source
        .observations()
        .filter(
          (o) =>
            o.organizationId === organizationId &&
            o.sourceEncounterId === encounterId &&
            o.status === "active" &&
            (filter.patientId === undefined || o.patientId === filter.patientId),
        )
        .sort((a, b) =>
          a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : a.id < b.id ? -1 : 1,
        )
        .flatMap((o) => {
          const wound = source
            .wounds()
            .find((w) => w.id === o.woundId && w.organizationId === organizationId);
          return wound ? [toWoundObservationView(wound, o)] : [];
        });
    },
  };
}

/** The seam registrar's shape: the composition root's `registerSeam`, once the registry names `WoundProvider`. */
export type WoundSeamRegistrar = (name: "WoundProvider", impl: WoundProvider) => void;

/** Publish M9's `WoundProvider` so M8 resolves it with `getSeam("WoundProvider")`. Called from the composition root. */
export function registerWoundSeam(register: WoundSeamRegistrar, store: WoundProviderStore): void {
  register("WoundProvider", createWoundProvider(store));
}
