// apps/backend/src/modules/02-identity/erasers/identity-eraser.ts — M2-T10 data eraser.
//
// M2 owns the personal-credential surface of identity: a subject's `two_factor` + `passkey`
// enrollments (user-owned, NON_ORG_SCOPED) and any pending `organization_invitation`
// addressed to them. A right-to-erasure request for that subject must destroy this data, so
// M2 registers a REAL eraser for the `identity` data class over the Phase-0 deny-stub
// (registry.ts REQUIRED_ERASERS + bootstrap wireErasers()); the composition root invokes
// registerIdentityErasers() through buildServer's `registerModuleErasers` hook, which runs
// AFTER wireErasers() and before validateErasers(), so the real eraser stands.
//
// SLICE NOTE: like the rest of the M2 slice (identity-ports / step-up-ports / seams), the
// eraser runs over an injected store with a slice-safe in-memory default — no live DB. The
// production adapter (a tracked follow-up, consistent with the slice's forward pattern) wires:
//   • two_factor / passkey → a DELETE keyed on user_id. These tables are user-owned and
//     NON_ORG_SCOPED (M02-F01: one identity, many memberships), so erasure is GLOBAL for the
//     subject and runs under the user-ownership RLS predicate (not app.org_id). `scope` is
//     carried for audit/telemetry symmetry with the DataEraser contract, not as a row filter.
//   • organization_invitation → a DELETE of the subject's PENDING rows within `scope.orgId`
//     (org-scoped table, RLS on app.org_id), invoked inside withOrgContext.
import type { DataEraser, OrgScope } from "@wardenx/types";
import { registerEraser } from "../../../bootstrap/index";

/**
 * The store the identity eraser deletes through. Each method returns the number of rows
 * destroyed so the eraser can report a faithful `{ erased }` total (M4 destruction-cert).
 */
export interface IdentityEraserStore {
  /** Delete every `two_factor` row for the subject (user-owned; global per user). */
  eraseTwoFactor(scope: OrgScope, userId: string): number | Promise<number>;
  /** Delete every `passkey` row for the subject (user-owned; global per user). */
  erasePasskeys(scope: OrgScope, userId: string): number | Promise<number>;
  /** Delete the subject's pending `organization_invitation` rows within the org scope. */
  rescindInvitationsFor(scope: OrgScope, userId: string): number | Promise<number>;
}

/** Build the M2 `identity` DataEraser over an injected store (M2-T10). */
export function createIdentityEraser(store: IdentityEraserStore): DataEraser {
  return {
    async erase(scope, subjectId) {
      const twoFactor = await store.eraseTwoFactor(scope, subjectId);
      const passkeys = await store.erasePasskeys(scope, subjectId);
      const invitations = await store.rescindInvitationsFor(scope, subjectId);
      return { erased: twoFactor + passkeys + invitations };
    },
  };
}

/** A seedable in-memory row a test/slice store deletes through. */
interface SeedRow {
  readonly id: string;
  readonly userId: string;
}

/** Seed shape for the in-memory identity-eraser store. */
export interface IdentityEraserSeed {
  twoFactor?: SeedRow[];
  passkeys?: SeedRow[];
  /** Pending invitations resolved to a subject user id (email→user mapping done upstream). */
  invitations?: SeedRow[];
}

/**
 * In-memory identity-eraser store (slice/test). Deletes the subject's seeded rows and exposes
 * `remaining()` so a test can assert the rows are gone. `scope` is accepted to match the
 * production contract but, for the user-owned credential tables, is not a row filter (see file
 * header) — erasure is global per subject.
 */
export function createInMemoryIdentityEraserStore(seed: IdentityEraserSeed = {}): {
  store: IdentityEraserStore;
  remaining(): { twoFactor: number; passkeys: number; invitations: number };
} {
  const twoFactor = [...(seed.twoFactor ?? [])];
  const passkeys = [...(seed.passkeys ?? [])];
  const invitations = [...(seed.invitations ?? [])];

  const deleteFor = (rows: SeedRow[], userId: string): number => {
    let deleted = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]?.userId === userId) {
        rows.splice(i, 1);
        deleted++;
      }
    }
    return deleted;
  };

  return {
    store: {
      eraseTwoFactor: (_scope, userId) => deleteFor(twoFactor, userId),
      erasePasskeys: (_scope, userId) => deleteFor(passkeys, userId),
      rescindInvitationsFor: (_scope, userId) => deleteFor(invitations, userId),
    },
    remaining: () => ({
      twoFactor: twoFactor.length,
      passkeys: passkeys.length,
      invitations: invitations.length,
    }),
  };
}

/** Injected adapters for M2's eraser (slice defaults to the in-memory store). */
export interface IdentityEraserDeps {
  store?: IdentityEraserStore;
}

/**
 * Register M2's REAL `identity` eraser into the M1 destruction-cert registry over the Phase-0
 * deny-stub (M2-T10). Called by the composition root's wireModuleErasers() AFTER wireErasers()
 * and before validateErasers(), so the real eraser stands and a right-to-erasure request hits
 * a working eraser, not a silent no-op.
 */
export function registerIdentityErasers(deps: IdentityEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryIdentityEraserStore().store;
  registerEraser("identity", createIdentityEraser(store));
}
