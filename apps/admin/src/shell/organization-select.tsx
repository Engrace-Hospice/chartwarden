import { CenteredCardLayout, EmptyState, LoadingSpinner, useApiClient } from "@wardenx/ui";
// apps/admin/src/shell — Organization Select (M1/M34, ADR-0030). Ported verbatim from
// apps/web/src/modules/02-identity/organization-select.tsx: a multi-org platform-ops user picks the
// org that binds the session. Backed by the real M2 routes GET /api/v1/auth/memberships +
// POST /api/v1/auth/select-organization via the generated client.
import { useEffect, useState } from "react";
import type { JSX } from "react";

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
  | { kind: "error"; message: string }
  | { kind: "ready"; memberships: MembershipView[] };

export function OrganizationSelect(): JSX.Element {
  const client = useApiClient();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selecting, setSelecting] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
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
      setState({ kind: "ready", memberships });
    })();
    return () => {
      active = false;
    };
  }, [client]);

  async function select(organizationId: string): Promise<void> {
    setSelecting(organizationId);
    const { error } = await client.POST("/api/v1/auth/select-organization", {
      body: { organizationId },
    });
    if (error) {
      setSelecting(null);
      setState({
        kind: "error",
        message: "That organization could not be selected. Contact your administrator.",
      });
      return;
    }
    // The session's active org is now bound server-side. Re-bootstrap the app with a full load (not
    // an SPA navigate) so ActorSessionProvider re-fetches /auth/context and the whole shell — nav,
    // the platform_ops guard — sees the bound org. An SPA navigate would keep the stale pre-org
    // session in memory and the guard would bounce straight back here.
    window.location.assign("/");
  }

  return (
    <CenteredCardLayout brand={<strong>WardenX</strong>}>
      <h1 style={{ marginTop: 0, fontSize: "1.1rem" }}>Select organization</h1>
      {state.kind === "loading" ? <LoadingSpinner /> : null}
      {state.kind === "error" ? (
        <EmptyState title="Unavailable" description={state.message} />
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
