import { CenteredCardLayout, InlineAlert, useApiClient } from "@wardenx/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  PortalOnboardingBrand,
  PortalOnboardingHeading,
  PortalOnboardingHelp,
} from "./onboarding-ui";

type State = "working" | "accepted" | "failed";

/** Extract only the opaque invitation token; never display it or include it in logs. */
export function tokenFromSearch(search: string): string | null {
  const token = new URLSearchParams(search).get("token");
  return token && token.length > 0 ? token : null;
}

export function PortalAcceptInvitation(): JSX.Element {
  const client = useApiClient();
  const [token] = useState(() =>
    tokenFromSearch(
      typeof window === "undefined" ? "" : window.location.search,
    ),
  );
  const [state, setState] = useState<State>(token ? "working" : "failed");

  useEffect(() => {
    if (!token) return;
    let active = true;
    // Remove the sensitive query from browser history after capturing it. The POST still uses the original token.
    if (
      typeof window !== "undefined" &&
      window.location.search.includes("token=")
    ) {
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname,
      );
    }
    void (async () => {
      try {
        const res = await client.POST("/api/v1/portal/invitations/accept", {
          body: { token },
        });
        if (active) setState("error" in res ? "failed" : "accepted");
      } catch {
        if (active) setState("failed");
      }
    })();
    return () => {
      active = false;
    };
  }, [client, token]);

  return (
    <CenteredCardLayout
      brand={<PortalOnboardingBrand />}
      footer={<PortalOnboardingHelp />}
    >
      <div className="wx-portal-onboarding wx-portal-auth-form">
        {state === "working" ? (
          <div role="status">
            <PortalOnboardingHeading
              eyebrow="Secure invitation"
              title="Setting up your access"
              description="We are checking your invitation and opening the access your hospice team shared."
            />
          </div>
        ) : state === "accepted" ? (
          <div role="status" className="wx-portal-auth-form">
            <PortalOnboardingHeading
              eyebrow="Invitation accepted"
              title="Your access is ready"
              description="Sign in with the email address your hospice team invited to the portal."
            />
            <InlineAlert tone="success">
              Your invitation was accepted.
            </InlineAlert>
            <Link className="wx-portal-auth-primary-link" to="/">
              Continue to sign in →
            </Link>
          </div>
        ) : (
          <div role="alert" className="wx-portal-auth-form">
            <PortalOnboardingHeading
              eyebrow="Invitation unavailable"
              title="This link can't be used"
              description="It may have expired, already been used, or been replaced. Ask your care team for a new invitation."
            />
            <Link className="wx-portal-auth-primary-link" to="/">
              Go to sign in →
            </Link>
          </div>
        )}
      </div>
    </CenteredCardLayout>
  );
}
