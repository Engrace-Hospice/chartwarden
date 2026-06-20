// apps/web/src/main.tsx — the web app COMPOSITION ROOT (outside every module codePath, like
// apps/backend/src/index.ts). It is the one place allowed to import feature module web-slices and
// register their screens; the M1 shell stays pure. F0 registers nothing yet — Track A/B add modules.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createApiClient } from "@wardenx/ui";
import { identityScreens } from "./modules/02-identity";
import { auditScreens } from "./modules/04-audit";
import { patientScreens } from "./modules/05-patient";
import { mdmScreens } from "./modules/40-mdm";
import { AppShell, createScreenRegistry } from "./shell";

const registry = createScreenRegistry();
const client = createApiClient();

// Module web-slices register here as they land (Track A/B).
registry.register(identityScreens); // M2 Identity (Track A)
registry.register(auditScreens); // M4 Audit (Track A)
registry.register(patientScreens); // M5 Patient (Track A)
registry.register(mdmScreens); // M40 MDM (Track A)

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error('Root element "#root" not found');

createRoot(rootEl).render(
  <StrictMode>
    <AppShell registry={registry} client={client} />
  </StrictMode>,
);
