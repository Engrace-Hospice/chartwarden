// apps/backend/src/modules/17-scheduling/seams/credentials.ts — GAP-093: M17's `CredentialReader`
// seam (§1.1 D8) over the new `membership_credential` table. CLOSES the M3 boot-gate deny-stub: the
// D8 `clinician_credentials_active` pre-schedule-gate predicate (and the `POST /api/v1/visits`
// preHandler chain, `scheduling-routes.ts`) resolve through it instead of an unconditional `false`.
//
// Distinct from the four §4.3 read-only seams in ./index.ts (VisitReader et al, which project OFF
// `visit`/`route_segment` rows): this store also MUTATES — a clinician's credential roster has to be
// grantable/revocable somewhere, or the D8 gate would deny every caller forever for lack of any way
// to ever satisfy it (the exact GAP-030 regression this fix is careful not to reintroduce). The
// grant/revoke methods back `scheduling-route-service-db.ts`'s new membership-credential routes.
import type { CredentialGrant, CredentialReader } from "@chartwarden/types";
import { registerSeam } from "../../../bootstrap/index";

/** The discipline vocabulary a credential covers — mirrors `@chartwarden/scheduling`'s
 *  `SchedulingDiscipline` (rn/lpn/chha/msw/chaplain/volunteer/md/np/pa); kept as a plain string union
 *  here rather than importing the feature package (this file is consumed by the seam layer, which
 *  stays leaf-safe). `md` is PHYSICIAN — MD *or* DO (same level, one value; see the policy header). */
export type CredentialDiscipline =
  | "rn"
  | "lpn"
  | "chha"
  | "msw"
  | "chaplain"
  | "volunteer"
  | "md"
  | "np"
  | "pa";

export type CredentialRecordStatus = "active" | "suspended" | "revoked";

/** One `membership_credential` row, the full shape (beyond the seam's minimal {@link CredentialGrant}) —
 *  the shape the grant/list/revoke routes read and write. */
export interface CredentialRecord {
  readonly id: string;
  readonly membershipId: string;
  readonly credentialType: CredentialDiscipline;
  readonly status: CredentialRecordStatus;
  readonly effectiveAt: string; // ISO date
  readonly expiresAt: string | null; // ISO date; null = non-expiring
  readonly revokedAt: string | null; // ISO instant
  readonly revokedReason: string | null;
  readonly issuingBody: string | null;
  readonly grantedByMembershipId: string;
  readonly createdAt: string; // ISO instant
}

export interface GrantCredentialInput {
  readonly membershipId: string;
  readonly credentialType: CredentialDiscipline;
  readonly effectiveAt: string;
  readonly expiresAt?: string | null;
  readonly issuingBody?: string | null;
  readonly grantedByMembershipId: string;
}

/** The data port {@link CredentialReader} + the grant/revoke routes compose over (Drizzle over
 *  `membership_credential` in prod; in-memory slice in tests). */
export interface CredentialStore {
  /** Rows for `membershipId` genuinely active as of `asOf` (status='active' AND within window) —
   *  what the D8 gate predicate reads. */
  activeAsOf(
    organizationId: string,
    membershipId: string,
    asOf: string,
  ): Promise<readonly CredentialGrant[]>;
  /** Every non-revoked row for `membershipId` (any status/window) — the admin list view. */
  listForMembership(
    organizationId: string,
    membershipId: string,
  ): Promise<readonly CredentialRecord[]>;
  /** Grant a credential. Re-grants an existing (org, membership, type) after a prior revoke (the
   *  `membership_credential_current_uq` partial-unique index scopes uniqueness to non-revoked rows). */
  grant(organizationId: string, input: GrantCredentialInput): Promise<CredentialRecord>;
  /** Soft-revoke a credential row (sets `revoked_at`/`revoked_reason`, flips `status` to 'revoked'). */
  revoke(
    organizationId: string,
    input: { credentialId: string; revokedReason: string; revokedByMembershipId: string },
  ): Promise<void>;
}

/** Build the real {@link CredentialReader} over an injected store (slice in-memory; Drizzle in prod). */
export function createCredentialReader(store: CredentialStore): CredentialReader {
  return {
    async activeCredentialsAsOf({ organizationId, membershipId, asOf }) {
      return store.activeAsOf(organizationId, membershipId, asOf);
    },
  };
}

/** Injected production adapter for M17's credential seam (slice defaults to in-memory). */
export interface CredentialSeamDeps {
  store?: CredentialStore;
}

/** Register M17's `CredentialReader` into the M1 registry (before validateSeams()). */
export function registerCredentialSeam(deps: CredentialSeamDeps = {}): void {
  const store = deps.store ?? createInMemoryCredentialStore().store;
  registerSeam("CredentialReader", createCredentialReader(store));
}

// ── in-memory slice store ─────────────────────────────────────────────────────────────────────

let inMemoryIdCounter = 0;
const nextInMemoryId = (): string => `mc-${++inMemoryIdCounter}`;

/** An in-memory {@link CredentialStore} for the slice/tests. Deterministic, no I/O. */
export function createInMemoryCredentialStore(seed: readonly CredentialRecord[] = []): {
  store: CredentialStore;
} {
  const rows = new Map<string, CredentialRecord>(seed.map((r) => [r.id, r]));

  const isActiveAsOf = (r: CredentialRecord, asOf: string): boolean =>
    r.status === "active" &&
    r.revokedAt === null &&
    r.effectiveAt <= asOf &&
    (r.expiresAt === null || r.expiresAt >= asOf);

  return {
    store: {
      async activeAsOf(_organizationId, membershipId, asOf) {
        return [...rows.values()]
          .filter((r) => r.membershipId === membershipId && isActiveAsOf(r, asOf))
          .map((r) => ({ kind: r.credentialType, status: r.status }));
      },
      async listForMembership(_organizationId, membershipId) {
        return [...rows.values()].filter((r) => r.membershipId === membershipId);
      },
      async grant(_organizationId, input) {
        const id = nextInMemoryId();
        const record: CredentialRecord = {
          id,
          membershipId: input.membershipId,
          credentialType: input.credentialType,
          status: "active",
          effectiveAt: input.effectiveAt,
          expiresAt: input.expiresAt ?? null,
          revokedAt: null,
          revokedReason: null,
          issuingBody: input.issuingBody ?? null,
          grantedByMembershipId: input.grantedByMembershipId,
          createdAt: new Date().toISOString(),
        };
        rows.set(id, record);
        return record;
      },
      async revoke(_organizationId, input) {
        const existing = rows.get(input.credentialId);
        if (!existing) return;
        rows.set(input.credentialId, {
          ...existing,
          status: "revoked",
          revokedAt: new Date().toISOString(),
          revokedReason: input.revokedReason,
        });
      },
    },
  };
}
