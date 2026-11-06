// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/config-store-memory.ts — an in-memory `ConfigStore` for
// the suites that exercise the clearinghouse rules and routes without a database (the wizard-store-memory precedent). It
// mirrors the migration's compare-and-set on `version`; it does NOT mirror RLS (one instance is one tenant's world per org id).
import { randomUUID } from "node:crypto";
import { type ConfigPatch, type ConfigRow, type ConfigStore, type NewConfigRow } from "./config-store";

export interface InMemoryConfigStore extends ConfigStore {
  /** Test control: pretend the org has (or no longer has) a production submission in flight. */
  setProductionAttempts(organizationId: string, present: boolean): void;
  rows(): readonly ConfigRow[];
}

export function createInMemoryConfigStore(now: () => Date = () => new Date()): InMemoryConfigStore {
  const byOrg = new Map<string, ConfigRow>();
  const withAttempts = new Set<string>();
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
      const created: ConfigRow = {
        id: randomUUID(),
        mode: null,
        status: "draft",
        secretCipher: null,
        secretDekVersion: null,
        verificationKind: null,
        verificationEvidence: null,
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
    async hasProductionAttempts(organizationId) {
      return withAttempts.has(organizationId);
    },
    setProductionAttempts(organizationId, present) {
      if (present) withAttempts.add(organizationId);
      else withAttempts.delete(organizationId);
    },
    rows: () => [...byOrg.values()],
  };
}
