// apps/backend/src/modules/08-encounters/seams/store.ts — M8-T08 the data PORT the §4.7 owned seams
// compose over, plus an in-memory slice for tests/boot-without-DB. The seam impls (./readers.ts) are
// pure orchestration over this port; production injects a Drizzle-backed store that reads/writes M8's
// tables under the CONSUMER's `withOrgContext` (the impls never switch tenants — RLS scopes every read
// by `app.org_id`, §4.7). Mirrors the M6/M7 seams/store.ts precedent.
import type {
  CreateEncounterInput,
  DateRange,
  EncounterDiscipline,
  EncounterId,
  EncounterRenderPayload,
  EncounterStatus,
  EncounterType,
  IsoInstant,
  LateEntryTier,
  MembershipId,
  MileagePayrollRow,
  PatientId,
  SignedEncounterDigest,
} from "@wardenx/types";

/**
 * The billability-relevant facts the store hands the {@link BillableEncounterReader} for ONE encounter
 * (§4.7). The store resolves these SQL-side from the encounter + its cosignature/late-entry state; the
 * reader derives the verdict so the rule has one home (`deriveBillability`).
 */
export interface StoredEncounterFacts {
  readonly encounterId: EncounterId;
  readonly patientId: PatientId;
  readonly encounterType: EncounterType;
  readonly discipline: EncounterDiscipline;
  readonly status: EncounterStatus;
  readonly lateEntryTier: LateEntryTier;
  /** True once the routed RN cosignature row reached `signed` (D3); false while `cosign_pending`. */
  readonly cosignatureResolved: boolean;
  /** True once a required (≥significant) late-entry override is attested (D4); ignored for lower tiers. */
  readonly lateEntryAttested: boolean;
}

/**
 * The data port the §4.7 owned seams compose over. Methods return read-only DTO shapes (never Drizzle
 * rows); the Drizzle adapter projects rows to these under the consumer's RLS context. Reads key on the
 * tenant-pinned id/scope (the org is already pinned by RLS) and return null/[] when nothing is visible.
 */
export interface EncounterReaderStore {
  /** The billability facts for a batch of encounter ids (missing/invisible ids are simply omitted). */
  encounterFacts(
    encounterIds: ReadonlyArray<EncounterId>,
  ): Promise<ReadonlyArray<StoredEncounterFacts>>;
  /** Signed-encounter digests for a patient since an instant (M14 IDG aggregator, §4.7). */
  signedEncountersForPatientSince(
    patientId: PatientId,
    since: IsoInstant,
  ): Promise<ReadonlyArray<SignedEncounterDigest>>;
  /** The decrypted render payload for one signed encounter, or null when it is not visible. */
  renderPayload(encounterId: EncounterId): Promise<EncounterRenderPayload | null>;
  /** Authoritative mileage rows for a clinician over a service-date range (M27 payroll, §4.5 D10). */
  mileageForClinician(
    clinicianMembershipId: MembershipId,
    range: DateRange,
  ): Promise<ReadonlyArray<MileagePayrollRow>>;
  /** Insert a DRAFT encounter on behalf of an upstream reuser (M16/M17) and return its new id. */
  insertDraftEncounter(input: CreateEncounterInput): Promise<{ encounterId: EncounterId }>;
}

// ── in-memory slice store ─────────────────────────────────────────────────────────────────────────

/** Deterministic, I/O-free seed for the in-memory {@link EncounterReaderStore} (slice + seam tests). */
export interface EncounterReaderSeed {
  readonly facts?: readonly StoredEncounterFacts[];
  readonly digests?: readonly SignedEncounterDigest[];
  readonly payloads?: readonly EncounterRenderPayload[];
  readonly mileage?: readonly MileagePayrollRow[];
}

/** Pads `n` to mint a uuid-shaped id so created ids round-trip through uuid-validated bodies (M6 slice). */
function uuidFromCounter(n: number): EncounterId {
  const hex = n.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

/** An in-memory {@link EncounterReaderStore} for the slice/tests — no DB, deterministic, RLS-free. */
export function createInMemoryEncounterReaderStore(seed: EncounterReaderSeed = {}): {
  store: EncounterReaderStore;
} {
  const facts = [...(seed.facts ?? [])];
  const digests = seed.digests ?? [];
  const payloads = seed.payloads ?? [];
  const mileage = seed.mileage ?? [];
  let created = 0;
  return {
    store: {
      async encounterFacts(encounterIds) {
        const wanted = new Set(encounterIds);
        return facts.filter((f) => wanted.has(f.encounterId));
      },
      async signedEncountersForPatientSince(patientId, since) {
        return digests
          .filter((d) => d.patientId === patientId && d.signedAt >= since)
          .sort((a, b) => (a.signedAt < b.signedAt ? -1 : a.signedAt > b.signedAt ? 1 : 0));
      },
      async renderPayload(encounterId) {
        return payloads.find((p) => p.encounterId === encounterId) ?? null;
      },
      async mileageForClinician(clinicianMembershipId, range) {
        return mileage.filter(
          (m) =>
            m.clinicianMembershipId === clinicianMembershipId &&
            range.from <= m.serviceDate &&
            m.serviceDate <= range.to,
        );
      },
      async insertDraftEncounter(input) {
        const encounterId = uuidFromCounter(++created);
        facts.push({
          encounterId,
          patientId: input.patientId,
          encounterType: input.encounterType,
          discipline: input.discipline,
          status: "draft",
          lateEntryTier: "normal",
          cosignatureResolved: false,
          lateEntryAttested: false,
        });
        return { encounterId };
      },
    },
  };
}
