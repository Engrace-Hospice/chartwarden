import { randomUUID } from "node:crypto";
// apps/backend/src/modules/09-assessments/wounds/service-memory.ts — the in-memory WoundRouteService (route tests, and a
// boot without a database). Same rules as the Drizzle service: coded values, the domain validation, an open wound to
// observe, append-only observations corrected by a superseding row, org and patient isolation, and a visit an observation is tied to that
// must be the caller's own open note for the patient (the `visits` reader; none given means no visit exists). Records are replaced, never mutated.
import {
  type WoundProvider,
  assertCorrectable,
  assertValidObservedAt,
  assertValidWound,
  assertValidWoundObservation,
  assertValidWoundResolution,
  assertWoundOpen,
} from "@chartwarden/assessments";
import { type EncounterDraftReader, NotFoundError } from "@chartwarden/types";
import {
  type WoundObservationRecord,
  type WoundRecord,
  observationValuesOf,
  toObservationDtos,
  toWoundView,
} from "./projection";
import { createInMemoryWoundProviderStore, createWoundProvider } from "./seam";
import {
  MAX_WOUNDS_LISTED,
  type WoundDetail,
  type WoundListItem,
  type WoundObservationDto,
  type WoundRouteService,
  type WoundView,
} from "./service";
import { assertOwnDraftVisit, noEncounterDraftReader } from "./source-visit";

export interface InMemoryWoundOptions {
  readonly now?: () => Date;
  /** M8's visit facts; defaults to a reader that knows no visit, so a visit-tied observation is refused. */
  readonly visits?: EncounterDraftReader;
  /** The organisation-local ISO date; defaults to the UTC date of `now`. */
  readonly today?: () => string;
  readonly newId?: () => string;
}

export interface InMemoryWoundBackend {
  readonly service: WoundRouteService;
  /** The `WoundProvider` seam over the same records (what the visit note reads). */
  readonly provider: WoundProvider;
  /** Every stored observation (any organisation, any status), for assertions. */
  observations(): readonly WoundObservationRecord[];
  wounds(): readonly WoundRecord[];
}

