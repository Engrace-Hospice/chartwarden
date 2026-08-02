import { createApiClient } from "@wardenx/ui";
import "./index.css"; // Tailwind v4 Preflight + the admin app's Lantern token layer (global styles)
// @wardenx/admin — the Platform-Ops console composition ROOT (the WardenX-staff analogue of
// apps/web/src/main.tsx). The one place that instantiates the typed API client, creates the admin screen
// registry, and registers each platform-module slice into it before mounting the shell. Screens are
// registered here, so AdminApp + the shell stay free of per-slice imports (ADR-0030). Phase 0 registers
// nothing yet — the M35 §5.2 subscription-billing slice registers here when it lands.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AdminApp } from "./app";
import { createAdminRegistry } from "./shell/registry";

const registry = createAdminRegistry();
const client = createApiClient();

// Platform-module admin slices register here as they land (M35 §5.2, …).

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error('Root element "#root" not found');

createRoot(rootEl).render(
  <StrictMode>
    <AdminApp registry={registry} client={client} />
  </StrictMode>,
);
