// apps/web/src/modules/22-documents — M22 Document Management screen registration (Track B, ADR-0030, M22-T10).
// The §5.1 read surfaces with a backing M22 read route on the generated client: the tenant-wide Document Explorer
// (`DOC.Explorer`), the per-patient chart documents tab (`DOC.PatientChart.DocumentsTab`), the single Document
// Detail, and the append-only Version History ledger (`DOC.VersionHistory`). Nav visibility is gated by the
// matching M22 permission key; the SERVER stays the only enforcement point (no frontend authz, ADR-0030 — an
// out-of-scope document is simply absent / 404s, never a frontend 403; the §4.7 `document_owner_or_caseload` ABAC
// + RLS narrow every read). The intake/DocLens review surfaces (`INTAKE.*`) are NOT registered in Phase 1 — those
// routes 503 EXTRACTION_DISABLED while `documents.doclens` is OFF (M22-T08); they light up with the M32 wiring.
// The upload / tag-editor / overlay-editor / signed-URL-preview write surfaces and the M31 portal documents view
// fill in as those write / Phase-2 paths land.
import type { ComponentType } from "react";
import type { ScreenRegistryModule } from "@wardenx/types";
import { DocumentDetail } from "./document-detail";
import { DocumentsExplorer, PatientDocuments } from "./explorer";
import { DocumentVersionHistory } from "./version-history";

export const documentScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 22,
  slug: "22-documents",
  screens: [
    {
      // Document Explorer — tenant-wide browse + filter (patient / type / retention), cursor-paginated.
      id: "documents.explorer",
      path: "/documents",
      title: "Documents",
      navGroup: "Documents",
      requiredPermission: "documents.read",
      screen: DocumentsExplorer,
    },
    {
      // Per-patient chart documents tab — the Explorer pre-filtered to one patient; param path (no nav).
      id: "documents.patient-chart",
      path: "/patients/:patientId/documents",
      title: "Patient Documents",
      requiredPermission: "documents.read",
      screen: PatientDocuments,
    },
    {
      // Document Detail — metadata + active version + tags + legal-hold banner; param path (no nav).
      id: "documents.detail",
      path: "/documents/:documentId",
      title: "Document",
      requiredPermission: "documents.read",
      screen: DocumentDetail,
    },
    {
      // Version History — the append-only version ledger; param path (no nav), needs read_history.
      id: "documents.version-history",
      path: "/documents/:documentId/versions",
      title: "Version History",
      requiredPermission: "documents.read_history",
      screen: DocumentVersionHistory,
    },
  ],
};
