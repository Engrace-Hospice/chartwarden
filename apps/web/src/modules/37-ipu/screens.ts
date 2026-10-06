// apps/web/src/modules/37-ipu — M37 IPU Management screen registration (§5, ADR-0030). The tenant-facing
// IPU screens under an "IPU" navGroup at /ipu/*. Each `requiredPermission` is a REAL §4.6 M37 key the
// matching read route gates on (M37_CONTRIBUTED_PERMISSIONS in @wardenx/auth) — the server stays the
// authoritative enforcer, this only gates nav visibility.
//
// #91 — the bedside pane has landed, which is what this header used to promise ("the deeper bedside /
// restraint / visitor detail panes extend this registry as they land"). It is a param-path detail
// screen reached from an admissions row, so it carries no `navGroup`.
//
// It gates on `m37.ipu_admission.read`, the same key its four sub-resource reads gate on server-side.
// That is deliberate and matches #169: no role template grants a permission key that does not exist, so
// minting `m37.restraint.read` and friends would have hidden this screen from every caller and denied
// its reads to every one of them — the fail-closed invisibility this whole audit is about. Which
// templates get a narrower key is a tenant policy decision, taken deliberately or not at all.
//
// F-080 (#91 AC5) — `e2e/specs/ipu.spec.ts` drives the §2.2 lifecycle in a real browser: request a bed,
// assign a specific one, confirm the admission active. Writing it found TWO defects, either of which
// alone made every one of those transitions impossible on every deployment.
//
//   1. NO RN ASSIGNMENT COULD EVER COVER AN HOUR. §2.3 counts an hour covered only when a `confirmed`
//      RN assignment spans it; `ipu_staff_assignment.state` defaults to `tentative`, `assignStaff` never
//      set it, and no route confirmed one — zero writes of `'confirmed'` in the whole module. So the
//      F-071/#174 watchdog materialized 216 rows per unit all reading `is_covered = false`, and every
//      GIP and inpatient-respite admission stayed refused at open. The watchdog was the missing producer
//      of the WINDOW; its own INPUT had none. `POST /ipu-shifts/:id/staff/confirm` is it.
//   2. EVERY §2.2 TRANSITION AFTER `open` ANSWERED 500. `applyAdmissionTransition` — the shared path for
//      request-bed, assign-bed, confirm, transfer, confirm-transfer and discharge — published
//      `{ ipuAdmissionId, organizationId }` for events whose §4.4 schemas also require `unitId`,
//      `bedId` + `levelOfCarePeriodId`, `activatedAt`, `targetKind`, `completedAt` and `reason`. The
//      transactional publisher validates inside the mutation's own tx, so the emit threw and rolled the
//      write back. `opened` was the one event that worked, and the one that does NOT go through that
//      helper — `openAdmission` builds its payload inline, correctly.
//
// Neither was visible from inside the repo's tests. `m37-ipu-write.live.test.ts` drives all four broken
// transitions and passed, because its outbox port was the default NO-OP — it skipped precisely the
// check that was failing. It validates against the real §4.4 schemas now. `m37-rn-coverage.live.test.ts`
// passed because every coverage test inserted `state='confirmed'` with raw SQL, the one value no product
// path could produce; it also turned out to have been RED since the day it was written (six units on one
// facility id against a UNIQUE(org, facility) index that predates the file), which nothing noticed
// because CI has never executed a live suite.
//
// TWO FINDINGS LEFT AS FINDINGS:
//
//   • THE ADMISSIONS WORKLIST NEVER NAMES THE PATIENT. It renders the admission's raw uuid as the row's
//     identity; the list projection carries no patient reference at all. An inpatient census where a
//     nurse cannot tell who is in which bed is the one thing this screen exists to answer. Fixing it is
//     a producer-side change (a patient projection through the M5 seam, with the masking decision that
//     comes with it), not a frontend one.
//   • `m37.gip_criteria.attester_eligible` NOW GATES the attestation (GAP-106): route 19 composes
//     RBAC + step-up + the registered predicate, and the service re-checks the attester server-side. The
//     CoP 418.108 "hospice MD only" rule is therefore enforced on the backend, not by this surface.
import type { ScreenRegistryModule } from "@wardenx/types";
import { lazy } from "react";
import type { ComponentType } from "react";
const IpuAdmissions = lazy(() =>
  import("./ipu-admissions").then((m) => ({ default: m.IpuAdmissions })),
);
const IpuCensus = lazy(() => import("./ipu-census").then((m) => ({ default: m.IpuCensus })));
const IpuEquipment = lazy(() =>
  import("./ipu-equipment").then((m) => ({ default: m.IpuEquipment })),
);
const IpuUnits = lazy(() => import("./ipu-units").then((m) => ({ default: m.IpuUnits })));
const IpuBedside = lazy(() => import("./ipu-bedside").then((m) => ({ default: m.IpuBedside })));

export const ipuScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 37,
  slug: "37-ipu",
  screens: [
    {
      id: "ipu.units",
      path: "/ipu",
      title: "Inpatient units",
      navGroup: "IPU",
      requiredPermission: "m37.unit.read",
      screen: IpuUnits,
    },
    {
      id: "ipu.admissions",
      path: "/ipu/admissions",
      title: "IPU admissions",
      navGroup: "IPU",
      requiredPermission: "m37.ipu_admission.read",
      screen: IpuAdmissions,
    },
    {
      // Detail screen — reached from an admissions row; omitted from nav (param path).
      id: "ipu.bedside",
      path: "/ipu/admissions/:id",
      title: "Bedside",
      requiredPermission: "m37.ipu_admission.read",
      screen: IpuBedside,
    },
    {
      id: "ipu.census",
      path: "/ipu/census",
      title: "IPU census",
      navGroup: "IPU",
      requiredPermission: "m37.census.read",
      screen: IpuCensus,
    },
    {
      id: "ipu.equipment",
      path: "/ipu/equipment",
      title: "IPU equipment",
      navGroup: "IPU",
      requiredPermission: "m37.equipment.read",
      screen: IpuEquipment,
    },
  ],
};
