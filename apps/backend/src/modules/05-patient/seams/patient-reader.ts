// apps/backend/src/modules/05-patient/seams/patient-reader.ts — M5-T08 the PatientReader seam
// (M5 spec §4.8). CLOSES the M3/Wave-A boot-gate deny-stub. The typed read interface M29's T-29.05
// patient-match cascade consumes (findByMrn / findByExternalMrn / findBySsnLast4AndDob /
// findByNameDobSex / findByLooseName / findById). MERGE-REDIRECT is resolved TRANSPARENTLY here: a
// `merged` patient resolves to its survivor (≤ 3 hops, §4.8.2), so a consumer holding a stale id
// still reads the live chart. Pure orchestration over an injected `PatientReaderStore` (Drizzle over
// patient + patient_identifier in prod, under withOrgContext so RLS scopes by app.org_id; in-memory
// in the slice). RLS is the backstop even if ABAC is bypassed (§9.4).
import type { PatientIdentity, PatientReader } from "@chartwarden/types";

/** Max merge hops the redirect chase follows before treating the chain as corrupt (§4.8.2). */
export const MAX_MERGE_HOPS = 3;

/** The data port the reader composes over — returns raw matched rows; the provider resolves redirect. */
export interface PatientReaderStore {
  byMrn(organizationId: string, mrn: string): Promise<PatientIdentity | null>;
  byExternalMrn(
    organizationId: string,
    assigningAuthority: string,
    value: string,
  ): Promise<PatientIdentity | null>;
  bySsnLast4AndDob(
    organizationId: string,
    ssnLast4: string,
    dateOfBirth: string,
  ): Promise<readonly PatientIdentity[]>;
  byNameDobSex(
    organizationId: string,
    lastName: string,
    firstName: string,
    dateOfBirth: string,
    administrativeSex: string,
  ): Promise<readonly PatientIdentity[]>;
  byLooseName(
    organizationId: string,
    lastName: string,
    firstNameInitial: string | undefined,
    dateOfBirth: string,
  ): Promise<readonly PatientIdentity[]>;
  byId(organizationId: string, id: string): Promise<PatientIdentity | null>;
}

/** Build the real {@link PatientReader} over an injected store (slice in-memory; Drizzle in prod). */
export function createPatientReader(store: PatientReaderStore): PatientReader {
  /** Follow `mergedIntoId` to the survivor (≤ MAX_MERGE_HOPS); returns the resolved identity or the
   *  input if not merged. A broken/over-long chain returns the last resolvable row (fail-safe read). */
  async function resolve(
    organizationId: string,
    identity: PatientIdentity | null,
  ): Promise<PatientIdentity | null> {
    let current = identity;
    let hops = 0;
    while (current?.mergedIntoId && hops < MAX_MERGE_HOPS) {
      const survivor = await store.byId(organizationId, current.mergedIntoId);
      if (survivor === null) break;
      current = survivor;
      hops += 1;
    }
    return current;
  }

  /** Resolve a list of matches through the redirect, de-duplicating by survivor id. */
  async function resolveMany(
    organizationId: string,
    matches: readonly PatientIdentity[],
  ): Promise<readonly PatientIdentity[]> {
    const resolved = await Promise.all(matches.map((m) => resolve(organizationId, m)));
    const byId = new Map<string, PatientIdentity>();
    for (const r of resolved) if (r !== null) byId.set(r.id, r);
    return [...byId.values()];
  }

  return {
    async findByMrn({ organizationId, mrn }) {
      return resolve(organizationId, await store.byMrn(organizationId, mrn));
    },
    async findByExternalMrn({ organizationId, assigningAuthority, value }) {
      return resolve(
        organizationId,
        await store.byExternalMrn(organizationId, assigningAuthority.toUpperCase(), value),
      );
    },
    async findBySsnLast4AndDob({ organizationId, ssnLast4, dateOfBirth }) {
      return resolveMany(
        organizationId,
        await store.bySsnLast4AndDob(organizationId, ssnLast4, dateOfBirth),
      );
    },
    async findByNameDobSex({
      organizationId,
      lastName,
      firstName,
      dateOfBirth,
      administrativeSex,
    }) {
      return resolveMany(
        organizationId,
        await store.byNameDobSex(
          organizationId,
          lastName,
          firstName,
          dateOfBirth,
          administrativeSex,
        ),
      );
    },
    async findByLooseName({ organizationId, lastName, firstNameInitial, dateOfBirth }) {
      return resolveMany(
        organizationId,
        await store.byLooseName(organizationId, lastName, firstNameInitial, dateOfBirth),
      );
    },
    async findById({ organizationId, id }) {
      return resolve(organizationId, await store.byId(organizationId, id));
    },
  };
}

// ── in-memory slice store ─────────────────────────────────────────────────────────────────────

/** An in-memory {@link PatientReaderStore} seeded with patient identities (slice/tests). */
export function createInMemoryPatientReaderStore(seed: readonly PatientIdentity[] = []): {
  store: PatientReaderStore;
} {
  const byOrg = (organizationId: string) => seed.filter((p) => p.organizationId === organizationId);
  return {
    store: {
      async byMrn(organizationId, mrn) {
        return byOrg(organizationId).find((p) => p.mrn === mrn) ?? null;
      },
      async byExternalMrn(organizationId, assigningAuthority, value) {
        return (
          byOrg(organizationId).find((p) =>
            p.externalMrns.some(
              (e) => e.assigningAuthority.toUpperCase() === assigningAuthority && e.value === value,
            ),
          ) ?? null
        );
      },
      async bySsnLast4AndDob(organizationId, ssnLast4, dateOfBirth) {
        return byOrg(organizationId).filter(
          (p) => p.ssnLast4 === ssnLast4 && p.dateOfBirth === dateOfBirth,
        );
      },
      async byNameDobSex(organizationId, lastName, firstName, dateOfBirth, administrativeSex) {
        return byOrg(organizationId).filter(
          (p) =>
            p.lastName.toUpperCase() === lastName.toUpperCase() &&
            p.firstName.toUpperCase() === firstName.toUpperCase() &&
            p.dateOfBirth === dateOfBirth &&
            p.administrativeSex === administrativeSex,
        );
      },
      async byLooseName(organizationId, lastName, firstNameInitial, dateOfBirth) {
        return byOrg(organizationId).filter(
          (p) =>
            p.lastName.toUpperCase() === lastName.toUpperCase() &&
            p.dateOfBirth === dateOfBirth &&
            (firstNameInitial === undefined ||
              p.firstName.toUpperCase().startsWith(firstNameInitial.toUpperCase())),
        );
      },
      async byId(organizationId, id) {
        return byOrg(organizationId).find((p) => p.id === id) ?? null;
      },
    },
  };
}
