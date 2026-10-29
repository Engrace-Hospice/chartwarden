import type { ScreenRegistryModule } from "@chartwarden/types";
// apps/web/src/modules/12-dosespot — M12 screen registration (Track B, ADR-0030, M12-T09).
// The §6.1 DoseSpot prescribing read screens that have a backing M12 read route on the generated client: the
// patient chart Medication list (§6.1), the Medication Detail (§6.1 / the prescribe modal in sign-only mode),
// the prescriber Sign Inbox (§6.1, pending_signature), the Verbal-Orders queue (§6.1, verbal_pending), the
// Refill Inbox (§6.1) + Refill Detail (§6.1), the Medication-history Reconciliation worksheet (§6.1), the
// Prescriber Roster admin (§6.1), and the Prescribing Policy admin (§6.1, refill SLA + controlled-substance).
// Nav visibility is gated by the matching M12 permission key; the SERVER stays the only enforcement point (no
// frontend authz, ADR-0030 — out-of-scope resources 404, never 403).
//
// Prescribing: the prescribe modal takes drug identity from M38's RxNorm search and the concept's own
// published NDCs (never typed) and the ordering physician from the M40 directory lookup
// (`MdmEntityLookupField kind="physician"`); the server also checks the physician is an active directory
// record at draft creation. The §2.2 lifecycle ceremonies (request-signature, sign, cosign, discontinue,
// complete), the §2.3 verbal order and the §2.7 refill approve/deny are built and DOM-covered
// (`medication-writes.dom.test.tsx`); `e2e/specs/prescribing.spec.ts` drives the primary path in a browser
// and depends on the seeded M38 hospice comfort-kit concepts (`scripts/db/seed-terminology.ts`).
//
// STILL DEFERRED, each for a reason rather than a schedule:
//   • The `sign-controlled` EPCS two-step. §2.4/D18 ships Phase 1 `not_certified`, so
//     `requestSignature` refuses a controlled order outright — the ceremony would always fail. The
//     prescribe modal READS that status (`GET /admin/controlled-substance-policy`) rather than assuming
//     it, so an agency that certifies gets the class without a code change.
//   • `correct` — correction mints a replacement order and belongs with a lineage surface.
// `retransmit` is BUILT (GAP-125): GAP-037 landed the DoseSpot v2 adapter and the §4.8 transmission queues
// (`jobs/transmit-newrx.ts` is what marks an order `transmission_failed`), so the Medication Detail offers
// Retransmit on such an order — the route mints a replacement draft (`replacesMedicationOrderId`) the prescriber
// re-signs, gated by `prescribing.sign` + the signer ABAC and the sign standing rule (no step-up).
//   • The med-history reconcile decision, and the roster enrol/revoke + policy edits (admin surfaces).
// The platform-ops EPCS-certification + webhook-explorer screens (apps/admin) are deferred (`dosespot.epcs`
// OFF in Phase 1); the M13 administration (eMAR) screens landed with M13.
import { lazy } from "react";
import type { ComponentType } from "react";
const MedicationDetail = lazy(() =>
  import("./medication-detail").then((m) => ({ default: m.MedicationDetail })),
);
const MedicationOrderEditor = lazy(() =>
  import("./medication-order-editor").then((m) => ({
    default: m.MedicationOrderEditor,
  })),
);
const MedicationReconciliation = lazy(() =>
  import("./medication-reconciliation").then((m) => ({
    default: m.MedicationReconciliation,
  })),
);
const MedicationSignInbox = lazy(() =>
  import("./sign-inbox").then((m) => ({ default: m.MedicationSignInbox })),
);
const PatientMedications = lazy(() =>
  import("./patient-medications").then((m) => ({
    default: m.PatientMedications,
  })),
);
const PrescriberRoster = lazy(() =>
  import("./prescriber-roster").then((m) => ({ default: m.PrescriberRoster })),
);
const PrescribingPolicy = lazy(() =>
  import("./prescribing-policy").then((m) => ({
    default: m.PrescribingPolicy,
  })),
);
const RefillDetail = lazy(() =>
  import("./refill-detail").then((m) => ({ default: m.RefillDetail })),
);
const RefillInbox = lazy(() => import("./refill-inbox").then((m) => ({ default: m.RefillInbox })));
const VerbalMedicationOrdersQueue = lazy(() =>
  import("./verbal-orders-queue").then((m) => ({
    default: m.VerbalMedicationOrdersQueue,
  })),
);

