import { CenteredCardLayout, t, useApiClient } from "@wardenx/ui";
// @wardenx/portal — Accept invitation (`/accept-invitation?token=…`). The caregiver lands here from the emailed link.
// Accepting is token-authenticated (no session yet): the server activates the portal account and creates the
// per-patient access grant, then the caregiver signs in with the same email address. The page holds no PHI and shows
// only what the server answers (success, or one calm line for an expired / used / revoked link).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";

type State = "working" | "accepted" | "failed";

/** The token from the link's query string (a leading `?` is tolerated). */
export function tokenFromSearch(search: string): string | null {
  const token = new URLSearchParams(search).get("token");
  return token && token.length > 0 ? token : null;
}

export function PortalAcceptInvitation(): JSX.Element {
  const client = useApiClient();
  const token = tokenFromSearch(typeof window === "undefined" ? "" : window.location.search);
  const [state, setState] = useState<State>(token ? "working" : "failed");

  useEffect(() => {
    if (!token) return;
    let active = true;
    void (async () => {
      const res = await client.POST("/api/v1/portal/invitations/accept", { body: { token } });
      if (active) setState(res.error ? "failed" : "accepted");
    })();
    return () => {
      active = false;
    };
  }, [client, token]);

  return (
    <CenteredCardLayout
      brand={
        <div style={{ fontFamily: t.fontDisplay, fontSize: "1.5rem", fontWeight: 600 }}>
          WardenX Family Portal
        </div>
      }
      footer={<Link to="/">Back to sign in</Link>}
    >
      {state === "working" ? (
        <output style={{ margin: 0 }}>Setting up your access…</output>
      ) : state === "accepted" ? (
        // biome-ignore lint/a11y/useSemanticElements: <output> can't hold the h1/p block children this needs
        <div role="status">
          <h1 style={{ margin: "0 0 0.5rem", fontSize: "1.15rem" }}>You're all set</h1>
          <p style={{ margin: 0, color: t.onSurfaceVariant, fontSize: "0.9rem" }}>
            Your access has been created. Sign in with the email address this invitation was sent
            to.
          </p>
        </div>
      ) : (
        <div role="alert">
          <h1 style={{ margin: "0 0 0.5rem", fontSize: "1.15rem" }}>This link can't be used</h1>
          <p style={{ margin: 0, color: t.onSurfaceVariant, fontSize: "0.9rem" }}>
            It may have expired, been used already, or been replaced. Please ask your care team to
            send a new invitation.
          </p>
        </div>
      )}
    </CenteredCardLayout>
  );
}
