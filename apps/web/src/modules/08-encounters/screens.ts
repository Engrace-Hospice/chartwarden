import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/08-encounters — M8 screen registration (Track B, ADR-0030).
// The §5 Encounters screens that have a backing M8 read route on the generated client: the
// patient-scoped Encounter Read (§5.2), the Cosignature Queue (§5.5), and the author's My Drafts
// (§5.1). Nav visibility is gated by the matching M8 permission key; the SERVER stays the only
// enforcement point (no frontend authz). The authoring / finalize-Layer-2 / sign write surfaces
// (§5.2–5.4) fill in as their write paths harden.
import type { ComponentType } from "react";
import { CosignatureQueue } from "./cosignature-queue";
import { EncounterRead } from "./encounter-read";
import { MyDrafts } from "./my-drafts";
import { PatientEncounters } from "./patient-encounters";

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
