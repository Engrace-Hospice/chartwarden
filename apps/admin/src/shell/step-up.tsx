import { StepUpCard } from "@chartwarden/ui";
// apps/admin/src/shell — the console's step-up re-authentication page (`/step-up`, M2 Auth via the shared kit).
// Platform-ops actions (wage-index load, refunds, plans, promos, dunning overrides, webhook replays…) are
// step-up-gated server-side; a stale session gets 403 STEP_UP_REQUIRED and the screen offers a Re-verify link
// here (the kit's ReverifyLink). The ceremony is the shared StepUpCard — the same one apps/web routes at
// /step-up — which re-verifies the CURRENT session and returns to the (same-origin only) `?returnTo`.
// Chromeless and outside RequireChrome, like /login: it must render for a signed-in actor without the console
// frame, and the server's step-up routes are the authority on whether the session may re-verify.
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { BrandLockup } from "./brand-lockup";

export function AdminStepUp(): JSX.Element {
  return (
    <StepUpCard
      brand={<BrandLockup />}
      footer={<Link to="/login">Sign in as someone else</Link>}
      signInPath="/login"
    />
  );
}
