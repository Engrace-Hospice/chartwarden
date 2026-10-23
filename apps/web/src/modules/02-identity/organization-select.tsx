import {
  Button,
  CenteredCardLayout,
  EmptyState,
  LoadingSpinner,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/02-identity — Organization Select (M2 Auth, Track A).
// Spec: docs/design/screens/core/CHARTWARDEN_UI_AUTH.md "Organization select" (/login/organization).
// A multi-org user picks the org that binds the session (one-time). Backed by the real M2 routes
// GET /api/v1/auth/memberships + POST /api/v1/auth/select-organization via the generated client.
// Imports only leaves (@chartwarden/ui) + react-router — never the backend or the shell internals.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { takePendingNotificationLink } from "../../shell/pending-deep-link";
import { authClient } from "./auth-client";
import { BrandLockup } from "./brand-lockup";
import { type TenantInfo, fetchTenantInfo } from "./tenant-info";

// Wire shape mirrored from the M2 route (apps/backend/.../identity-routes.ts toView), re-declared
// here rather than imported — the UI consumes the HTTP response, not the backend package.
type MembershipStatus = "pending" | "active" | "suspended" | "revoked";
interface MembershipView {
  membershipId: string;
  organizationId: string;
  organizationName: string;
  status: MembershipStatus;
  isAdmin: boolean;
  defaultLocationIds: string[];
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string; action?: { href: string; label: string } }
  | { kind: "ready"; memberships: MembershipView[] };

/**
 * The server refuses to bind an org while the role's MFA requirement is unmet (403 MFA_ENROLMENT_REQUIRED). A
 * first org_admin has no passkey yet, and the passkey screen inside the shell sits behind the pre-org guard, so
 * the refusal links to the chromeless `/login/passkey` instead of a dead "contact your administrator".
 */
function selectionFailure(
  error: unknown,
  tenant?: TenantInfo | null,
): Extract<LoadState, { kind: "error" }> {
  const envelope = (error as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  // ADR-0049: a tenant host binds only its own organization. Name it when the public lookup told us.
  if (envelope?.code === "TENANT_HOST_MISMATCH") {
    return {
      kind: "error",
      message: tenant?.displayName
        ? `This address belongs to ${tenant.displayName}, and only its members can work here. Sign out and sign in with an account that is a member, or open your other organization at its own address.`
        : "Only members of the organization at this address can work here. Sign out and sign in with an account that is a member, or open your other organization at its own address.",
    };
  }
  if (envelope?.code === "MFA_ENROLMENT_REQUIRED" && typeof envelope.message === "string") {
    const mustSignInAgain = /sign in again/i.test(envelope.message);
    return {
      kind: "error",
      message: envelope.message,
      action: mustSignInAgain
        ? { href: "/login", label: "Sign in again" }
        : {
            href: `/login/passkey?returnTo=${encodeURIComponent("/login/organization")}`,
            label: "Register a passkey",
          },
    };
  }
  return {
    kind: "error",
    message: "That organization could not be selected. Contact your administrator.",
  };
}

export function OrganizationSelect(): JSX.Element {
  const client = useApiClient();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selecting, setSelecting] = useState<string | null>(null);

  const [tenant, setTenant] = useState<TenantInfo | null>(null);
  // "Try again" re-runs the load below. A page reload is not an option: the picker lives before an organization is bound,
  // and a reload there sent the person to /expired.
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the load on "Try again".
  useEffect(() => {
    let active = true;
    (async () => {
      const credential = await client.GET("/api/v1/auth/credential-status");
      if (!active) return;
      if (credential.data?.passwordChangeRequired) {
        window.location.replace("/login/change-password");
        return;
      }
      if (credential.error || !credential.data) {
        setState({
          kind: "error",
          message: "Could not verify your account security state. Please sign in again.",
        });
        return;
      }
      // The tenant lookup rides alongside the memberships fetch (never a serial round trip); it never rejects.
      const tenantLookup = fetchTenantInfo(client);
      const { data, error } = await client.GET("/api/v1/auth/memberships");
      if (!active) return;
      if (error) {
        setState({
          kind: "error",
          message: "Could not load your organizations. Please sign in again.",
        });
        return;
      }
      const memberships = ((data?.memberships ?? []) as MembershipView[]).filter(
        (m) => m.status === "active",
      );
      const hostTenant = await tenantLookup;
      if (!active) return;
      setTenant(hostTenant);
      // A live tenant host already pins the organization, so a single match is not a choice: bind it without a click.
      const only = memberships.length === 1 ? memberships[0] : undefined;
      if (only && hostTenant?.status === "active") {
        const failure = await bind(only.organizationId); // on success the page reloads; the spinner stays up
        if (!active || failure === null) return;
        // Could not bind: a wrong-organization refusal gets its own explanation, anything else falls back to the
        // picker so the person can retry with a click.
        if (
          (failure as { error?: { code?: unknown } } | null)?.error?.code === "TENANT_HOST_MISMATCH"
        ) {
          setState(selectionFailure(failure, hostTenant));
          return;
        }
      }
      if (!active) return;
      setState({ kind: "ready", memberships });
    })().catch(() => {
      if (active)
        setState({ kind: "error", message: "Something went wrong loading your organizations." });
    });
    return () => {
      active = false;
    };
  }, [client, attempt]);

  function retry(): void {
    setSelecting(null);
    setState({ kind: "loading" });
    setAttempt((n) => n + 1);
  }

  /** POST the binding; `null` on success (the page is reloading), else the refusal (a thrown request is one too). */
  async function bind(organizationId: string): Promise<unknown> {
    setSelecting(organizationId);
    try {
      const { error } = await client.POST("/api/v1/auth/select-organization", {
        body: { organizationId },
      });
      if (error) {
        setSelecting(null);
        return error;
      }
    } catch (thrown) {
      setSelecting(null);
      return thrown ?? new Error("select-organization failed");
    }
    // The session's active org is now bound server-side. Re-bootstrap the app with a full load (not
    // an SPA navigate) so ActorSessionProvider re-fetches /auth/context and the whole shell — nav,
    // Role Home, the pre-org guard — sees the bound org. An SPA navigate would keep the stale
    // pre-org session in memory and the shell guard would bounce straight back here.
    // WP 4.8: finish a notification link opened before sign-in (a rebuilt `/n/<opaque id>`), else the home page.
    window.location.assign(takePendingNotificationLink() ?? "/");
    return null;
  }

  async function select(organizationId: string): Promise<void> {
    const failure = await bind(organizationId);
    if (failure !== null) setState(selectionFailure(failure, tenant));
  }

  async function signOutAndRestart(): Promise<void> {
    try {
      await authClient.signOut();
    } catch {
      // The session may already be unusable; the sign-in page is where this ends either way.
    }
    window.location.assign("/login");
  }

  return (
    <CenteredCardLayout brand={<BrandLockup />}>
      <h1 style={{ marginTop: 0, fontSize: "1.1rem" }}>Select organization</h1>
      {state.kind === "loading" ? <LoadingSpinner /> : null}
      {state.kind === "error" ? (
        <>
          <EmptyState title="Unavailable" description={state.message} />
          {state.action ? <a href={state.action.href}>{state.action.label}</a> : null}
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
            <Button tone="secondary" onClick={retry}>
              Try again
            </Button>
            <Button tone="tertiary" onClick={() => void signOutAndRestart()}>
              Sign out
            </Button>
          </div>
        </>
      ) : null}
      {state.kind === "ready" && state.memberships.length === 0 ? (
        <EmptyState
          title="No active organizations"
          description="Your account has no active membership. Contact your administrator."
        />
      ) : null}
      {state.kind === "ready" && state.memberships.length > 0 ? (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
          }}
        >
          {state.memberships.map((m) => (
            <li key={m.membershipId}>
              <button
                type="button"
                onClick={() => select(m.organizationId)}
                disabled={selecting !== null}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "0.75rem 1rem",
                  border: "1px solid var(--color-outline-variant)",
                  borderRadius: "0.5rem",
                  cursor: "pointer",
                  background: "var(--color-surface-lowest)",
                }}
              >
                <span style={{ fontWeight: 600 }}>{m.organizationName}</span>
                {m.isAdmin ? (
                  <span
                    style={{
                      marginLeft: "0.5rem",
                      fontSize: "0.75rem",
                      color: "var(--color-on-surface-variant)",
                    }}
                  >
                    admin
                  </span>
                ) : null}
                {selecting === m.organizationId ? (
                  <span style={{ marginLeft: "0.5rem", fontSize: "0.75rem" }}>…</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </CenteredCardLayout>
  );
}
