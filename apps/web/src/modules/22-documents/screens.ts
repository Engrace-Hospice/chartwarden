import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/22-documents — M22 Document Management screen registration (Track B, ADR-0030, M22-T10).
// The §5.1 read surfaces that have a backing M22 read route on the generated client: DOC.Explorer (tenant-wide
// document browse + filter), DOC.VersionHistory (the per-document version chain), INTAKE.BatchDetail (the
// DocLens per-batch pipeline view), and FORM.TemplateLibrary (the platform-floor template browse). Every screen
// renders to the "Lantern" design language (docs/design/DESIGN.md) — warm-paper surfaces, the §6.6 status-pill
// taxonomy (color always paired with a glyph), §6.2 Lantern Cards, §3.1 mono identifiers — via the index.css
// `@theme` tokens, not ad-hoc styling. Nav visibility is gated by the matching M22 permission key; the SERVER
// stays the only enforcement point (no frontend authz, ADR-0030 — out-of-scope resources are non-leaking 404s,
// SUD content + legal-hold blocks are server-side, never a frontend hide). The portal §5.3 surfaces are
// M31 Phase-2 forward-seams.
//
// F-031 (#91) — this header used to end "…fill in as those write paths harden", which made the
// screens.ts corpus the only accurate inventory of what the app could not do. It is accurate the other
// way now.
//
// WHAT IS BUILT: the staff UPLOAD — the control this product did not have ANYWHERE, since the single
// `type="file"` in the whole tree was in the portal, so a family member could attach a document to a
// patient's record and the nurse could not. It drives the checksum-enforced path (browser SHA-256 →
// `POST /document-uploads` → PUT direct to object storage → `POST …/complete`, with an abort on every
// failure between), offered from the Document Explorer, the patient chart's Documents tab, and the
// version chain (as a new version). Plus metadata edit (`PATCH /documents/:id`) and the per-version
// signed-URL open, which asks for its §164.528 access purpose because minting the URL WRITES a
// disclosure-accounting record and defaulting every look to "treatment" would make that log a fiction.
//
// Plus TAG EDITING, on the version-chain aside. This row was not deferred by preference — it was
// UNBUILDABLE (#153): `document_tag` had two writers and NO READER anywhere in the repo, and the id its
// DELETE takes was returned exactly once by a POST whose contract declared no response body, so an
// editor could not have listed what was already on a document and anything added through it would have
// been permanently invisible and undeletable on the next page load. #153 built the reader, published
// the POST's response and wired the cross-document `?tagKey=` query; this is the caller they were
// missing.
//
// Plus the DocLens SIDE-BY-SIDE REVIEW (F-237, §5.1 INTAKE.ReviewSideBySide) and its queue. The review
// workspace puts the source page (with every extracted value's bounding box) next to the extracted
// fields, gates every decision on a per-field "I compared this with the source" confirmation, surfaces
// the stage-5 vision check and the 42 CFR Part 2 SUD detection, and completes with an attestation; the
// result lists what the SERVER wrote to the chart (low-risk contact fields only) and what it kept as
// evidence. INTAKE.ReviewQueue lists the batches with counts only — no values leave the server there.
//
// WHAT IS NOT BUILT, AND WHY:
//   • The FAX SPLITTER, PAGE RECLASSIFICATION and the CHART-DISCREPANCY drawer — the review workspace
//     read carries no discrepancy rows, and reclassification/splitting are batch actions with their own
//     routes and permission family; the workspace labels a low-confidence page "Needs manual label"
//     instead of trusting it silently.
//   • An INTAKE UPLOAD control on the queue (spec empty state "Upload Intake Packet") — intake starts
//     with the referral, so staff file records from the referral page's Records tab
//     (06-admission/referral-records.tsx, F-238), the one staff caller of `POST /intake/uploads`.
//   • The TEMPLATE OVERLAY editor and form-fill retry — admin surfaces on the template library, and a
//     different permission family from the clinical document path this slice covers.
//   • `POST /documents/:id/export-phi-bundle` — the §164.524 right-of-access bulk export. A
//     step-up-gated disclosure action that belongs on a disclosure surface, not on a browse screen.
import { lazy } from "react";
import type { ComponentType } from "react";
const DocumentExplorer = lazy(() =>
  import("./document-explorer").then((m) => ({ default: m.DocumentExplorer })),
);
const IntakeBatchDetail = lazy(() =>
  import("./intake-batch-detail").then((m) => ({ default: m.IntakeBatchDetail })),
);
const IntakeReviewQueue = lazy(() =>
  import("./intake-review-queue").then((m) => ({ default: m.IntakeReviewQueue })),
);
const DocLensReviewWorkspace = lazy(() =>
  import("./doclens-review-workspace").then((m) => ({ default: m.DocLensReviewWorkspace })),
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
      // INTAKE.ReviewQueue — DocLens batches awaiting (or done with) extraction review; counts only.
      id: "intake.review-queue",
      path: "/intake",
      title: "Intake review",
      navGroup: "Admissions",
      requiredPermission: "intake.read",
      screen: IntakeReviewQueue,
    },
    {
      // INTAKE.ReviewSideBySide — source page + bounding boxes beside the extracted fields (param path, no nav).
      id: "intake.review-workspace",
      path: "/intake/:batchId/review",
      title: "Extraction review",
      requiredPermission: "intake.review",
      screen: DocLensReviewWorkspace,
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
