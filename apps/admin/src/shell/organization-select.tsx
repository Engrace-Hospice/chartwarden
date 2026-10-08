import {
  Button,
  CenteredCardLayout,
  EmptyState,
  Glyph,
  InlineAlert,
  LoadingSpinner,
  useApiClient,
} from "@wardenx/ui";
// apps/admin/src/shell — Organization Select (M1/M34, ADR-0030). Ported from
// apps/web/src/modules/02-identity/organization-select.tsx: a multi-org platform-ops user picks the
// org that binds the session. Backed by the real M2 routes GET /api/v1/auth/memberships +
// POST /api/v1/auth/select-organization via the generated client. Laid out like the console's sign-in and
// step-up cards (brand lockup above the card); each organization is a row in the shared list-table chrome.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { BrandLockup } from "./brand-lockup";

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
    <CenteredCardLayout
      brand={<BrandLockup />}
      footer={<Link to="/login">Sign in as someone else</Link>}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-lg font-semibold">Select organization</h1>
          <p className="m-0 text-sm text-[var(--color-muted)]">
            Choose the organization this session works in.
          </p>
        </div>
        {state.kind === "loading" ? <LoadingSpinner label="Loading your organizations…" /> : null}
        {state.kind === "error" ? (
          <div className="flex flex-col gap-1" role="alert">
            <strong className="text-sm">Unavailable</strong>
            <InlineAlert tone="error">{state.message}</InlineAlert>
          </div>
        ) : null}
        {state.kind === "ready" && state.memberships.length === 0 ? (
          <EmptyState
            title="No active organizations"
            description="Your account has no active membership. Contact your administrator."
          />
        ) : null}
        {state.kind === "ready" && state.memberships.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Your organizations">
            {state.memberships.map((m) => (
              <li key={m.membershipId}>
                <div className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-card-border)] px-4 py-3">
                  <div className="min-w-0">
                    <span className="wx-row-title">{m.organizationName}</span>
                    {m.isAdmin ? <span className="wx-row-sub">Admin</span> : null}
                  </div>
                  <Button
                    tone="secondary"
                    size="sm"
                    loading={selecting === m.organizationId}
                    disabled={selecting !== null}
                    aria-label={`Select ${m.organizationName}`}
                    onClick={() => void select(m.organizationId)}
                  >
                    Select
                    <Glyph name="chevron-right" size={14} />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </CenteredCardLayout>
  );
}
