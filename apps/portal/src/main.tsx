import { createApiClient, initTheme } from "@chartwarden/ui";
import "@fontsource-variable/manrope";
import "@fontsource-variable/inter";
import "./index.css"; // Tailwind v4 Preflight + the portal's Lantern token layer (global styles)
// @chartwarden/portal — the portal composition ROOT (the consumer-facing analogue of apps/web/src/main.tsx). The
// one place that instantiates the typed API client and mounts the portal shell. Screens are registered inside
// PortalApp via the portal registry, so this root stays free of per-screen imports (ADR-0030).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PortalApp } from "./app";
import { createSessionGuard } from "./session-guard";

// Resolve the stored choice (or OS preference) before React paints, matching web/admin.
initTheme();

const sessionGuard = createSessionGuard();
const client = createApiClient({ onResponseStatus: sessionGuard.onResponseStatus });

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error('Root element "#root" not found');

createRoot(rootEl).render(
  <StrictMode>
    <PortalApp client={client} sessionGuard={sessionGuard} />
  </StrictMode>,
);
