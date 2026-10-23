import { Button, CenteredStatusLayout, Glyph, useCorrelationId } from "@chartwarden/ui";
// @chartwarden/portal — standalone utility pages (#594). Without a `*` route and an `errorElement`, React Router
// renders its developer-facing "Unexpected Application Error" page to a family member. Both pages here are chromeless
// (no patient lookup, no API call) and PHI-free; neither prints the thrown error, whose message is developer text.
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";

// A chromed route: a signed-in family member lands on their patients, a signed-out one is sent to sign-in (#593).
const HOME_PATH = "/patient-picker";

function GoHome(): JSX.Element {
  const navigate = useNavigate();
  return <Button onClick={() => navigate(HOME_PATH)}>Go to your patients</Button>;
}

// The error may come from the page the home button leads to, so the error page also offers a full reload.
function Reload(): JSX.Element {
  return (
    <Button tone="secondary" onClick={() => window.location.reload()}>
      Reload this page
    </Button>
  );
}

export function PortalNotFound(): JSX.Element {
  return (
    <CenteredStatusLayout
      icon={<Glyph name="info" size={24} />}
      headline="We couldn’t find that page"
      explanation="The link may be out of date or mistyped. You can go back to your patients and continue from there."
      actions={<GoHome />}
    />
  );
}

export function PortalRouteError(): JSX.Element {
  const correlationId = useCorrelationId();
  return (
    <CenteredStatusLayout
      icon={<Glyph name="alert" size={24} />}
      headline="Something went wrong"
      explanation="An unexpected error occurred. Please try again, or contact your care team if it keeps happening."
      actions={
        <>
          <Reload />
          <GoHome />
        </>
      }
      correlationId={correlationId ?? undefined}
    />
  );
}