export const dosespotScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 12,
  slug: "12-dosespot",
  screens: [
    {
      // Patient medication list — reached from the patient chart "Medications" tab; param path (no nav).
      id: "prescribing.patient-medications",
      path: "/patients/:patientId/medications",
      title: "Medications",
      requiredPermission: "prescribing.read",
      screen: PatientMedications,
    },
    {
      id: "prescribing.new-medication",
      path: "/patients/:patientId/medications/new",
      title: "New Medication",
      requiredPermission: "prescribing.draft",
      screen: MedicationOrderEditor,
    },
    {
      id: "prescribing.edit-medication-draft",
      path: "/medication-orders/:id/edit",
      title: "Edit Medication Draft",
      requiredPermission: "prescribing.draft",
      screen: MedicationOrderEditor,
    },
    {
      // Medication-order detail — reached from a worklist/list row; param path (no nav).
      id: "prescribing.medication-detail",
      path: "/medication-orders/:id",
      title: "Medication Order",
      requiredPermission: "prescribing.read",
      screen: MedicationDetail,
    },
    {
      // Prescriber sign inbox — global queue of medication orders awaiting signature; top-level nav surface.
      id: "prescribing.sign-inbox",
      path: "/prescribing/sign-inbox",
      title: "Medication Signing",
      navGroup: "Clinical",
      requiredPermission: "prescribing.read",
      screen: MedicationSignInbox,
    },
    {
      // Verbal medication-orders queue — verbal_pending orders awaiting the named prescriber's signature.
      id: "prescribing.verbal-orders",
      path: "/prescribing/verbal-orders",
      title: "Verbal Medications",
      navGroup: "Clinical",
      requiredPermission: "prescribing.read",
      screen: VerbalMedicationOrdersQueue,
    },
    {
      // Refill inbox — pending refills sorted by SLA age (refill_inbox_scope ABAC narrows server-side).
      id: "prescribing.refill-inbox",
      path: "/refills",
      title: "Refills",
      navGroup: "Clinical",
      requiredPermission: "prescribing.read",
      screen: RefillInbox,
    },
    {
      // Refill detail — source order + request fields; param path (no nav).
      id: "prescribing.refill-detail",
      path: "/refills/:id",
      title: "Refill Request",
      requiredPermission: "prescribing.read",
      screen: RefillDetail,
    },
    {
      // Medication-history reconciliation worksheet — reached from the patient chart; param path (no nav).
      id: "prescribing.reconciliation",
      path: "/patients/:patientId/medications/reconciliation",
      title: "Medication Reconciliation",
      requiredPermission: "prescribing.history.read",
      screen: MedicationReconciliation,
    },
    {
      // Prescriber roster admin — per-tenant DoseSpot prescriber list (DEA schedules / IAL2 status).
      id: "prescribing.prescriber-roster",
      path: "/admin/prescribers",
      title: "Prescribers",
      navGroup: "Admin",
      requiredPermission: "prescribing.admin.roster",
      screen: PrescriberRoster,
    },
    {
      // Prescribing policy admin — refill SLA + controlled-substance refill caps + EPCS certification status.
      id: "prescribing.policy",
      path: "/admin/prescribing-policy",
      title: "Prescribing Policy",
      navGroup: "Admin",
      requiredPermission: "prescribing.admin.policy",
      screen: PrescribingPolicy,
    },
  ],
};