export function createInMemoryWoundService(
  options: InMemoryWoundOptions = {},
): InMemoryWoundBackend {
  const now = options.now ?? (() => new Date());
  const today = options.today ?? (() => now().toISOString().slice(0, 10));
  const newId = options.newId ?? randomUUID;
  const visits = options.visits ?? noEncounterDraftReader;
  let wounds: readonly WoundRecord[] = [];
  let observations: readonly WoundObservationRecord[] = [];

  const findWound = (organizationId: string, patientId: string, woundId: string): WoundRecord => {
    const wound = wounds.find(
      (w) => w.id === woundId && w.organizationId === organizationId && w.patientId === patientId,
    );
    if (!wound) throw new NotFoundError("wound");
    return wound;
  };
  const observationsOf = (woundId: string): readonly WoundObservationRecord[] =>
    observations.filter((o) => o.woundId === woundId);
  const replaceWound = (next: WoundRecord): void => {
    wounds = wounds.map((w) => (w.id === next.id ? next : w));
  };
  const dtoOf = (woundId: string, observationId: string): WoundObservationDto => {
    const dto = toObservationDtos(observationsOf(woundId), { includeSuperseded: true }).find(
      (o) => o.id === observationId,
    );
    if (!dto) throw new NotFoundError("wound observation");
    return dto;
  };

  const assertVisitOpen = (
    actor: { organizationId: string; membershipId: string },
    patientId: string,
    encounterId: string,
  ): Promise<void> =>
    assertOwnDraftVisit(visits, {
      organizationId: actor.organizationId,
      encounterId,
      patientId,
      membershipId: actor.membershipId,
    });

  /**
   * A visit can be finalized or voided between the visit check and the commit (the Drizzle service's gap, mirrored here so a scripted reader
   * can prove it): the committed observation's visit is asked again, and one no longer a draft takes the observation out of it, as a
   * `wrong_visit` correction that supersedes it with no visit (observations are append-only), returned so the response shows `null`.
   */
  const untagIfVisitClosed = async (
    actor: { organizationId: string; membershipId: string },
    woundId: string,
    committedId: string,
    checkedVisit: string | null,
  ): Promise<WoundObservationDto> => {
    const committed = observations.find((o) => o.id === committedId) as WoundObservationRecord;
    if (!checkedVisit || committed.sourceEncounterId !== checkedVisit) {
      return dtoOf(woundId, committedId);
    }
    const facts = await visits.draftOf({
      organizationId: actor.organizationId,
      encounterId: checkedVisit,
    });
    if (facts?.status === "draft") return dtoOf(woundId, committedId);
    const untagged: WoundObservationRecord = {
      ...committed,
      id: newId(),
      observedByMembershipId: actor.membershipId,
      sourceEncounterId: null,
      status: "active",
      correctsObservationId: committed.id,
      correctionReason: "wrong_visit",
      version: 1,
      createdAt: now().toISOString(),
    };
    observations = [
      ...observations.map((o) =>
        o.id === committed.id ? { ...o, status: "superseded" as const, version: o.version + 1 } : o,
      ),
      untagged,
    ];
    return dtoOf(woundId, untagged.id);
  };

  const service: WoundRouteService = {
    async listWounds(organizationId, patientId, status) {
      const mine = wounds
        .filter(
          (w) =>
            w.organizationId === organizationId &&
            w.patientId === patientId &&
            (status === "all" || w.status === status),
        )
        .sort(
          (a, b) =>
            Number(b.status === "open") - Number(a.status === "open") ||
            (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1),
        )
        .slice(0, MAX_WOUNDS_LISTED);
      const items = mine.map(
        (w): WoundListItem => ({
          ...toWoundView(w),
          latestObservation:
            toObservationDtos(observationsOf(w.id), { includeSuperseded: false })[0] ?? null,
        }),
      );
      return { wounds: items };
    },

    async getWound(organizationId, patientId, woundId, opts): Promise<WoundDetail> {
      const wound = findWound(organizationId, patientId, woundId);
      return {
        wound: toWoundView(wound),
        observations: toObservationDtos(observationsOf(wound.id), opts),
      };
    },

    async createWound(actor, patientId, input): Promise<WoundView> {
      assertValidWound(input, today());
      const wound: WoundRecord = {
        id: newId(),
        organizationId: actor.organizationId,
        patientId,
        siteCode: input.siteCode,
        laterality: input.laterality,
        etiology: input.etiology,
        acquired: input.acquired ?? "unknown",
        onsetOn: input.onsetOn ?? null,
        status: "open",
        closedOn: null,
        createdByMembershipId: actor.membershipId,
        createdAt: now().toISOString(),
      };
      wounds = [...wounds, wound];
      return toWoundView(wound);
    },

    async recordObservation(actor, patientId, woundId, input) {
      const checkedVisit = input.sourceEncounterId ?? null;
      if (checkedVisit) await assertVisitOpen(actor, patientId, checkedVisit);
      const wound = findWound(actor.organizationId, patientId, woundId);
      assertWoundOpen(wound.status);
      assertValidWoundObservation(wound.etiology, input);
      const observedAt = input.observedAt ?? now().toISOString();
      assertValidObservedAt(observedAt, now(), wound.onsetOn);
      const record: WoundObservationRecord = {
        id: newId(),
        organizationId: actor.organizationId,
        woundId: wound.id,
        patientId,
        observedAt: new Date(observedAt).toISOString(), // as the Drizzle service stores it: a UTC instant, whatever offset the client sent
        observedByMembershipId: actor.membershipId,
        sourceEncounterId: input.sourceEncounterId ?? null,
        ...observationValuesOf(input),
        status: "active",
        correctsObservationId: null,
        correctionReason: null,
        version: 1,
        createdAt: now().toISOString(),
      };
      observations = [...observations, record];
      return untagIfVisitClosed(actor, wound.id, record.id, checkedVisit);
    },

    async correctObservation(actor, patientId, woundId, observationId, ifVersion, input) {
      const wound = findWound(actor.organizationId, patientId, woundId);
      const target = observations.find((o) => o.id === observationId && o.woundId === wound.id);
      if (!target) throw new NotFoundError("wound observation");
      // Only a visit the observation is not already tied to is checked: a correction may keep its note even after the note is closed.
      let checkedVisit: string | null = null;
      if (input.sourceEncounterId && input.sourceEncounterId !== target.sourceEncounterId) {
        checkedVisit = input.sourceEncounterId;
        await assertVisitOpen(actor, patientId, checkedVisit);
      }
      assertCorrectable(target, ifVersion);
      assertValidWoundObservation(wound.etiology, input);
      const observedAt = input.observedAt ?? target.observedAt;
      assertValidObservedAt(observedAt, now(), wound.onsetOn);
      const correction: WoundObservationRecord = {
        id: newId(),
        organizationId: actor.organizationId,
        woundId: wound.id,
        patientId,
        observedAt: new Date(observedAt).toISOString(),
        observedByMembershipId: actor.membershipId,
        // Absent keeps the visit the observation was made at; an explicit null takes it out of the note.
        sourceEncounterId:
          input.sourceEncounterId === undefined
            ? target.sourceEncounterId
            : input.sourceEncounterId,
        ...observationValuesOf(input),
        status: "active",
        correctsObservationId: target.id,
        correctionReason: input.correctionReason,
        version: 1,
        createdAt: now().toISOString(),
      };
      observations = [
        ...observations.map((o) =>
          o.id === target.id ? { ...o, status: "superseded" as const, version: o.version + 1 } : o,
        ),
        correction,
      ];
      return untagIfVisitClosed(actor, wound.id, correction.id, checkedVisit);
    },

    async resolveWound(actor, patientId, woundId, input): Promise<WoundView> {
      const wound = findWound(actor.organizationId, patientId, woundId);
      assertWoundOpen(wound.status);
      const closedOn = input.closedOn ?? today();
      assertValidWoundResolution({ onsetOn: wound.onsetOn, closedOn }, today());
      const closed: WoundRecord = { ...wound, status: input.status, closedOn };
      replaceWound(closed);
      return toWoundView(closed);
    },
  };

  const provider = createWoundProvider(
    createInMemoryWoundProviderStore({ wounds: () => wounds, observations: () => observations }),
  );
  return { service, provider, observations: () => observations, wounds: () => wounds };
}
