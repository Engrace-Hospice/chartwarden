// apps/backend/src/modules/12-dosespot/tenant-config/config-store-memory.ts — an in-memory `ConfigStore` for the suites that
// exercise the registration rules and routes without a database (the clearinghouse / wizard-store-memory precedent). It
// mirrors the migration's compare-and-set on `version`; it does NOT mirror RLS (one instance is one world, keyed by org id).
import { randomUUID } from "node:crypto";
import type { ConfigPatch, ConfigRow, ConfigStore, NewConfigRow } from "./config-store";

export interface InMemoryConfigStore extends ConfigStore {
  /** Test control: the counts the view reports. */
  setPrescribers(organizationId: string, n: number): void;
  setQueued(organizationId: string, n: number): void;
  rows(): readonly ConfigRow[];
}

export function createInMemoryConfigStore(now: () => Date = () => new Date()): InMemoryConfigStore {
  const byOrg = new Map<string, ConfigRow>();
  const prescribers = new Map<string, number>();
  const queued = new Map<string, number>();
  return {
    async findForUpdate(organizationId) {
      return byOrg.get(organizationId) ?? null;
    },
    async find(organizationId) {
      return byOrg.get(organizationId) ?? null;
    },
    async insert(row: NewConfigRow) {
      if (byOrg.has(row.organizationId)) {
        throw Object.assign(new Error("duplicate key value violates unique constraint"), {
          code: "23505",
        });
      }
      const at = now();
      const created = {
        id: randomUUID(),
        status: "draft",
        clinicId: null,
        serviceClinicianId: null,
        secretCipher: null,
        secretDekRef: null,
        registeredAt: null,
        registeredByMembershipId: null,
        verifiedAt: null,
        verifiedByMembershipId: null,
        lastTestAt: null,
        lastTestOutcome: null,
        activatedAt: null,
        activatedByMembershipId: null,
        version: 1,
        createdAt: at,
        updatedAt: at,
        ...row,
      } as ConfigRow;
      byOrg.set(row.organizationId, created);
      return created;
    },
    async update(organizationId, expectedVersion, patch: ConfigPatch) {
      const current = byOrg.get(organizationId);
      if (!current || current.version !== expectedVersion) return null;
      const next: ConfigRow = { ...current, ...patch, version: expectedVersion + 1 };
      byOrg.set(organizationId, next);
      return next;
    },
    async vendorEnrolledPrescribers(organizationId) {
      return prescribers.get(organizationId) ?? 0;
    },
    async queuedTransmissions(organizationId) {
      return queued.get(organizationId) ?? 0;
    },
    setPrescribers: (organizationId, n) => void prescribers.set(organizationId, n),
    setQueued: (organizationId, n) => void queued.set(organizationId, n),
    rows: () => [...byOrg.values()],
  };
}
