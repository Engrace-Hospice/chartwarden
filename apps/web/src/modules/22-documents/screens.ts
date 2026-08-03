import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/22-documents — M22 Document Management screen registration (Track B, ADR-0030, M22-T10).
// The §5.1 read surfaces that have a backing M22 read route on the generated client: DOC.Explorer (tenant-wide
// document browse + filter), DOC.VersionHistory (the per-document version chain), INTAKE.BatchDetail (the
// DocLens per-batch pipeline view), and FORM.TemplateLibrary (the platform-floor template browse). Every screen
// renders to the "Lantern" design language (docs/design/DESIGN.md) — warm-paper surfaces, the §6.6 status-pill
// taxonomy (color always paired with a glyph), §6.2 Lantern Cards, §3.1 mono identifiers — via the index.css
// `@theme` tokens, not ad-hoc styling. Nav visibility is gated by the matching M22 permission key; the SERVER
// stays the only enforcement point (no frontend authz, ADR-0030 — out-of-scope resources are non-leaking 404s,
// SUD content + legal-hold blocks are server-side, never a frontend hide). The upload dialog / tag editor /
// signed-URL preview / DocLens side-by-side review / overlay editor write+modal surfaces fill in as those write
// paths harden; the portal §5.3 surfaces are M31 Phase-2 forward-seams.
import { lazy } from "react";
import type { ComponentType } from "react";
const DocumentExplorer = lazy(() =>
  import("./document-explorer").then((m) => ({ default: m.DocumentExplorer })),
);
const IntakeBatchDetail = lazy(() =>
  import("./intake-batch-detail").then((m) => ({ default: m.IntakeBatchDetail })),
);
const PatientDocuments = lazy(() =>
  import("./patient-documents").then((m) => ({ default: m.PatientDocuments })),
);
const TemplateLibrary = lazy(() =>
  import("./template-library").then((m) => ({ default: m.TemplateLibrary })),
);
const VersionHistory = lazy(() =>
  import("./version-history").then((m) => ({ default: m.VersionHistory })),
);

export const documentScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 22,
  slug: "22-documents",
  screens: [
    {
      // DOC.Explorer — tenant-wide document browse + filter; the Documents nav landing surface.
      id: "documents.explorer",
      path: "/documents",
      title: "Documents",
      navGroup: "Clinical",
      requiredPermission: "documents.read",
      screen: DocumentExplorer,
    },
    {
      // DOC.PatientDocuments — per-patient document slice; reached from the patient chart "Documents" tab (param path, no nav).
      id: "documents.patient-list",
      path: "/patients/:patientId/documents",
      title: "Documents",
      requiredPermission: "documents.read",
      screen: PatientDocuments,
    },
    {
      // DOC.VersionHistory — per-document version chain; reached from the Explorer row (param path, no nav).
      id: "documents.version-history",
      path: "/documents/:documentId/versions",
      title: "Version History",
      requiredPermission: "documents.read_history",
      screen: VersionHistory,
    },
    {
      // INTAKE.BatchDetail — per-batch DocLens pipeline view; reached from the intake queue (param path, no nav).
      id: "documents.intake-batch",
      path: "/intake/:batchId",
      title: "Intake Batch",
      requiredPermission: "intake.read",
      screen: IntakeBatchDetail,
    },
    {
      // FORM.TemplateLibrary — platform-floor form templates with version metadata (org-scoped admin).
      id: "documents.template-library",
      path: "/admin/forms/templates",
      title: "Form Templates",
      navGroup: "Admin",
      requiredPermission: "documents.read_templates",
      screen: TemplateLibrary,
    },
  ],
};
