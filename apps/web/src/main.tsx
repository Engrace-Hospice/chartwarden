import { createApiClient } from "@wardenx/ui";
// Lantern type trio — SELF-HOSTED (DESIGN.md §3). No third-party CDN: external font requests would
// leak client IPs on a PHI app. Variable faces for the display/UI axes; static weights for the mono
// identifier face (no variable build exists). Family names: "Fraunces Variable" / "Inter Variable" /
// "IBM Plex Mono" — index.css `--font-*` vars resolve to these first, falling back to system faces.
import "@fontsource-variable/fraunces"; // display — titles, names, KPI labels
import "@fontsource-variable/inter"; // UI + data
import "@fontsource/ibm-plex-mono/400.css"; // identifiers (MRN, MBI, claim/control numbers)
import "@fontsource/ibm-plex-mono/500.css";
import "./index.css"; // Tailwind v4 + the WardenX `wx-*` design-system layer (global styles)
// apps/web/src/main.tsx — the web app COMPOSITION ROOT (outside every module codePath, like
// apps/backend/src/index.ts). It is the one place allowed to import feature module web-slices and
// register their screens; the M1 shell stays pure. F0 registers nothing yet — Track A/B add modules.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ScreenLock, identityScreens } from "./modules/02-identity";
import { authorizationScreens } from "./modules/03-authorization";
import { auditScreens } from "./modules/04-audit";
import { patientScreens } from "./modules/05-patient";
import { admissionScreens } from "./modules/06-admission";
import { carePlanScreens } from "./modules/07-care-plan";
import { encounterScreens } from "./modules/08-encounters";
import { assessmentScreens } from "./modules/09-assessments";
import { hopeScreens } from "./modules/10-hope";
import { orderScreens } from "./modules/11-orders";
import { dosespotScreens } from "./modules/12-dosespot";
import { emarScreens } from "./modules/13-emar";
import { idgScreens } from "./modules/14-idg";
import { disciplinePlanScreens } from "./modules/15-discipline-care-plans";
import { bereavementScreens } from "./modules/16-bereavement";
import { schedulingScreens } from "./modules/17-scheduling";
import { evvScreens } from "./modules/18-evv";
import { supplyScreens } from "./modules/21-supplies";
import { documentScreens } from "./modules/22-documents";
import { billingScreens } from "./modules/23-billing-medicare";
import { medicaidBillingScreens } from "./modules/24-billing-medicaid";
import { qualityScreens } from "./modules/30-quality";
import { consentScreens } from "./modules/39-consent";
import { remittanceScreens } from "./modules/25-remittance";
import { capScreens } from "./modules/26-cap";
import { costReportScreens } from "./modules/27-cost-report";
import { reportingScreens } from "./modules/33-reporting";
import { saasScreens } from "./modules/34-saas";
import { messagingScreens } from "./modules/36-messaging";
import { terminologyScreens } from "./modules/38-terminology";
import { mdmScreens } from "./modules/40-mdm";
import { AppShell, createScreenRegistry, systemScreens } from "./shell";
import { initTheme } from "./shell/theme";

// Apply the resolved Lantern theme (stored choice, else OS preference) before the first paint — no flash.
initTheme();

const registry = createScreenRegistry();
const client = createApiClient();

// Module web-slices register here as they land (Track A/B).
registry.register(systemScreens); // M1 system/utility pages (403/404/500/offline/… — Track A)
registry.register(identityScreens); // M2 Identity (Track A)
registry.register(authorizationScreens); // M3 Authorization (Track A)
registry.register(auditScreens); // M4 Audit (Track A)
registry.register(patientScreens); // M5 Patient (Track A)
registry.register(admissionScreens); // M6 Admission/Election/Certification (Track B, M6-T12)
registry.register(carePlanScreens); // M7 Care Plan/IPOC (Track B, M7-T09)
registry.register(encounterScreens); // M8 Encounters & Visit Notes (Track B, M8-T12)
registry.register(assessmentScreens); // M9 Clinical Assessments Suite (Track B, M9-T07)
registry.register(hopeScreens); // M10 HOPE Engine (Track B, M10-T08)
registry.register(orderScreens); // M11 Orders (Track B, M11-T08)
registry.register(dosespotScreens); // M12 DoseSpot Prescribing (Track B, M12-T09)
registry.register(emarScreens); // M13 eMAR Administration (Track B, M13-T10)
registry.register(idgScreens); // M14 Interdisciplinary Group / IDG (Track B, M14-T07)
registry.register(disciplinePlanScreens); // M15 Discipline Care Plans (Track B, M15-T07)
registry.register(bereavementScreens); // M16 Bereavement (Track B, M16-T07)
registry.register(schedulingScreens); // M17 Scheduling & Route Optimization (Track B, M17-T08)
registry.register(evvScreens); // M18 Electronic Visit Verification (Track B, M18-T07)
registry.register(supplyScreens); // M21 Supplies, DME & Comfort Kits (Track B, M21-T06)
registry.register(documentScreens); // M22 Document Management (Track B, M22-T10)
registry.register(billingScreens); // M23 Billing — Medicare (R2, ADR-0030, §10 PR-J)
registry.register(medicaidBillingScreens); // M24 Billing — Medicaid (R2, ADR-0030, §5.1)
registry.register(remittanceScreens); // M25 Remittance & Denials (R2, ADR-0030, §5)
registry.register(capScreens); // M26 Cap Management (R2, ADR-0030, §5)
registry.register(costReportScreens); // M27 Cost Report (R2, ADR-0030, §5)
registry.register(qualityScreens); // M30 HQRP & Quality (R2, ADR-0030, §5.1)
registry.register(reportingScreens); // M33 Reporting & Analytics (R2, ADR-0030)
registry.register(saasScreens); // M34 SaaS Tenant Platform (R2, ADR-0030)
registry.register(messagingScreens); // M36 Messaging (Track A)
registry.register(terminologyScreens); // M38 Terminology (Track A)
registry.register(consentScreens); // M39 Consent & Authorization Management (R2, ADR-0030, §5.1)
registry.register(mdmScreens); // M40 MDM (Track A)

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error('Root element "#root" not found');

createRoot(rootEl).render(
  <StrictMode>
    {/* M2 idle screen-lock overlays the authenticated frame (soft re-auth after 5 min idle). */}
    <AppShell registry={registry} client={client} chromeOverlay={<ScreenLock />} />
  </StrictMode>,
);
