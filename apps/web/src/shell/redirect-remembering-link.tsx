// WP 4.8 (ADR-0075): a redirect away from `/n/<id>` that remembers the opaque id. The write is an effect, not part of render, so
// rendering stays pure (StrictMode / discarded renders write nothing); it still runs in the commit that navigates, before the
// next screen mounts.
import { useEffect } from "react";
import type { JSX } from "react";
import { Navigate } from "react-router-dom";
import { rememberPendingNotificationLink } from "./pending-deep-link";

export function RedirectRememberingLink({
  to,
  pathname,
}: { to: string; pathname: string }): JSX.Element {
  useEffect(() => {
    rememberPendingNotificationLink(pathname);
  }, [pathname]);
  return <Navigate to={to} replace />;
}
