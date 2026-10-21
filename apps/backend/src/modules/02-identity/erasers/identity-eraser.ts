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
// production adapter is `createDrizzleIdentityEraserStore` (below, TASK-003 / ARCH-007):
//   • two_factor / passkey → a DELETE keyed on user_id. These tables are user-owned and
//     NON_ORG_SCOPED (M02-F01: one identity, many memberships; un-RLS'd per migration 0006's
//     authority note), so erasure is GLOBAL for the subject and runs on the pooled handle the
//     way identity-stores-db.ts already reads/writes them. `scope` is carried for
//     audit/telemetry symmetry with the DataEraser contract, not as a row filter.
//   • organization_invitation → a DELETE of the subject's PENDING rows within `scope.orgId`
//     (org-scoped table, RLS on app.org_id), invoked inside withOrgContext.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { DataEraser, OrgScope } from "@chartwarden/types";
import { and, eq } from "drizzle-orm";
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

/**
 * The Drizzle-backed store: the REAL destruction path (TASK-003 / ARCH-007 — the argument-less
 * registration bound an in-memory store, so a right-to-erasure "succeeded" against rows that exist
 * nowhere). Every count is the rows ACTUALLY deleted (`.returning()`), never the request size.
 *
 *   • two_factor / passkey are user-owned and un-RLS'd (migration 0006), so the deletes run on the
 *     pooled `wardenx_app` handle keyed on user_id — the same access shape identity-stores-db.ts
 *     uses for the M1-owned `users`. Erasure is global per subject by design (M02-F01).
 *   • organization_invitation is org-scoped (app.org_id RLS), and an invitation is addressed by
 *     EMAIL (it predates the account), so the store resolves the subject's email from `users`
 *     first and deletes the PENDING rows for that email inside `withOrgContext`. This is a hard
 *     DELETE, not the route path's `revoked` soft-rescind: under a right-to-erasure the email on
 *     the row is exactly the personal data being destroyed. Accepted/revoked rows are out of this
 *     data class's contract (see the store port doc) and survive as compliance records.
 */
export function createDrizzleIdentityEraserStore(db: DbClient): IdentityEraserStore {
  const TF = schema.twoFactor;
  const PK = schema.passkey;
  const I = schema.organizationInvitations;
  const U = schema.users;

  return {
    async eraseTwoFactor(_scope, userId) {
      const deleted = await db.delete(TF).where(eq(TF.userId, userId)).returning({ id: TF.id });
      return deleted.length;
    },

    async erasePasskeys(_scope, userId) {
      const deleted = await db.delete(PK).where(eq(PK.userId, userId)).returning({ id: PK.id });
      return deleted.length;
    },

    async rescindInvitationsFor(scope, userId) {
      // Invitations key on email, not user_id — resolve the subject first (users is un-RLS'd).
      const rows = await db.select({ email: U.email }).from(U).where(eq(U.id, userId)).limit(1);
      const email = rows[0]?.email;
      // No user row ⇒ no email to match ⇒ nothing addressable to this subject (faithful zero).
      if (!email) return 0;
      return withOrgContext(db, { organizationId: scope.orgId, userId: "" }, async (tx) => {
        const deleted = await tx
          .delete(I)
          .where(
            and(eq(I.organizationId, scope.orgId), eq(I.email, email), eq(I.status, "pending")),
          )
          .returning({ id: I.id });
        return deleted.length;
      });
    },
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
