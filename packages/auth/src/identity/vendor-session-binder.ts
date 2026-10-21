// @chartwarden/auth · identity — the M19 vendor session binder (M2-owned; F-030 / #75).
//
// M19 owns the `external_triage_vendor` row and the shift that puts it on call; M2 owns the `session`
// row. Nothing connected the two. So no session ever carried one of M19's two answering-service classes
// or a `scope.externalActorId`, and `external_triage_actor` — the predicate that decides whether a
// vendor may touch a triage call — compared the shift's vendor against `undefined` on every request.
//
// THE FAILURE WAS INVISIBLE BECAUSE IT LOOKED LIKE THE PHASE PLAN. M19's spec ships the Hybrid and
// Centralized models feature-flagged-OFF in Phase 1, with the data shape (`external_triage_vendor`,
// `triage_call.external_actor_id`) in the migration so that "a Phase-2 tenant subscribing to an
// outsourced model is a configuration flip + vendor-adapter package install, not a schema change". That
// promise was not true: the config flip and the adapter would both have landed on a session layer that
// cannot express a vendor, and the flip would have produced a tenant whose vendor sessions are refused
// by a predicate nobody would think to look at. This closes the session half so the spec's stated
// Phase-2 story holds. It does NOT turn the models on — no tenant reaches this without
// `tenant_oncall_policy.model` naming an outsourced model, and the outbound vendor adapter (§7.5's
// PHI-minimized dispatch) remains unbuilt and out of scope.
//
// Fail-closed: a session that is not in the requested org is refused rather than silently rescoped, and
// the vendor id is required rather than defaulted — the `PortalSessionBinder` contract next door, for
// the same reasons.
import type { OrgScope, VendorSessionBinder, VendorSessionClass } from "@chartwarden/types";
import { isVendorSessionClass } from "./session-classes";

/** The `session` row fields the binder reads back to verify what it is about to write onto. */
export interface VendorSessionRow {
  readonly organizationId: string | null;
  readonly sessionClass: string;
  readonly scope: { externalActorId?: string } | null;
}

/**
 * The M1 `session`-table write surface the binder needs. Production is a Drizzle store inside
 * `withOrgContext`; the slice default is in-memory.
 */
export interface VendorSessionStore {
  /** The row, or null when it does not exist / is not in this org (no cross-tenant read). */
  read(scope: OrgScope, sessionId: string): Promise<VendorSessionRow | null>;
  /** Write the class and merge `patch` into `scope`. Org-scoped; never widens the session's org. */
  write(
    scope: OrgScope,
    sessionId: string,
    update: { sessionClass: VendorSessionClass; scopePatch: Record<string, string> },
  ): Promise<void>;
}

/** Raised when a binder call names a session it may not act on. Fail-closed, and deliberately vague. */
export class VendorSessionBindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VendorSessionBindError";
  }
}

/** Build the M2 `VendorSessionBinder` seam over a session store. */
export function createVendorSessionBinder(store: VendorSessionStore): VendorSessionBinder {
  return {
    async bindVendorSession({ scope, sessionId, externalActorId, sessionClass }) {
      if (!isVendorSessionClass(sessionClass)) {
        // Unreachable through the typed seam; defense in depth against a JS caller, because writing an
        // arbitrary string here would put a class on the row that no predicate expects — and for THIS
        // key that is worse than useless, since `sessionExternalActorId` gates on the class and would
        // then read null while the row claimed to be a vendor session.
        throw new VendorSessionBindError(`'${sessionClass}' is not a vendor session class`);
      }
      if (!externalActorId) {
        // Not defaulted, not optional. A vendor session with no vendor is the exact state
        // `external_triage_actor` can never admit, and writing one would recreate the bug this closes
        // with a row to point at instead of an absence.
        throw new VendorSessionBindError("an external actor id is required");
      }
      const row = await store.read(scope, sessionId);
      // `read` is org-scoped, so a null here is "absent OR another tenant's" — indistinguishable on
      // purpose, so a caller cannot probe for session ids outside its own organization.
      if (!row) throw new VendorSessionBindError("session not found in this organization");
      await store.write(scope, sessionId, { sessionClass, scopePatch: { externalActorId } });
      return { sessionClass };
    },
  };
}

/** In-memory store (slice/test default). Rows are seeded, then mutated in place. */
export function createInMemoryVendorSessionStore(
  seed: Array<{ sessionId: string } & VendorSessionRow> = [],
): { store: VendorSessionStore; rows: Map<string, VendorSessionRow> } {
  const rows = new Map<string, VendorSessionRow>(
    seed.map(({ sessionId, ...row }) => [sessionId, row]),
  );
  return {
    rows,
    store: {
      async read(scope, sessionId) {
        const row = rows.get(sessionId);
        return row && row.organizationId === scope.orgId ? row : null;
      },
      async write(scope, sessionId, update) {
        const row = rows.get(sessionId);
        if (!row || row.organizationId !== scope.orgId) return;
        rows.set(sessionId, {
          ...row,
          sessionClass: update.sessionClass,
          scope: { ...(row.scope ?? {}), ...update.scopePatch },
        });
      },
    },
  };
}
