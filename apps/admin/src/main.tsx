import { createApiClient } from "@wardenx/ui";
import "@fontsource-variable/manrope";
import "@fontsource-variable/inter";
import "./index.css"; // Tailwind v4 Preflight + the admin app's Lantern token layer (global styles)
// @wardenx/admin — the Platform-Ops console composition ROOT (the WardenX-staff analogue of
// apps/web/src/main.tsx). The one place that instantiates the typed API client, creates the admin screen
// registry, and registers each platform-module slice into it before mounting the shell. Screens are
// registered here, so AdminApp + the shell stay free of per-slice imports (ADR-0030). The ops (M1),
// AI-platform (M32), SaaS-platform (M34), subscription-billing (M35) and Medicare-billing platform-admin (M23)
// slices register below.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AdminApp } from "./app";
import { opsAdminScreens } from "./modules/01-ops";
import { medicareBillingAdminScreens } from "./modules/23-billing-medicare";
import { aiPlatformAdminScreens } from "./modules/32-ai-platform";
import { saasPlatformAdminScreens } from "./modules/34-saas-platform";
import { subscriptionAdminScreens } from "./modules/35-subscription-billing";
import { adminAuthScreens } from "./shell/auth-screens";
import { createAdminRegistry } from "./shell/registry";
import { adminSystemScreens } from "./shell/system-pages";

const registry = createAdminRegistry();
const client = createApiClient();

registry.register(adminSystemScreens); // M1 system/utility pages (403/404/500 — the app's own, not React Router's default)
registry.register(adminAuthScreens); // M1 shell — the console's own login flow (platform_ops accounts only)

// Platform-module admin slices register here as they land.
registry.register(opsAdminScreens); // WX-PR-020 (OPS-004) operator recovery — outbox status
registry.register(saasPlatformAdminScreens); // M34 §5.1 platform-ops control plane (migrated from apps/web)
registry.register(subscriptionAdminScreens); // M35 §5.2 subscription-billing (M35A-T04)
registry.register(aiPlatformAdminScreens); // M32 §5.1 AI Safety Owner console (GAP-049)
registry.register(medicareBillingAdminScreens); // M23 §4.1 #42 platform CMS wage-index load (GAP-144)

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error('Root element "#root" not found');

createRoot(rootEl).render(
  <StrictMode>
    <AdminApp registry={registry} client={client} />
  </StrictMode>,
);
