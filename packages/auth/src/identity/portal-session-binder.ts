// @chartwarden/auth · identity — the M31 portal session binder (M2-owned; F-030 / #75).
//
// M31 owns the portal ACCOUNT and the access GRANT; M2 owns the `session` row. Before this, nothing
// connected the two: M31's `select-patient` route resolved the grant, computed the binding, returned it
// to the client, and threw it away — its own header said "hand the binding to M2", and there was no M2
// surface to hand it to. So no session ever carried `session_class` in one of the portal classes or a
// `scope.portalAccountId`, every `portal.*` ABAC predicate denied, and the whole M31 surface with them.
//
// Two operations, split because a portal session is minted BEFORE its patient is known:
//   `bindPortalSession` — stamp the class + the account (at login / invitation consumption)
//   `bindPortalPatient` — stamp the ONE patient (`select-patient`, §2.3 / D2)
//
// That split is why `session_scope_chk` requires the ACCOUNT on a portal session and not the patient.
//
// Fail-closed at both: a session that is not in the requested org, or is not a portal session, is
// refused rather than silently rescoped — the store's update is org-scoped and the row's class is
// re-checked, so neither call can convert a staff session into a portal one or move a portal session
// between tenants.
import type { OrgScope, PortalSessionBinder, PortalSessionClass } from "@chartwarden/types";
import { isPortalSessionClass } from "./session-classes";

/** The `session` row fields the binder reads back to verify what it is about to write onto. */
export interface PortalSessionRow {
  readonly organizationId: string | null;
  readonly sessionClass: string;
  readonly scope: { portalAccountId?: string; patientId?: string } | null;
}

/**
 * The M1 `session`-table write surface the binder needs. Production is a Drizzle store inside
 * `withOrgContext`; the slice default is in-memory.
 */
export interface PortalSessionStore {
  /** The row, or null when it does not exist / is not in this org (no cross-tenant read). */
  read(scope: OrgScope, sessionId: string): Promise<PortalSessionRow | null>;
  /** Write the class and merge `patch` into `scope`. Org-scoped; never widens the session's org. */
  write(
    scope: OrgScope,
    sessionId: string,
    update: {
      sessionClass?: PortalSessionClass;
      scopePatch: Record<string, string>;
    },
  ): Promise<void>;
}

/** Raised when a binder call names a session it may not act on. Fail-closed, and deliberately vague. */
export class PortalSessionBindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortalSessionBindError";
  }
}

/** Build the M2 `PortalSessionBinder` seam over a session store. */
export function createPortalSessionBinder(store: PortalSessionStore): PortalSessionBinder {
  /** Read the row and refuse anything not in this org. */
  const readInScope = async (scope: OrgScope, sessionId: string): Promise<PortalSessionRow> => {
    const row = await store.read(scope, sessionId);
    // `read` is org-scoped, so a null here is "absent OR another tenant's" — indistinguishable on
    // purpose, so a caller cannot probe for session ids outside its own organization.
    if (!row) throw new PortalSessionBindError("session not found in this organization");
    return row;
  };

  return {
    async bindPortalSession({ scope, sessionId, portalAccountId, sessionClass }) {
      if (!isPortalSessionClass(sessionClass)) {
        // Unreachable through the typed seam; a defense-in-depth check against a JS caller, because
        // writing an arbitrary string here would put a class on the row that no predicate expects.
        throw new PortalSessionBindError(`'${sessionClass}' is not a portal session class`);
      }
      if (!portalAccountId) throw new PortalSessionBindError("a portal account id is required");
      await readInScope(scope, sessionId);
      await store.write(scope, sessionId, {
        sessionClass,
        scopePatch: { portalAccountId },
      });
      return { sessionClass };
    },

    async bindPortalPatient({ scope, sessionId, patientId }) {
      if (!patientId) throw new PortalSessionBindError("a patient id is required");
      const row = await readInScope(scope, sessionId);
      // Only a session that is ALREADY a portal session may be patient-bound. Without this, a staff
      // session id passed here would gain a `scope.patientId` and — depending on the class — either
      // violate the CHECK or acquire a scope its class does not mean.
      if (!isPortalSessionClass(row.sessionClass)) {
        throw new PortalSessionBindError("not a portal session");
      }
      await store.write(scope, sessionId, { scopePatch: { patientId } });
    },
  };
}

/** In-memory store (slice/test default). Rows are seeded, then mutated in place. */
export function createInMemoryPortalSessionStore(
  seed: Array<{ sessionId: string } & PortalSessionRow> = [],
): { store: PortalSessionStore; rows: Map<string, PortalSessionRow> } {
  const rows = new Map<string, PortalSessionRow>(
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
          sessionClass: update.sessionClass ?? row.sessionClass,
          scope: { ...(row.scope ?? {}), ...update.scopePatch },
        });
      },
    },
  };
}
