import { Button, CenteredCardLayout, InlineAlert, t, useApiClient } from "@wardenx/ui";
// @wardenx/portal — Redeem a secure link (`/funeral/redeem#token=…`, also `/collaborator/redeem`). A funeral home (or an
// external collaborator) lands here from an emailed single-use link. The token rides in the URL FRAGMENT, so a browser
// never sends it to a server, a proxy or a log; this page reads it client-side, clears it from the address bar at once,
// and POSTs it. The server redeems it ONCE into a scoped session (cookie) — a replayed, expired or revoked link gets one
// calm refusal that does not say which. No PHI is shown before the redemption succeeds, and none on this page after.
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";

type State = "working" | "failed" | "unavailable" | "throttled" | "opened";

/** The token from the link's fragment (`#token=…`), or null. */
export function tokenFromHash(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("token");
  return token && token.length > 0 ? token : null;
}

export function PortalLinkRedeem(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const started = useRef(false);
  const [state, setState] = useState<State>("working");

  // One redemption per mount: the token is single-use, so the effect guards itself with `started`.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = tokenFromHash(window.location.hash);
    // Clear the credential from the address bar / history before anything else can capture it.
    window.history.replaceState(null, "", window.location.pathname);
    if (!token) {
      setState("failed");
      return;
    }
    void (async () => {
      const res = await client.POST("/api/v1/collaborators/consume", { body: { token } });
      if (res.error) {
        const status = res.response?.status;
        setState(status === 429 ? "throttled" : status === 503 ? "unavailable" : "failed");
        return;
      }
      if (res.data?.sessionClass === "funeral_home") navigate("/funeral/case", { replace: true });
      else setState("opened");
    })();
  }, [client, navigate]);

  return (
    <CenteredCardLayout
      brand={
        <div style={{ fontFamily: t.fontDisplay, fontSize: "1.5rem", fontWeight: 600 }}>
          Secure link
        </div>
      }
    >
      {state === "working" ? (
        <output style={{ margin: 0 }}>Opening your secure link…</output>
      ) : state === "opened" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: t.space3 }}>
          <h1 style={{ margin: 0, fontSize: "1.15rem" }}>Your secure session is open</h1>
          <InlineAlert tone="success">
            The care team will tell you how to continue. You can close this page.
          </InlineAlert>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: t.space3 }}>
          <h1 style={{ margin: 0, fontSize: "1.15rem" }}>This link can't be used</h1>
          <InlineAlert tone="error">
            {state === "throttled"
              ? "Too many attempts. Please wait a few minutes and try again."
              : state === "unavailable"
                ? "We can't open secure links right now. Nothing was used up; please try the link again shortly."
                : "It may have expired, been used already, or been replaced. Please ask the care team to send a new link."}
          </InlineAlert>
          <Button tone="secondary" onClick={() => navigate("/")}>
            Go to the family portal
          </Button>
        </div>
      )}
    </CenteredCardLayout>
  );
}
