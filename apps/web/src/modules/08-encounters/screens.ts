import type { ScreenRegistryModule } from "@chartwarden/types";
// apps/web/src/modules/08-encounters — M8 screen registration (Track B, ADR-0030).
// The §5 Encounters screens that have a backing M8 read route on the generated client: the
// patient-scoped Encounter Read (§5.2 — now also hosting the Sign/Acknowledge/Cosign-sign/Supervisor-
// release ceremonies, TASK-031), the Cosignature Queue (§5.5), and the author's My Drafts (§5.1). Nav
// visibility is gated by the matching M8 permission key; the SERVER stays the only enforcement point
// (no frontend authz).
//
// Authoring: `encounter-compose.tsx` is the §2.6 tap-to-document surface (template sections, per-section
// vocabulary, `${slot}` params, verbatim free text, vitals, save with §7.7 `If-Match`, finalize); its menu is
// served by `GET .../template` so the client holds no second copy of the `assembleSelections` rules.
// `new-encounter-modal.tsx` starts an encounter from the patient encounters list. Care-plan links are
// persisted (`POST/GET/DELETE .../care-plan-links`; DELETE is a soft invalidate) and edited from
// `encounter-read.tsx`. Addenda are authored in `addendum-panel.tsx`.
//
// STILL DEFERRED:
//   • Layer-2 (`hearthnote/enhance` + the modification decisions) — the §2.6 D5 AI ladder is its own
//     ceremony with its own governance surface, not part of authoring the deterministic note.
import { lazy } from "react";
import type { ComponentType } from "react";
const CosignatureQueue = lazy(() =>
  import("./cosignature-queue").then((m) => ({ default: m.CosignatureQueue })),
);
const EncounterRead = lazy(() =>
  import("./encounter-read").then((m) => ({ default: m.EncounterRead })),
);
const EncounterCompose = lazy(() =>
  import("./encounter-compose").then((m) => ({ default: m.EncounterCompose })),
);
const MyDrafts = lazy(() => import("./my-drafts").then((m) => ({ default: m.MyDrafts })));
const PatientEncounters = lazy(() =>
  import("./patient-encounters").then((m) => ({ default: m.PatientEncounters })),
);

export const encounterScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 8,
  slug: "08-encounters",
  screens: [
    {
      // Patient encounters list — reached from the patient chart "Encounters / Visits" tab; param path (no nav).
      id: "encounter.patient-list",
      path: "/patients/:patientId/encounters",
      title: "Encounters",
      requiredPermission: "encounter.read",
      screen: PatientEncounters,
    },
    {
      // Patient-scoped Encounter Read — reached from the patient chart / a queue row; param path (no nav).
      id: "encounter.read",
      path: "/patients/:patientId/encounters/:encounterId",
      title: "Encounter",
      requiredPermission: "encounter.read",
      screen: EncounterRead,
    },
    {
      // HearthNote composer — the §2.6 authoring surface for a draft; reached from My Drafts or the
      // patient encounters list. Param path (no nav): a note is always composed in a patient's context.
      id: "encounter.compose",
      path: "/patients/:patientId/encounters/:encounterId/compose",
      title: "Compose note",
      requiredPermission: "encounter.author",
      screen: EncounterCompose,
    },
    {
      // RN / Supervisor cosignature work queue — a top-level work surface.
      id: "encounter.cosignature-queue",
      path: "/work/cosignatures",
      title: "Cosignatures",
      navGroup: "Clinical",
      requiredPermission: "encounter.cosign",
      screen: CosignatureQueue,
    },
    {
      // Author's open drafts — a top-level work surface.
      id: "encounter.my-drafts",
      path: "/work/drafts",
      title: "My Drafts",
      navGroup: "Clinical",
      requiredPermission: "encounter.author",
      screen: MyDrafts,
    },
  ],
};
