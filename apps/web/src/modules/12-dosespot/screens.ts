import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/12-dosespot — M12 screen registration (Track B, ADR-0030, M12-T09).
// The §6.1 DoseSpot prescribing read screens that have a backing M12 read route on the generated client: the
// patient chart Medication list (§6.1), the Medication Detail (§6.1 / the prescribe modal in sign-only mode),
// the prescriber Sign Inbox (§6.1, pending_signature), the Verbal-Orders queue (§6.1, verbal_pending), the
// Refill Inbox (§6.1) + Refill Detail (§6.1), the Medication-history Reconciliation worksheet (§6.1), the
// Prescriber Roster admin (§6.1), and the Prescribing Policy admin (§6.1, refill SLA + controlled-substance).
// Nav visibility is gated by the matching M12 permission key; the SERVER stays the only enforcement point (no
// frontend authz, ADR-0030 — out-of-scope resources 404, never 403).
//
// #91 / F-065 — PRESCRIBING WORKS NOW. The prescribe modal (drug identity from M38's RxNorm search and
// the concept's own published NDCs, never typed), the §2.2 lifecycle ceremonies (request-signature,
// sign, cosign, discontinue, complete), the §2.3 verbal order, and the §2.7 refill approve/deny are all
// built and DOM-covered (`medication-writes.dom.test.tsx`).
//
// Two things had to be true on the server first, and only one of them was:
//   • The lifecycle had to REACH a state the eMAR can administer against. Until #136 `signed` had one
//     exit — through a DoseSpot transmission worker that does not exist — so every signed order was
//     frozen: never completable, never discontinuable, never `active`.
//   • `POST /medication-orders` requires `admissionId`, and NOTHING could resolve one for a patient. The
//     org-wide census takes no patient filter and its items carry no `patientId`; the patient read
//     carries no admission. This change adds `GET /api/v1/patients/:patientId/admissions` (F-065) —
//     the read M07 declined to build a create without, and the one M24's claim wizard works around by
//     asking a clerk to type the uuid.
//
// F-075 (#91 AC5) — `e2e/specs/prescribing.spec.ts` drives the primary path in a real browser: search
// M38 for the drug, resolve its NDC, create the draft, send it for signature, sign it, and assert the
// order reaches the patient's ACTIVE list — the state M13's eMAR administers against. Writing it found
// that "PRESCRIBING WORKS NOW" was not true on any seeded stack, for a reason outside M12: `code_system`,
// `code_system_version` and `concept_rxnorm` were EMPTY, because those tables say "writes only via
// `terminology_loader`" — an external loader that is not in this repository — and no seed wrote a row.
// The drug search returned nothing, so no concept could be selected, so no NDC could be resolved, so the
// modal's submit stayed disabled. `scripts/db/seed-terminology.ts` (new, in `db:seed:all`) seeds the
// hospice comfort-kit concepts, including the morphine RxCUI the scenario seed already hard-codes.
//
// The screen was HONEST about it the whole time ("If this deployment's terminology has not been
// loaded…"), which is exactly why it went unnoticed: the failure read as a deployment fact rather than a
// missing seed. Verified in both directions — the spec fails with the concepts deleted and passes with
// them present.
//
// KNOWN, NOT FIXED HERE: "Ordering physician (MDM id)" is a free-text control asking a prescriber to
// type a UUID — the exact pattern this header rejects two paragraphs up for RxCUI and NDC, and the one
// CLAUDE.md records M24's claim wizard working around by asking a clerk to type it. M40 holds the
// directory read a picker would bind to.
//
// STILL DEFERRED, each for a reason rather than a schedule:
//   • The `sign-controlled` EPCS two-step. §2.4/D18 ships Phase 1 `not_certified`, so
//     `requestSignature` refuses a controlled order outright — the ceremony would always fail. The
//     prescribe modal READS that status (`GET /admin/controlled-substance-policy`) rather than assuming
//     it, so an agency that certifies gets the class without a code change.
//   • `correct` and `retransmit` — correction mints a replacement order and belongs with a lineage
//     surface; retransmission is meaningless without the transmission worker #136 left out of scope.
//   • The med-history reconcile decision, and the roster enrol/revoke + policy edits (admin surfaces).
// The platform-ops EPCS-certification + webhook-explorer screens (apps/admin) are deferred (`dosespot.epcs`
// OFF in Phase 1); the M13 administration (eMAR) screens landed with M13.
import { lazy } from "react";
import type { ComponentType } from "react";
const MedicationDetail = lazy(() =>
  import("./medication-detail").then((m) => ({ default: m.MedicationDetail })),
);
const MedicationReconciliation = lazy(() =>
  import("./medication-reconciliation").then((m) => ({ default: m.MedicationReconciliation })),
);
const MedicationSignInbox = lazy(() =>
  import("./sign-inbox").then((m) => ({ default: m.MedicationSignInbox })),
);
const PatientMedications = lazy(() =>
  import("./patient-medications").then((m) => ({ default: m.PatientMedications })),
);
const PrescriberRoster = lazy(() =>
  import("./prescriber-roster").then((m) => ({ default: m.PrescriberRoster })),
);
const PrescribingPolicy = lazy(() =>
  import("./prescribing-policy").then((m) => ({ default: m.PrescribingPolicy })),
);
const RefillDetail = lazy(() =>
  import("./refill-detail").then((m) => ({ default: m.RefillDetail })),
);
const RefillInbox = lazy(() => import("./refill-inbox").then((m) => ({ default: m.RefillInbox })));
const VerbalMedicationOrdersQueue = lazy(() =>
  import("./verbal-orders-queue").then((m) => ({ default: m.VerbalMedicationOrdersQueue })),
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
