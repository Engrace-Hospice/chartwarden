// apps/backend/src/modules/31-portal/sign-in/index.ts — the portal invitee SIGN-IN decision (M31 §2.2.4 / §8.1 / D2–D3).
//
// WHO DOES WHAT. M2 owns AUTHENTICATION (ADR-0026: Better Auth is the single surface — magic link, password +
// TOTP, passkey). Whatever factor the invitee used, the result is a PRE-ORG session: a user, no organization. M31
// owns the ACCOUNT binding: which portal account, in which tenant, as which portal session class. This module is
// the pure half of that bind: given the portal accounts the signed-in user holds, decide whether (and as what) a
// session may be bound. The impure half — the cross-tenant read and the atomic `session` write — is M2's, injected
// as {@link PortalSignInPort} at the composition root (the `PortalInviteeUserPort` precedent: M31 takes no M2 edge).
//
// EVERYTHING FAILS CLOSED. An account must be `active`/`bereaved`, the tenant `active`, the user's email verified
// and not suspended, and at least one grant live. Anything else is a typed refusal that names the REAL reason —
// safe here because the caller has already authenticated and is only being told about their OWN accounts.
import type {
  PortalAccountRelationship,
  PortalAccountStatus,
  PortalSessionClass,
} from "@chartwarden/types";
import { PortalStateError } from "../lifecycle/errors";
import { grantKindForRelationship } from "../lifecycle/invitation";
import { portalSessionClass } from "../lifecycle/portal-access-gate";

/** One portal account of the signed-in user, as M2's definer read returns it (no contact PHI, no patient id). */
export interface PortalSignInAccount {
  readonly portalAccountId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationStatus: string;
  readonly relationship: PortalAccountRelationship;
  readonly accountStatus: PortalAccountStatus;
  readonly userEmailVerified: boolean;
  readonly userStatus: string;
  readonly liveGrantCount: number;
  readonly bereavedGrantCount: number;
}

/** What binding a pre-org session to a portal account needs. */
export interface PortalSessionBind {
  readonly sessionId: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly portalAccountId: string;
  readonly sessionClass: PortalSessionClass;
  readonly ip: string;
  readonly userAgent: string | null;
}

/**
 * The M2-owned half, injected. `accountsForUser` is the pre-org cross-tenant read (a SECURITY DEFINER function — the
 * user id is the authenticated session's, never a request field). `bindSession` is ONE conditional UPDATE on the
 * `session` row (org + class + `scope.portalAccountId` together, so `session_scope_chk` holds) plus the audit row.
 */
export interface PortalSignInPort {
  accountsForUser(userId: string): Promise<readonly PortalSignInAccount[]>;
  /** `bound` — newly bound; `already_bound` — an idempotent replay of the SAME bind; `refused` — not bindable. */
  bindSession(input: PortalSessionBind): Promise<"bound" | "already_bound" | "refused">;
  /** Audit a refusal where the tenant is known (no tenant ⇒ nothing org-scoped to write to). */
  recordRefusal(input: {
    sessionId: string;
    userId: string;
    organizationId: string;
    portalAccountId: string;
    reason: string;
    ip: string;
    userAgent: string | null;
  }): Promise<void>;
}

/** The session class an account signs in as (§8.1): patient-self, delegate, or the bereavement surface. */
export function signInSessionClass(account: PortalSignInAccount): PortalSessionClass {
  const bereaved =
    account.accountStatus === "bereaved" ||
    (account.liveGrantCount > 0 && account.bereavedGrantCount === account.liveGrantCount);
  return portalSessionClass(grantKindForRelationship(account.relationship), bereaved);
}

/** Why one account cannot sign in, or `null` when it can. Ordered most-actionable first. */
export function accountRefusal(account: PortalSignInAccount): PortalStateError | null {
  if (account.userStatus !== "active" && account.userStatus !== "created") {
    return new PortalStateError("SIGN_IN_USER_INACTIVE", "this sign-in is not currently active");
  }
  if (account.organizationStatus !== "active") {
    return new PortalStateError(
      "SIGN_IN_ORGANIZATION_NOT_ACTIVE",
      "this care team's portal is not available right now",
    );
  }
  if (account.accountStatus === "invited") {
    return new PortalStateError(
      "SIGN_IN_ACCOUNT_NOT_ACTIVATED",
      "accept the invitation from your care team first; the link in the invitation email sets up your access",
    );
  }
  if (account.accountStatus !== "active" && account.accountStatus !== "bereaved") {
    return new PortalStateError(
      "SIGN_IN_ACCOUNT_NOT_ACTIVE",
      "this portal account is suspended; please contact your care team",
    );
  }
  if (!account.userEmailVerified) {
    return new PortalStateError(
      "SIGN_IN_EMAIL_UNVERIFIED",
      "verify your email address with the sign-in link before opening the portal",
    );
  }
  if (account.liveGrantCount < 1) {
    return new PortalStateError(
      "SIGN_IN_NO_ACTIVE_GRANT",
      "this account does not have access to anyone's records right now; your care team can help",
    );
  }
  return null;
}

export type SignInDecision =
  | {
      readonly kind: "bind";
      readonly account: PortalSignInAccount;
      readonly sessionClass: PortalSessionClass;
    }
  | { readonly kind: "select"; readonly choices: readonly PortalSignInAccount[] }
  | {
      readonly kind: "refuse";
      readonly error: PortalStateError;
      readonly account: PortalSignInAccount | null;
    };

/**
 * Decide the bind. `requestedAccountId` names a specific account (the multi-tenant / multi-relationship case, §8.1 —
 * one M2 user may hold N accounts); it is matched ONLY against the user's own accounts, so naming someone else's id
 * is indistinguishable from naming none.
 */
export function decideSignIn(
  accounts: readonly PortalSignInAccount[],
  requestedAccountId: string | undefined,
): SignInDecision {
  if (accounts.length === 0) {
    return {
      kind: "refuse",
      account: null,
      error: new PortalStateError(
        "SIGN_IN_NO_PORTAL_ACCOUNT",
        "there is no family portal account for this sign-in; use the link in your invitation",
      ),
    };
  }
  if (requestedAccountId !== undefined) {
    const named = accounts.find((a) => a.portalAccountId === requestedAccountId);
    if (!named) {
      return {
        kind: "refuse",
        account: null,
        error: new PortalStateError(
          "SIGN_IN_NO_PORTAL_ACCOUNT",
          "there is no family portal account for this sign-in; use the link in your invitation",
        ),
      };
    }
    const refusal = accountRefusal(named);
    return refusal
      ? { kind: "refuse", error: refusal, account: named }
      : { kind: "bind", account: named, sessionClass: signInSessionClass(named) };
  }
  const eligible = accounts.filter((a) => accountRefusal(a) === null);
  if (eligible.length === 1) {
    const only = eligible[0] as PortalSignInAccount;
    return { kind: "bind", account: only, sessionClass: signInSessionClass(only) };
  }
  if (eligible.length > 1) return { kind: "select", choices: eligible };
  // None eligible: surface the first account's reason (the user's most relevant account is the first listed).
  const first = accounts[0] as PortalSignInAccount;
  return { kind: "refuse", account: first, error: accountRefusal(first) as PortalStateError };
}
