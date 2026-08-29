import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/08-encounters — M8 screen registration (Track B, ADR-0030).
// The §5 Encounters screens that have a backing M8 read route on the generated client: the
// patient-scoped Encounter Read (§5.2 — now also hosting the Sign/Acknowledge/Cosign-sign/Supervisor-
// release ceremonies, TASK-031), the Cosignature Queue (§5.5), and the author's My Drafts (§5.1). Nav
// visibility is gated by the matching M8 permission key; the SERVER stays the only enforcement point
// (no frontend authz).
//
// #91 / F-063 — THE NOTE CAN NOW BE AUTHORED. `encounter-compose.tsx` is the §2.6 tap-to-document
// surface: the template's sections, the vocabulary each accepts, per-entry `${slot}` params, verbatim
// per-section free text, vitals capture, save (§7.7 `If-Match`) and finalize. This header used to say
// the authoring surfaces would "fill in as their write paths harden" — `PATCH .../selections` had been
// mounted since M8-T09 and persisting since #114. What was missing is the MENU: the route carries
// `sectionId`/`code` as free strings and rejects an unknown one, and the template registry + vocabulary
// corpus (`@wardenx/hearthnote`, `@wardenx/narrative-vocab`, both since M8-T05) were on nobody's wire.
// `GET .../template` is that menu, served rather than shipped so the client cannot hold a second,
// divergent copy of the rules `assembleSelections` enforces.
//
// …AND IT CAN NOW BE STARTED (F-083). The paragraph above was written from inside the composer, which is
// where the gap hid: `createDraft` has been exported from `encounters-api.ts` since that change with NO
// CALLER, and no screen offered a control that produced an encounter. Everything downstream of an
// encounter id worked and nothing produced one — every encounter in the product came from a seed script.
// `new-encounter-modal.tsx` is that control, on the patient encounters list.
//
// STILL DEFERRED, each for a reason:
//   • Layer-2 (`hearthnote/enhance` + the modification decisions) — the §2.6 D5 AI ladder is its own
//     ceremony with its own governance surface, not part of authoring the deterministic note.
//   • Care-plan links — `POST .../care-plan-links` parses a body, DISCARDS it, persists nothing and
//     returns the ENCOUNTER's id as `linkId`; `DELETE` is a documented no-op. A control over that would
//     report a link that does not exist (the F-007 rule). Filed separately.
//   • Addenda authoring — the post-signature correction path; the same composer shape against
//     `.../addenda/:id/selections`, once the addendum lifecycle surface exists to reach it from.
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
