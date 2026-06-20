// apps/web/src/main.tsx — the web app COMPOSITION ROOT (outside every module codePath, like
// apps/backend/src/index.ts). It is the one place allowed to import feature module web-slices and
// register their screens; the M1 shell stays pure. F0 registers nothing yet — Track A/B add modules.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createApiClient } from "@wardenx/ui";
import { identityScreens } from "./modules/02-identity";
import { authorizationScreens } from "./modules/03-authorization";
import { auditScreens } from "./modules/04-audit";
import { patientScreens } from "./modules/05-patient";
import { messagingScreens } from "./modules/36-messaging";
import { terminologyScreens } from "./modules/38-terminology";
import { mdmScreens } from "./modules/40-mdm";
import { AppShell, createScreenRegistry, systemScreens } from "./shell";

const registry = createScreenRegistry();
const client = createApiClient();

// Module web-slices register here as they land (Track A/B).
registry.register(systemScreens); // M1 system/utility pages (403/404/500/offline/… — Track A)
registry.register(identityScreens); // M2 Identity (Track A)
registry.register(authorizationScreens); // M3 Authorization (Track A)
registry.register(auditScreens); // M4 Audit (Track A)
registry.register(patientScreens); // M5 Patient (Track A)
registry.register(messagingScreens); // M36 Messaging (Track A)
registry.register(terminologyScreens); // M38 Terminology (Track A)
registry.register(mdmScreens); // M40 MDM (Track A)

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error('Root element "#root" not found');

createRoot(rootEl).render(
  <StrictMode>
    <AppShell registry={registry} client={client} />
  </StrictMode>,
);
