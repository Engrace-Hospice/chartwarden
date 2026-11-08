// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/config-store-memory.ts — an in-memory `ConfigStore` for
// the suites that exercise the clearinghouse rules and routes without a database (the wizard-store-memory precedent). It
// mirrors the migration's compare-and-set on `version`; it does NOT mirror RLS (one instance is one tenant's world per org id).
import { randomUUID } from "node:crypto";
import type { ConfigPatch, ConfigRow, ConfigStore, NewConfigRow } from "./config-store";

export interface InMemoryConfigStore extends ConfigStore {
  /** Test control: pretend the org has (or no longer has) a production submission in flight. */
  setProductionAttempts(organizationId: string, present: boolean): void;
  rows(): readonly ConfigRow[];
  /** Test view: the fingerprints the org holds unreleased. */
  heldFingerprints(organizationId: string): readonly string[];
}

interface Reservation {
  readonly organizationId: string;
  readonly fingerprint: string;
  readonly released: boolean;
}

const uniqueViolation = (constraint?: string): Error =>
  Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    ...(constraint ? { constraint_name: constraint } : {}),
  });

export function createInMemoryConfigStore(now: () => Date = () => new Date()): InMemoryConfigStore {
  const byOrg = new Map<string, ConfigRow>();
  const withAttempts = new Set<string>();
  /** Mirrors migration 1404: one unreleased reservation per fingerprint across ALL organizations. */
  const reservations: Reservation[] = [];
  /** Mirrors migration 1403's partial unique index: one non-null fingerprint across ALL organizations. */
  const assertFingerprintFree = (
    organizationId: string,
    fingerprint: string | null | undefined,
  ) => {
    if (!fingerprint) return;
    for (const row of byOrg.values()) {
      if (row.organizationId !== organizationId && row.credentialFingerprint === fingerprint) {
        throw uniqueViolation("tenant_clearinghouse_config_fingerprint_uq");
      }
    }
  };
  return {
    async findForUpdate(organizationId) {
      return byOrg.get(organizationId) ?? null;
    },
    async find(organizationId) {
      return byOrg.get(organizationId) ?? null;
    },
    async insert(row: NewConfigRow) {
      if (byOrg.has(row.organizationId)) throw uniqueViolation();
      assertFingerprintFree(row.organizationId, row.credentialFingerprint);
      const at = now();
      const created: ConfigRow = {
        id: randomUUID(),
        mode: null,
        status: "draft",
        secretCipher: null,
        secretDekVersion: null,
        credentialFingerprint: null,
        verificationKind: null,
        verificationEvidence: null,
        verifiedAt: null,
        verifiedByMembershipId: null,
        lastTestAt: null,
        lastTestOutcome: null,
        activatedAt: null,
        activatedByMembershipId: null,
        baaVendor: null,
        baaEffectiveDate: null,
        baaDocumentRef: null,
        baaRecordedAt: null,
        baaRecordedByMembershipId: null,
        baaVerifiedAt: null,
        baaVerifiedByMembershipId: null,
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
      if (patch.credentialFingerprint !== undefined)
        assertFingerprintFree(organizationId, patch.credentialFingerprint);
      const next: ConfigRow = { ...current, ...patch, version: expectedVersion + 1 };
      byOrg.set(organizationId, next);
      return next;
    },
    async hasProductionAttempts(organizationId) {
      return withAttempts.has(organizationId);
    },
    async hasRecentProductionAttempts(organizationId) {
      return withAttempts.has(organizationId);
    },
    async holdsCredential(organizationId, fingerprint) {
      return reservations.some(
        (r) => r.organizationId === organizationId && r.fingerprint === fingerprint && !r.released,
      );
    },
    async reserveCredential(organizationId, _vendor, fingerprint) {
      if (reservations.some((r) => r.fingerprint === fingerprint && !r.released)) {
        throw uniqueViolation("tenant_clearinghouse_credential_reservation_held_uq");
      }
      reservations.push({ organizationId, fingerprint, released: false });
    },
    async releaseCredentials(organizationId, keep) {
      let released = 0;
      reservations.forEach((r, i) => {
        if (r.organizationId !== organizationId || r.released || r.fingerprint === keep) return;
        reservations[i] = { ...r, released: true };
        released += 1;
      });
      return released;
    },
    setProductionAttempts(organizationId, present) {
      if (present) withAttempts.add(organizationId);
      else withAttempts.delete(organizationId);
    },
    rows: () => [...byOrg.values()],
    heldFingerprints: (organizationId) =>
      reservations
        .filter((r) => r.organizationId === organizationId && !r.released)
        .map((r) => r.fingerprint),
  };
}
