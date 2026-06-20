// apps/web/src/modules/02-identity — Organization Select (M2 Auth, Track A).
// Spec: docs/ui/screens/core/WARDENX_UI_AUTH.md "Organization select" (/login/organization).
// A multi-org user picks the org that binds the session (one-time). Backed by the real M2 routes
// GET /api/v1/auth/memberships + POST /api/v1/auth/select-organization via the generated client.
// Imports only leaves (@wardenx/ui) + react-router — never the backend or the shell internals.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { CenteredCardLayout, EmptyState, LoadingSpinner, useApiClient } from "@wardenx/ui";

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
  | { kind: "error"; message: string }
  | { kind: "ready"; memberships: MembershipView[] };

export function OrganizationSelect(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selecting, setSelecting] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error } = await client.GET("/api/v1/auth/memberships");
      if (!active) return;
      if (error) {
        setState({ kind: "error", message: "Could not load your organizations. Please sign in again." });
        return;
      }
      const memberships = ((data?.memberships ?? []) as MembershipView[]).filter((m) => m.status === "active");
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
      setState({ kind: "error", message: "That organization could not be selected. Contact your administrator." });
      return;
    }
    navigate("/");
  }

  return (
    <CenteredCardLayout brand={<strong>WardenX</strong>}>
      <h1 style={{ marginTop: 0, fontSize: "1.1rem" }}>Select organization</h1>
      {state.kind === "loading" ? <LoadingSpinner /> : null}
      {state.kind === "error" ? <EmptyState title="Unavailable" description={state.message} /> : null}
      {state.kind === "ready" && state.memberships.length === 0 ? (
        <EmptyState title="No active organizations" description="Your account has no active membership. Contact your administrator." />
      ) : null}
      {state.kind === "ready" && state.memberships.length > 0 ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {state.memberships.map((m) => (
            <li key={m.membershipId}>
              <button
                type="button"
                onClick={() => select(m.organizationId)}
                disabled={selecting !== null}
                style={{ width: "100%", textAlign: "left", padding: "0.75rem 1rem", border: "1px solid #e5e7eb", borderRadius: "0.5rem", cursor: "pointer", background: "#fff" }}
              >
                <span style={{ fontWeight: 600 }}>{m.organizationName}</span>
                {m.isAdmin ? <span style={{ marginLeft: "0.5rem", fontSize: "0.75rem", color: "#6b7280" }}>admin</span> : null}
                {selecting === m.organizationId ? <span style={{ marginLeft: "0.5rem", fontSize: "0.75rem" }}>…</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </CenteredCardLayout>
  );
}
